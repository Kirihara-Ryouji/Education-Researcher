import type {
  ResearchAnalysisRun,
  ResearchAnalysisRunStatus,
  ResearchClaim,
  ResearchEvidence,
  ResearchExecutionLink,
  ResearchExecutionLinkStatus,
  ResearchProject,
  ResearchReportCreate,
  ResearchSource,
  ResearchStudy,
} from "@brainpilot/protocol";

export interface ResearchReportRenderInput {
  study: ResearchStudy;
  project: ResearchProject;
  draft: ResearchReportCreate;
  reportId: string;
  reportVersion: number;
  planVersionId: string;
  createdAt: string;
  createdBy: string;
  executionStatuses: ResearchExecutionLinkStatus[];
  analysisStatuses: ResearchAnalysisRunStatus[];
}

/**
 * Render a frozen research snapshot. The caller resolves and validates all
 * references before calling this pure function; no file or Runtime data is
 * loaded here. Authored prose is retained, apart from local path redaction.
 */
export function renderResearchReportMarkdown(input: ResearchReportRenderInput): string {
  const { study, project, draft } = input;
  const spec = study.specs.find((record) => record.id === study.plans.find((plan) => plan.id === input.planVersionId)?.specVersionId);
  const plan = study.plans.find((record) => record.id === input.planVersionId);
  if (!spec || !plan) throw new Error("Report references a missing study definition or plan");

  const claims = resolveIds(draft.claimIds, study.claims, "claim");
  const analysisIds = uniqueIds([
    ...draft.analysisRunIds,
    ...claims.flatMap((claim) => claim.analysisRunIds),
  ]);
  const analyses = resolveIds(analysisIds, study.analysisRuns, "analysis run");
  const executionIds = uniqueIds(claims.flatMap((claim) => claim.executionLinkIds));
  const executionLinks = resolveIds(executionIds, study.executionLinks, "execution link");
  const evidenceIds = uniqueIds([
    ...plan.evidenceIds,
    ...claims.flatMap((claim) => claim.evidence.map((item) => item.evidenceId)),
  ]);
  const evidence = resolveIds(evidenceIds, study.evidence, "evidence");
  const sourceIds = uniqueIds([
    ...evidence.map((item) => item.sourceId),
    ...analyses.map((run) => run.sourceId),
  ]);
  const sources = resolveIds(sourceIds, study.sources, "source");
  const executionStatusById = new Map(input.executionStatuses.map((status) => [status.linkId, status]));
  const analysisStatusById = new Map(input.analysisStatuses.map((status) => [status.runId, status]));
  const evidenceLabels = labels(evidence, "E");
  const sourceLabels = labels(sources, "S");
  const analysisLabels = labels(analyses, "A");
  const executionLabels = labels(executionLinks, "X");

  const lines: string[] = [
    `# ${inline(draft.title)}`,
    "",
    "## 记录与版本",
    "",
    `- 报告 ID：${inline(input.reportId)}；版本：${input.reportVersion}`,
    `- 项目：${inline(project.title)}（${inline(project.id)}）`,
    `- 研究：${inline(spec.spec.title)}（${inline(study.id)}）`,
    `- 研究定义：v${spec.version}（${inline(spec.id)}）；方案：v${plan.version}（${inline(plan.id)}）`,
    `- 创建时间：${inline(input.createdAt)}；操作者：${inline(input.createdBy)}`,
  ];
  if (draft.reason) lines.push(`- 版本说明：${inline(draft.reason)}`);

  lines.push(
    "",
    "## 研究定义",
    "",
    `- 研究路径：${inline(spec.spec.approach)}；起点：${inline(spec.spec.entry)}`,
    "- 研究问题：",
    "",
    quote(spec.spec.question),
  );
  if (spec.spec.purpose) lines.push("", "- 研究目的：", "", quote(spec.spec.purpose));
  const context = Object.entries(spec.spec.context).filter(([, value]) => value);
  if (context.length) {
    lines.push("", "- 教育情境：");
    for (const [key, value] of context) lines.push(`  - ${inline(contextLabel(key))}：${inline(value)}`);
  }
  if (spec.spec.uncertainties.length) {
    lines.push("", "- 尚未确定：");
    for (const item of spec.spec.uncertainties) lines.push(`  - ${inline(item)}`);
  }

  lines.push("", "## 研究方案", "", body(plan.content));
  if (plan.evidenceIds.length) {
    lines.push("", `方案引用证据：${plan.evidenceIds.map((id) => reference(evidenceLabels, id)).join("、")}`);
  }
  lines.push("", "## 摘要", "", body(draft.summary), "", "## 正文");
  for (const section of draft.sections) {
    lines.push("", `### ${inline(section.heading)}`, "", body(section.content));
  }

  lines.push("", "## 主张及其引用", "");
  if (!claims.length) lines.push("本版本未引用主张。");
  for (const [index, claim] of claims.entries()) {
    lines.push(`### C${index + 1} · ${inline(claim.kind)}`, "", quote(claim.text), "");
    lines.push(`- 主张 ID：${inline(claim.id)}`);
    if (claim.scope) lines.push(`- 适用范围：${inline(claim.scope)}`);
    for (const limitation of claim.limitations) lines.push(`- 主张限制：${inline(limitation)}`);
    if (claim.evidence.length) {
      lines.push("- 证据关系：");
      for (const link of claim.evidence) {
        const reason = link.reason ? `；理由：${inline(link.reason)}` : "";
        lines.push(`  - ${reference(evidenceLabels, link.evidenceId)}：${relationLabel(link.relation)}${reason}`);
      }
    }
    if (claim.analysisRunIds.length) {
      lines.push(`- 描述性分析：${claim.analysisRunIds.map((id) => reference(analysisLabels, id)).join("、")}`);
    }
    if (claim.executionLinkIds.length) {
      lines.push(`- 执行记录：${claim.executionLinkIds.map((id) => reference(executionLabels, id)).join("、")}`);
    }
    lines.push("");
  }

  lines.push("## 引用证据", "");
  if (!evidence.length) lines.push("本版本未引用证据。");
  for (const item of evidence) renderEvidence(lines, item, sourceLabels, evidenceLabels, sources, study);

  lines.push("## 来源与文件版本", "");
  if (!sources.length) lines.push("本版本未引用来源。");
  for (const source of sources) renderSource(lines, source, sourceLabels, evidence, analyses, study);

  lines.push("## 描述性分析", "");
  if (!analyses.length) lines.push("本版本未引用描述性分析。");
  for (const run of analyses) renderAnalysis(lines, run, analysisLabels, sourceLabels, analysisStatusById, study);

  lines.push("## 执行记录", "");
  if (!executionLinks.length) lines.push("本版本未引用执行记录。");
  for (const link of executionLinks) renderExecution(lines, link, executionLabels, executionStatusById);

  lines.push("## 报告局限", "");
  for (const limitation of draft.limitations) lines.push(`- ${inline(limitation)}`);
  if (analyses.length) lines.push("- 所列分析均为描述性统计；本报告未据此自动推断显著性、关联或因果关系。");
  lines.push("", "---", "", "正文、主张与限制由研究者填写；系统按所选版本整理引用及创建时的复核状态。后续版本变化请查看报告引用清单中的当前状态。原始 CSV 数据行未纳入此导出。", "");
  return lines.join("\n");
}

