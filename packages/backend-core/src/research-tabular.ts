import { createHash } from "node:crypto";

/** A deliberately bounded, local CSV analysis path. No row data leaves this module implicitly. */
export const RESEARCH_CSV_MAX_BYTES = 8 * 1024 * 1024;
const MAX_COLUMNS = 100;
const MAX_ROWS = 50_000;
const MAX_CELL_LENGTH = 20_000;
const MAX_GROUPS = 50;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export class ResearchTableError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 422 = 400) {
    super(message);
    this.name = "ResearchTableError";
  }
}

export interface ResearchCsvTable {
  columns: string[];
  rows: string[][];
}

export interface ResearchCsvProfile {
  assetId: string;
  sha256: string;
  rowCount: number;
  columns: Array<{ name: string; nonEmptyCount: number; numericCount: number }>;
}

export interface ResearchCleaningRecipe {
  valueColumn: string;
  groupColumn?: string;
  missingTokens: string[];
  trimWhitespace: boolean;
  invalidNumeric: "error" | "exclude";
}

export interface ResearchCleanedRows {
  rows: Array<{ value: number; group?: string }>;
  counts: {
    rawRows: number;
    includedRows: number;
    missingValueRows: number;
    invalidValueRows: number;
    missingGroupRows: number;
  };
  cleanedSha256: string;
}

export interface ResearchSummary {
  overall: ResearchSummaryStats;
  groups: Array<{ group: string } & ResearchSummaryStats>;
}

export interface ResearchSummaryStats {
  n: number;
  mean: number;
  sampleSd: number | null;
  min: number;
  max: number;
}

/**
 * Strict UTF-8 CSV with RFC-style double-quoted fields. CRLF and LF are row
 * delimiters; quoted newlines remain part of the cell. A final row delimiter
 * does not create a spurious empty record.
 */
export function parseResearchCsv(bytes: Buffer): ResearchCsvTable {
  if (bytes.length === 0) throw new ResearchTableError("CSV file is empty");
  if (bytes.length > RESEARCH_CSV_MAX_BYTES) throw new ResearchTableError("CSV file exceeds the 8 MB limit", 413);

  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ResearchTableError("CSV file must use UTF-8 encoding"); }
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  if (!content) throw new ResearchTableError("CSV file has no header");
  if (content.includes("\0")) throw new ResearchTableError("CSV file contains binary NUL bytes");

  let columns: string[] | undefined;
  const rows: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  let atFieldStart = true;
  let finalDelimiter = false;

  const append = (char: string): void => {
    field += char;
    if (field.length > MAX_CELL_LENGTH) throw new ResearchTableError("CSV cell exceeds 20,000 characters", 413);
  };
  const finishField = (): void => {
    record.push(field);
    if (record.length > MAX_COLUMNS) throw new ResearchTableError("CSV has more than 100 columns", 413);
    field = "";
    afterQuote = false;
    atFieldStart = true;
  };
  const finishRecord = (): void => {
    finishField();
    if (!columns) {
      columns = record.map((name) => name.trim());
      if (columns.some((name) => !name)) throw new ResearchTableError("CSV column names cannot be empty");
      if (columns.some((name) => name.length > 240)) throw new ResearchTableError("CSV column name exceeds 240 characters", 413);
      if (new Set(columns).size !== columns.length) throw new ResearchTableError("CSV column names must be unique");
    } else {
      if (record.length !== columns.length) throw new ResearchTableError("CSV row width does not match the header");
      rows.push(record);
      if (rows.length > MAX_ROWS) throw new ResearchTableError("CSV has more than 50,000 data rows", 413);
    }
    record = [];
  };

  for (let i = 0; i < content.length; i++) {
    const char = content[i]!;
    finalDelimiter = false;
    if (quoted) {
      if (char === '"') {
        if (content[i + 1] === '"') { append('"'); i++; }
        else { quoted = false; afterQuote = true; }
      } else {
        append(char);
      }
      continue;
    }
    if (char === ",") { finishField(); continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r") {
        if (content[i + 1] !== "\n") throw new ResearchTableError("CSV uses an unsupported row delimiter");
        i++;
      }
      finishRecord();
      finalDelimiter = true;
      continue;
    }
    if (afterQuote) throw new ResearchTableError("Unexpected content after a quoted CSV cell");
    if (char === '"') {
      if (!atFieldStart) throw new ResearchTableError("Unexpected quote in an unquoted CSV cell");
      quoted = true;
      atFieldStart = false;
      continue;
    }
    append(char);
    atFieldStart = false;
  }
  if (quoted) throw new ResearchTableError("CSV has an unterminated quoted cell");
  if (!finalDelimiter) finishRecord();
  if (!columns) throw new ResearchTableError("CSV file has no header");
  if (rows.length === 0) throw new ResearchTableError("CSV file has no data rows", 422);
  return { columns, rows };
}

/** Profile only aggregate counts; never include sample cells or row values. */
export function profileResearchCsv(table: ResearchCsvTable, assetId: string, sha256: string): ResearchCsvProfile {
  const columns = table.columns.map((name, index) => {
    let nonEmptyCount = 0;
    let numericCount = 0;
    for (const row of table.rows) {
      const value = row[index]?.trim() ?? "";
      if (value) {
        nonEmptyCount++;
        if (parseFiniteDecimal(value) !== null) numericCount++;
      }
    }
    return { name, nonEmptyCount, numericCount };
  });
  return { assetId, sha256, rowCount: table.rows.length, columns };
}

