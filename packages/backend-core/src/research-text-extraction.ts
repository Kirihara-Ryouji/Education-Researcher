import type { ResearchAsset, ResearchTextSegment, ResearchTextView } from "@brainpilot/protocol";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const MAX_EXTRACT_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;
const MAX_SECTION_CHARS = 200_000;
const MAX_SEGMENTS = 250;
const SEGMENT_CHARS = 2_000;
const PARAGRAPHS_PER_SECTION = 50;
const LINES_PER_SECTION = 100;
const pdfPackageRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

function pdfResources() {
  return {
    useSystemFonts: false,
    standardFontDataUrl: join(pdfPackageRoot, "standard_fonts").replaceAll("\\", "/") + "/",
    cMapUrl: join(pdfPackageRoot, "cmaps").replaceAll("\\", "/") + "/",
    cMapPacked: true,
  };
}

export class ResearchTextError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 422 = 400) {
    super(message);
    this.name = "ResearchTextError";
  }
}

function checkSection(section: number, sectionCount: number): void {
  if (!Number.isSafeInteger(section) || section < 1 || section > sectionCount) {
    throw new ResearchTextError(`Choose a section from 1 to ${sectionCount}`, 400);
  }
}

function segmentsFor(entries: Array<{ locator: string; text: string }>): ResearchTextSegment[] {
  const segments: ResearchTextSegment[] = [];
  let sectionChars = 0;
  for (const entry of entries) {
    const text = entry.text.trim();
    if (!text) continue;
    sectionChars += text.length;
    if (sectionChars > MAX_SECTION_CHARS) throw new ResearchTextError("This section has too much text to preview", 413);
    for (let start = 0, part = 1; start < text.length; start += SEGMENT_CHARS, part++) {
      if (segments.length >= MAX_SEGMENTS) throw new ResearchTextError("This section has too many text passages to preview", 413);
      segments.push({
        index: segments.length,
        locator: text.length > SEGMENT_CHARS ? `${entry.locator}:part${part}` : entry.locator,
        text: text.slice(start, start + SEGMENT_CHARS),
      });
    }
  }
  return segments;
}

/** Offsets refer to UTF-16 positions in the exact extracted segment shown in the UI. */
export function selectResearchQuote(segment: ResearchTextSegment, start?: number, end?: number): { locator: string; content: string } {
  if ((start === undefined) !== (end === undefined)) throw new ResearchTextError("Select both the start and end of a quote");
  let from = start ?? 0;
  let to = end ?? segment.text.length;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to > segment.text.length || from >= to) {
    throw new ResearchTextError("The selected quote is outside this passage");
  }
  while (from < to && /\s/u.test(segment.text[from]!)) from++;
  while (to > from && /\s/u.test(segment.text[to - 1]!)) to--;
  const content = segment.text.slice(from, to);
  if (!content || /^[\uDC00-\uDFFF]/u.test(content) || /[\uD800-\uDBFF]$/u.test(content)) {
    throw new ResearchTextError("Select complete characters from this passage");
  }
  return { locator: `${segment.locator}:u16${from}-${to}`, content };
}

/** Text is extracted only when requested. It is not sent to a model or persisted as a second copy. */
export async function extractResearchText(asset: ResearchAsset, bytes: Buffer, section: number): Promise<ResearchTextView> {
  if (bytes.byteLength > MAX_EXTRACT_BYTES) {
    throw new ResearchTextError("Files over 12 MB can be downloaded but cannot be previewed as text", 413);
  }
  const base = { assetId: asset.id, sha256: asset.sha256, section };
  if (asset.mediaType === "application/pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = getDocument({ data: new Uint8Array(bytes), ...pdfResources() });
    try {
      const document = await loadingTask.promise;
      checkSection(section, document.numPages);
      const page = await document.getPage(section);
      try {
        const content = await page.getTextContent();
        const lines: Array<{ locator: string; text: string }> = [];
        let current = "";
        const finish = () => {
          if (current.trim()) lines.push({ locator: `pdf:p${section}:l${lines.length + 1}`, text: current });
          current = "";
        };
        for (const item of content.items) {
          if (!("str" in item)) continue;
          current += item.str;
          if (item.hasEOL) finish();
        }
        finish();
        return {
          ...base, sectionKind: "page", sectionCount: document.numPages,
          segments: segmentsFor(lines),
          warnings: lines.length ? [] : ["NO_SELECTABLE_TEXT"],
        };
      } finally {
        page.cleanup();
      }
    } catch (error) {
      if (error instanceof ResearchTextError) throw error;
      throw new ResearchTextError("PDF text could not be extracted from this file", 422);
    } finally {
      await loadingTask.destroy();
    }
  }

  if (asset.mediaType.includes("wordprocessingml")) {
    try {
      const mammoth = (await import("mammoth")).default;
      const result = await mammoth.extractRawText({ buffer: bytes });
      if (result.value.length > MAX_TEXT_CHARS) throw new ResearchTextError("This document has too much text to preview", 413);
      const paragraphs = result.value.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
      const sectionCount = Math.max(1, Math.ceil(paragraphs.length / PARAGRAPHS_PER_SECTION));
      checkSection(section, sectionCount);
      const start = (section - 1) * PARAGRAPHS_PER_SECTION;
      return {
        ...base, sectionKind: "paragraphs", sectionCount,
        segments: segmentsFor(paragraphs.slice(start, start + PARAGRAPHS_PER_SECTION)
          .map((text, index) => ({ locator: `docx:p${start + index + 1}`, text }))),
        warnings: result.messages.slice(0, 10).map((message) => message.message.slice(0, 400)),
      };
    } catch (error) {
      if (error instanceof ResearchTextError) throw error;
      throw new ResearchTextError("DOCX text could not be extracted from this file", 422);
    }
  }

  if (asset.mediaType === "text/plain" || asset.mediaType === "text/markdown") {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new ResearchTextError("This text file is not valid UTF-8", 422); }
    if (text.length > MAX_TEXT_CHARS) throw new ResearchTextError("This file has too much text to preview", 413);
    const lines = text.split(/\r\n|\n|\r/);
    const sectionCount = Math.max(1, Math.ceil(lines.length / LINES_PER_SECTION));
    checkSection(section, sectionCount);
    const start = (section - 1) * LINES_PER_SECTION;
    return {
      ...base, sectionKind: "lines", sectionCount,
      segments: segmentsFor(lines.slice(start, start + LINES_PER_SECTION)
        .map((line, index) => ({ locator: `text:l${start + index + 1}`, text: line }))),
      warnings: [],
    };
  }
  throw new ResearchTextError("This file type has no text preview", 422);
}

/** Page count is available even for a scanned PDF with no selectable text. */
export async function countResearchPdfPages(bytes: Buffer): Promise<number> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({ data: new Uint8Array(bytes), ...pdfResources() });
  try {
    return (await loadingTask.promise).numPages;
  } catch {
    throw new ResearchTextError("PDF pages could not be read from this file", 422);
  } finally {
    await loadingTask.destroy();
  }
}