function renderEvidence(
  lines: string[], item: ResearchEvidence, sourceLabels: Map<string, string>, evidenceLabels: Map<string, string>,
  sources: ResearchSource[], study: ResearchStudy,
): void {
  const source = sources.find((record) => record.id === item.sourceId)!;
  const asset = item.assetId ? study.assets.find((record) => record.id === item.assetId) : undefined;
  lines.push(`### ${reference(evidenceLabels, item.id)}`, "");
  lines.push(`- 证据 ID：${inline(item.id)}；来源：${reference(sourceLabels, source.id)}`);
  lines.push(`- 类型：${inline(item.kind)}；采集：${inline(item.captureMethod)}；核验：${inline(item.verification)}`);
  lines.push(`- 定位：${inline(item.locator)}`);
  if (asset) lines.push(`- 文件版本：v${asset.version}（${inline(asset.id)}）；SHA-256：${asset.sha256}`);
  if (source.kind === "dataset" || asset?.mediaType === "text/csv") {
    lines.push("- 数据集证据正文未导出，以免包含原始数据行。");
  } else {
    lines.push("", quote(item.content));
  }
  lines.push("");
}

function renderSource(
  lines: string[], source: ResearchSource, sourceLabels: Map<string, string>,
  evidence: ResearchEvidence[], analyses: ResearchAnalysisRun[], study: ResearchStudy,
): void {
  lines.push(`### ${reference(sourceLabels, source.id)} · ${inline(source.title)}`, "");
  lines.push(`- 来源 ID：${inline(source.id)}；类型：${inline(source.kind)}；来源属性：${inline(source.origin)}`);
  if (source.citation) lines.push(`- 引文信息：${inline(source.citation)}`);
  const assetIds = uniqueIds([
    ...evidence.filter((item) => item.sourceId === source.id).flatMap((item) => item.assetId ? [item.assetId] : []),
    ...analyses.filter((run) => run.sourceId === source.id).map((run) => run.assetId),
  ]);
  for (const assetId of assetIds) {
    const asset = study.assets.find((record) => record.id === assetId);
    if (!asset) continue;
    lines.push(`- 使用文件：v${asset.version}（${inline(asset.id)}），${inline(asset.mediaType)}，SHA-256 ${asset.sha256}`);
  }
  lines.push("");
}