/**
 * One deterministic cleaning operation. Counts are mutually exclusive and
 * sum to rawRows. A row with multiple faults is attributed in this order:
 * missing value, missing group, invalid numeric value.
 */
export function cleanResearchCsv(table: ResearchCsvTable, recipe: ResearchCleaningRecipe): ResearchCleanedRows {
  const valueIndex = table.columns.indexOf(recipe.valueColumn);
  if (valueIndex < 0) throw new ResearchTableError("Value column was not found");
  const groupIndex = recipe.groupColumn === undefined ? -1 : table.columns.indexOf(recipe.groupColumn);
  if (recipe.groupColumn !== undefined && (groupIndex < 0 || groupIndex === valueIndex)) {
    throw new ResearchTableError("Choose a different existing group column");
  }
  if (!Array.isArray(recipe.missingTokens) || recipe.missingTokens.some((token) => typeof token !== "string")
    || typeof recipe.trimWhitespace !== "boolean" || !["error", "exclude"].includes(recipe.invalidNumeric)) {
    throw new ResearchTableError("Invalid cleaning recipe");
  }
  const normalize = (value: string): string => recipe.trimWhitespace ? value.trim() : value;
  // Apply the recipe's whitespace rule first, then fold case so markers such
  // as NA, na, and Na classify identically on every replay.
  const missing = new Set(recipe.missingTokens.map((token) => normalize(token).toLowerCase()));
  const isMissing = (value: string): boolean => value === "" || missing.has(value.toLowerCase());
  const rows: ResearchCleanedRows["rows"] = [];
  const groups = new Set<string>();
  const counts = {
    rawRows: table.rows.length, includedRows: 0,
    missingValueRows: 0, invalidValueRows: 0, missingGroupRows: 0,
  };

  for (const record of table.rows) {
    const valueText = normalize(record[valueIndex] ?? "");
    if (isMissing(valueText)) { counts.missingValueRows++; continue; }
    let group: string | undefined;
    if (groupIndex >= 0) {
      group = normalize(record[groupIndex] ?? "");
      if (isMissing(group)) { counts.missingGroupRows++; continue; }
      if (group.length > 240) throw new ResearchTableError("Group label exceeds 240 characters", 413);
    }
    const value = parseFiniteDecimal(valueText);
    if (value === null) {
      if (recipe.invalidNumeric === "error") throw new ResearchTableError("Value column contains an invalid numeric value", 422);
      counts.invalidValueRows++;
      continue;
    }
    if (group !== undefined) {
      groups.add(group);
      if (groups.size > MAX_GROUPS) throw new ResearchTableError("Analysis has more than 50 groups", 413);
      rows.push({ value, group });
    } else {
      rows.push({ value });
    }
  }
  if (rows.length === 0) throw new ResearchTableError("Cleaning left no valid data rows", 422);
  counts.includedRows = rows.length;
  const cleanedSha256 = createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
  return { rows, counts, cleanedSha256 };
}

interface Accumulator {
  n: number;
  mean: number;
  m2: number;
  min: number;
  max: number;
}

function addValue(acc: Accumulator, value: number): void {
  const previous = acc.n;
  acc.n++;
  const delta = value - acc.mean;
  acc.mean += delta / acc.n;
  acc.m2 += delta * (value - acc.mean);
  if (previous === 0 || value < acc.min) acc.min = value;
  if (previous === 0 || value > acc.max) acc.max = value;
}

function finishStats(acc: Accumulator): ResearchSummaryStats {
  const sampleSd = acc.n > 1 ? Math.sqrt(Math.max(0, acc.m2 / (acc.n - 1))) : null;
  if (!Number.isFinite(acc.mean) || (sampleSd !== null && !Number.isFinite(sampleSd))) {
    throw new ResearchTableError("Statistic exceeds the supported numeric range", 422);
  }
  return { n: acc.n, mean: acc.mean, sampleSd, min: acc.min, max: acc.max };
}

/** Descriptive statistics only; sample standard deviation is undefined for n=1. */
export function summarizeResearchRows(rows: Array<{ value: number; group?: string }>): ResearchSummary {
  if (rows.length === 0) throw new ResearchTableError("There are no data rows to summarize", 422);
  const overall: Accumulator = { n: 0, mean: 0, m2: 0, min: 0, max: 0 };
  const byGroup = new Map<string, Accumulator>();
  for (const row of rows) {
    if (!Number.isFinite(row.value)) throw new ResearchTableError("Rows contain a non-finite value", 422);
    addValue(overall, row.value);
    if (row.group !== undefined) {
      let acc = byGroup.get(row.group);
      if (!acc) {
        if (byGroup.size >= MAX_GROUPS) throw new ResearchTableError("Analysis has more than 50 groups", 413);
        acc = { n: 0, mean: 0, m2: 0, min: 0, max: 0 };
        byGroup.set(row.group, acc);
      }
      addValue(acc, row.value);
    }
  }
  const groups = [...byGroup.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([group, acc]) => ({ group, ...finishStats(acc) }));
  return { overall: finishStats(overall), groups };
}

function parseFiniteDecimal(value: string): number | null {
  if (!DECIMAL.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