function renderAnalysis(
  lines: string[], run: ResearchAnalysisRun, analysisLabels: Map<string, string>, sourceLabels: Map<string, string>,
  statuses: Map<string, ResearchAnalysisRunStatus>, study: ResearchStudy,
): void {
  const cleaning = study.cleaningRuns.find((record) => record.id === run.cleaningRunId);
  const asset = study.assets.find((record) => record.id === run.assetId);
  const status = statuses.get(run.id);
  lines.push(`### ${reference(analysisLabels, run.id)} · 分析 v${run.version}`, "");
  lines.push(`- 分析 ID：${inline(run.id)}；清洗 ID：${inline(run.cleaningRunId)}；方案 ID：${inline(run.planVersionId)}`);
  lines.push(`- 来源：${reference(sourceLabels, run.sourceId)}；文件版本：${asset ? `v${asset.version}` : "未找到"}（${inline(run.assetId)}）`);
  lines.push(`- 引擎：${inline(run.engineVersion)}；输入 SHA-256：${run.inputSha256}；清洗 SHA-256：${run.cleanedSha256}；结果 SHA-256：${run.resultSha256}`);
  lines.push(`- 创建时复核状态：${statusLabel(status?.status)}${status?.reasons.length ? `（${status.reasons.map(inline).join("、")}）` : ""}`);
  if (cleaning) {
    lines.push(`- 清洗版本：v${cleaning.version}；数值列：${inline(cleaning.recipe.valueColumn)}${cleaning.recipe.groupColumn ? `；分组列：${inline(cleaning.recipe.groupColumn)}` : ""}`);
    lines.push(`- 清洗规则：空值 ${cleaning.recipe.missingTokens.map(inline).join("、")}；去除首尾空白 ${cleaning.recipe.trimWhitespace ? "是" : "否"}；非法数值 ${inline(cleaning.recipe.invalidNumeric)}`);
    const counts = cleaning.counts;
    lines.push(`- 行数：原始 ${counts.rawRows}；纳入 ${counts.includedRows}；缺失数值 ${counts.missingValueRows}；非法数值 ${counts.invalidValueRows}；缺失分组 ${counts.missingGroupRows}`);
  }
  lines.push("- 统计结果（样本标准差仅在 n ≥ 2 时定义）：");
  lines.push(`  - 全部：${stats(run.result.overall)}`);
  for (const group of run.result.groups) lines.push(`  - ${inline(group.group)}：${stats(group)}`);
  lines.push("");
}

function renderExecution(
  lines: string[], link: ResearchExecutionLink, executionLabels: Map<string, string>,
  statuses: Map<string, ResearchExecutionLinkStatus>,
): void {
  const status = statuses.get(link.id);
  lines.push(`### ${reference(executionLabels, link.id)} · ${inline(link.target.kind)}`, "");
  lines.push(`- 关联 ID：${inline(link.id)}；方案 ID：${inline(link.planVersionId)}；会话 ID：${inline(link.sessionId)}`);
  if ("id" in link.target) lines.push(`- Runtime 目标 ID：${inline(link.target.id)}`);
  lines.push(`- 绑定时指纹：${link.snapshot.fingerprint}${link.snapshot.contentHash ? `；内容哈希：${inline(link.snapshot.contentHash)}` : ""}`);
  if (link.snapshot.traceRevision !== undefined) lines.push(`- 绑定时 Trace 修订：${link.snapshot.traceRevision}`);
  lines.push(`- 创建时复核状态：${statusLabel(status?.status)}${status?.reasons.length ? `（${status.reasons.map(inline).join("、")}）` : ""}`);
  if (link.note) lines.push(`- 研究者备注：${inline(link.note)}`);
  lines.push("");
}

function stats(value: ResearchAnalysisRun["result"]["overall"]): string {
  return `n=${value.n}，均值=${value.mean}，样本标准差=${value.sampleSd ?? "未定义"}，最小值=${value.min}，最大值=${value.max}`;
}

function resolveIds<T extends { id: string }>(ids: string[], records: T[], kind: string): T[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  return uniqueIds(ids).map((id) => {
    const record = byId.get(id);
    if (!record) throw new Error(`Report references a missing ${kind}: ${id}`);
    return record;
  });
}

function uniqueIds(ids: string[]): string[] { return [...new Set(ids)]; }
function labels<T extends { id: string }>(records: T[], prefix: string): Map<string, string> {
  return new Map(records.map((record, index) => [record.id, `${prefix}${index + 1}`]));
}
function reference(values: Map<string, string>, id: string): string {
  const label = values.get(id);
  if (!label) throw new Error(`Report reference is not resolved: ${id}`);
  return `[${label}]`;
}
function relationLabel(relation: ResearchClaim["evidence"][number]["relation"]): string {
  return { supports: "支持", challenges: "反驳", limits: "限定" }[relation];
}
function contextLabel(key: string): string {
  return ({ educationLevel: "教育阶段", institution: "机构", courseOrTask: "课程或任务", culturalSetting: "文化情境", timeFrame: "时间范围" } as Record<string, string>)[key] ?? key;
}
function statusLabel(status: "current" | "needs_review" | "unavailable" | undefined): string {
  return ({ current: "当前", needs_review: "需要复核", unavailable: "无法核验" } as const)[status ?? "unavailable"];
}
function quote(value: string): string { return body(value).split("\n").map((line) => `> ${line}`).join("\n"); }
function body(value: string): string {
  return redactLocalPaths(value).replace(/\r\n?/g, "\n")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]#|])/g, "\\$1")
    .replace(/^([ \t]*)([-+]|\d+\.) /gm, "$1\\$2 ");
}
function inline(value: string): string { return body(value).replace(/\s+/g, " "); }
function redactLocalPaths(value: string): string {
  return value
    .replace(/file:\/\/\/?[^\s<>"'`)]+/gi, "[本机路径已隐藏]")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s<>"'`)]+/g, "[本机路径已隐藏]")
    .replace(/(?<![\w:/])\/(?:Users|home|tmp|var|mnt|Volumes|root|opt|private|workspace)(?:\/[^\s<>"'`)]+)*/g, "[本机路径已隐藏]");
}
