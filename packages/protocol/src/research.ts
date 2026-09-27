import { z } from "zod";

/** Research records are durable business state, independent of agent runs. */
const Id = z.string().uuid();
const Timestamp = z.string().datetime();
const ShortText = z.string().trim().min(1).max(240);
const LongText = z.string().trim().max(20_000);

export const ResearchEntrySchema = z.enum(["idea", "materials", "manuscript"]);
export const ResearchApproachSchema = z.enum([
  "undecided", "literature", "quantitative", "qualitative", "mixed", "theoretical", "education_ai",
]);
export const ResearchSourceKindSchema = z.enum([
  "publication", "dataset", "interview", "observation", "survey", "document", "other",
]);
export const ResearchSourceOriginSchema = z.enum(["observed", "curated", "simulated", "generated"]);
export const ResearchEvidenceKindSchema = z.enum(["source_excerpt", "manual_transcription", "researcher_note", "model_summary"]);
export const ResearchClaimKindSchema = z.enum(["description", "association", "causal", "interpretation", "theoretical"]);

export const ResearchProjectCreateSchema = z.object({
  title: ShortText,
  description: LongText.default(""),
}).strict();
export const ResearchProjectSchema = ResearchProjectCreateSchema.extend({
  id: Id,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const StudySpecInputSchema = z.object({
  title: ShortText,
  question: LongText.refine((s) => s.length > 0, "Research question is required"),
  purpose: LongText.default(""),
  entry: ResearchEntrySchema,
  approach: ResearchApproachSchema.default("undecided"),
  context: z.object({
    educationLevel: z.string().trim().max(240).default(""),
    institution: z.string().trim().max(240).default(""),
    courseOrTask: z.string().trim().max(240).default(""),
    culturalSetting: z.string().trim().max(240).default(""),
    timeFrame: z.string().trim().max(240).default(""),
  }).strict().default({}),
  uncertainties: z.array(ShortText).max(50).default([]),
}).strict();
export const StudySpecVersionSchema = z.object({
  id: Id,
  version: z.number().int().positive(),
  spec: StudySpecInputSchema,
  reason: z.string().trim().max(2000),
  createdBy: ShortText,
  createdAt: Timestamp,
});

export const ResearchSourceCreateSchema = z.object({
  title: ShortText,
  kind: ResearchSourceKindSchema,
  origin: ResearchSourceOriginSchema,
  citation: z.string().trim().max(2000).default(""),
  locator: z.string().trim().max(2000).default(""),
  accessNote: z.string().trim().max(2000).default(""),
}).strict();
export const ResearchSourceSchema = ResearchSourceCreateSchema.extend({ id: Id, createdAt: Timestamp });

/** One immutable local file version attached to a registered source. */
export const ResearchAssetSchema = z.object({
  id: Id,
  sourceId: Id,
  version: z.number().int().positive(),
  filename: ShortText,
  mediaType: ShortText,
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  accessNote: z.string().trim().min(1).max(2000),
  createdAt: Timestamp,
}).strict();

/** A read-only, on-demand view of text from one immutable file version. */
export const ResearchTextSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  locator: ShortText,
  text: z.string().min(1).max(2000),
}).strict();
export const ResearchTextViewSchema = z.object({
  assetId: Id,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sectionKind: z.enum(["page", "paragraphs", "lines"]),
  section: z.number().int().positive(),
  sectionCount: z.number().int().positive(),
  segments: z.array(ResearchTextSegmentSchema),
  warnings: z.array(z.string()),
}).strict();

export const ResearchEvidenceCreateSchema = z.object({
  sourceId: Id,
  assetId: Id.optional(),
  kind: ResearchEvidenceKindSchema,
  locator: ShortText,
  content: LongText.refine((s) => s.length > 0, "Evidence content is required"),
  note: LongText.default(""),
}).strict();
export const ResearchManualPageCreateSchema = z.object({
  assetId: Id,
  page: z.number().int().positive(),
  content: LongText.refine((s) => s.length > 0, "Manual transcription is required"),
  note: ShortText,
}).strict();
export const ResearchEvidenceSchema = ResearchEvidenceCreateSchema.extend({
  id: Id,
  captureMethod: z.enum(["manual", "extracted", "transcribed"]).default("manual"),
  verification: z.enum(["unverified", "source_checked", "content_checked"]),
  createdAt: Timestamp,
});
export const ResearchEvidenceVerificationCreateSchema = z.object({
  evidenceId: Id,
  level: z.enum(["source_checked", "content_checked"]),
  reason: ShortText,
}).strict();
export const ResearchEvidenceVerificationSchema = ResearchEvidenceVerificationCreateSchema.extend({
  id: Id,
  actorId: ShortText,
  createdAt: Timestamp,
});

export const ResearchPlanCreateSchema = z.object({
  content: LongText.refine((s) => s.length > 0, "Plan content is required"),
  reason: z.string().trim().max(2000).default(""),
  evidenceIds: z.array(Id).max(200).default([]),
}).strict();
export const ResearchPlanVersionSchema = ResearchPlanCreateSchema.extend({
  id: Id,
  version: z.number().int().positive(),
  specVersionId: Id,
  createdBy: ShortText,
  createdAt: Timestamp,
});

/** A research-side pointer to an existing Runtime object, fixed to a plan version. */
export const ResearchExecutionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session") }).strict(),
  z.object({ kind: z.literal("task"), id: ShortText }).strict(),
  z.object({ kind: z.literal("trace_node"), id: ShortText }).strict(),
  z.object({ kind: z.literal("trace_artifact"), id: ShortText }).strict(),
]);
export const ResearchExecutionLinkCreateSchema = z.object({
  planVersionId: Id,
  sessionId: Id,
  target: ResearchExecutionTargetSchema,
  note: z.string().trim().max(2000).default(""),
}).strict();
export const ResearchExecutionSnapshotSchema = z.object({
  sessionTitle: z.string().max(2000),
  targetLabel: z.string().max(2000),
  traceRevision: z.number().int().nonnegative().optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().min(1).max(2000).optional(),
}).strict();
export const ResearchExecutionLinkSchema = ResearchExecutionLinkCreateSchema.extend({
  id: Id,
  snapshot: ResearchExecutionSnapshotSchema,
  createdAt: Timestamp,
});
export const ResearchExecutionReviewReasonSchema = z.enum([
  "study_definition_changed", "plan_changed", "source_version_changed",
  "runtime_target_changed", "runtime_trace_changed", "runtime_target_missing", "runtime_unavailable",
]);
export const ResearchExecutionLinkStatusSchema = z.object({
  linkId: Id,
  status: z.enum(["current", "needs_review", "unavailable"]),
  reasons: z.array(ResearchExecutionReviewReasonSchema),
}).strict();

/** First reproducible tabular path: immutable CSV -> cleaning -> descriptive summary. */
export const ResearchTableProfileSchema = z.object({
  assetId: Id,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  rowCount: z.number().int().nonnegative(),
  columns: z.array(z.object({
    name: ShortText,
    nonEmptyCount: z.number().int().nonnegative(),
    numericCount: z.number().int().nonnegative(),
  }).strict()).max(100),
}).strict();
export const ResearchCleaningRecipeSchema = z.object({
  valueColumn: ShortText,
  groupColumn: ShortText.optional(),
  missingTokens: z.array(z.string().max(80)).max(20).default(["", "NA", "N/A"]),
  trimWhitespace: z.boolean().default(true),
  invalidNumeric: z.enum(["error", "exclude"]).default("error"),
}).strict();
export const ResearchCleaningCountsSchema = z.object({
  rawRows: z.number().int().nonnegative(),
  includedRows: z.number().int().positive(),
  missingValueRows: z.number().int().nonnegative(),
  invalidValueRows: z.number().int().nonnegative(),
  missingGroupRows: z.number().int().nonnegative(),
}).strict();
export const ResearchCleaningRunCreateSchema = z.object({
  planVersionId: Id,
  assetId: Id,
  recipe: ResearchCleaningRecipeSchema,
  reason: z.string().trim().max(2000).default(""),
}).strict();
export const ResearchCleaningRunSchema = ResearchCleaningRunCreateSchema.extend({
  id: Id,
  version: z.number().int().positive(),
  sourceId: Id,
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cleanedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  counts: ResearchCleaningCountsSchema,
  engineVersion: z.literal("csv-clean-v1"),
  createdBy: ShortText,
  createdAt: Timestamp,
});
export const ResearchSummaryStatsSchema = z.object({
  n: z.number().int().positive(),
  mean: z.number().finite(),
  sampleSd: z.number().finite().nonnegative().nullable(),
  min: z.number().finite(),
  max: z.number().finite(),
}).strict();
export const ResearchAnalysisSummarySchema = z.object({
  overall: ResearchSummaryStatsSchema,
  groups: z.array(ResearchSummaryStatsSchema.extend({ group: z.string().min(1).max(240) })).max(50),
}).strict();
export const ResearchAnalysisRunCreateSchema = z.object({ cleaningRunId: Id }).strict();
export const ResearchAnalysisRunSchema = ResearchAnalysisRunCreateSchema.extend({
  id: Id,
  version: z.number().int().positive(),
  planVersionId: Id,
  sourceId: Id,
  assetId: Id,
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cleanedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  result: ResearchAnalysisSummarySchema,
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  engineVersion: z.literal("csv-descriptive-v1"),
  createdBy: ShortText,
  createdAt: Timestamp,
});
export const ResearchAnalysisReviewReasonSchema = z.enum([
  "study_definition_changed", "plan_changed", "source_version_changed", "cleaning_version_changed",
  "raw_file_unavailable", "recompute_failed", "result_changed",
]);
export const ResearchAnalysisRunStatusSchema = z.object({
  runId: Id,
  status: z.enum(["current", "needs_review", "unavailable"]),
  reasons: z.array(ResearchAnalysisReviewReasonSchema),
}).strict();

export const ResearchClaimCreateSchema = z.object({
  text: LongText.refine((s) => s.length > 0, "Claim text is required"),
  kind: ResearchClaimKindSchema,
  scope: z.string().trim().max(2000).default(""),
  limitations: z.array(ShortText).max(50).default([]),
  evidence: z.array(z.object({
    evidenceId: Id,
    relation: z.enum(["supports", "challenges", "limits"]),
    reason: z.string().trim().max(2000).default(""),
  }).strict()).max(200).default([]),
  executionLinkIds: z.array(Id).max(200).default([]),
  analysisRunIds: z.array(Id).max(200).default([]),
}).strict();
export const ResearchClaimSchema = ResearchClaimCreateSchema.extend({ id: Id, createdAt: Timestamp });

/** A researcher-authored manuscript snapshot with explicit upstream references. */
export const ResearchReportCreateSchema = z.object({
  title: ShortText,
  summary: LongText.refine((text) => text.length > 0, "Report summary is required"),
  sections: z.array(z.object({
    heading: ShortText,
    content: LongText.refine((text) => text.length > 0, "Section content is required"),
  }).strict()).min(1).max(12),
  limitations: z.array(ShortText).min(1).max(50),
  claimIds: z.array(Id).min(1).max(50),
  analysisRunIds: z.array(Id).max(50).default([]),
  reason: z.string().trim().max(2000).default(""),
}).strict();
export const ResearchReportVersionSchema = ResearchReportCreateSchema.extend({
  id: Id,
  version: z.number().int().positive(),
  planVersionId: Id,
  markdown: z.string().min(1).max(2_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: ShortText,
  createdAt: Timestamp,
});
export const ResearchReportReviewReasonSchema = z.enum([
  "study_definition_changed", "plan_changed", "plan_not_accepted", "claim_not_accepted", "claim_missing",
  "evidence_changed", "analysis_needs_review", "analysis_unavailable", "execution_needs_review",
  "execution_unavailable", "report_content_changed",
]);
export const ResearchReportStatusSchema = z.object({
  reportId: Id,
  status: z.enum(["current", "needs_review", "unavailable"]),
  reasons: z.array(ResearchReportReviewReasonSchema),
}).strict();

export const ResearchDecisionCreateSchema = z.object({
  target: z.enum(["plan", "claim", "report"]),
  targetId: Id,
  decision: z.enum(["accept", "return"]),
  reason: ShortText,
}).strict();
export const ResearchDecisionSchema = ResearchDecisionCreateSchema.extend({
  id: Id,
  actorId: ShortText,
  createdAt: Timestamp,
});

export const ResearchStudySchema = z.object({
  id: Id,
  projectId: Id,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  specs: z.array(StudySpecVersionSchema).min(1),
  plans: z.array(ResearchPlanVersionSchema),
  sources: z.array(ResearchSourceSchema),
  assets: z.array(ResearchAssetSchema).default([]),
  evidence: z.array(ResearchEvidenceSchema),
  verifications: z.array(ResearchEvidenceVerificationSchema).default([]),
  claims: z.array(ResearchClaimSchema),
  decisions: z.array(ResearchDecisionSchema),
  executionLinks: z.array(ResearchExecutionLinkSchema).default([]),
  cleaningRuns: z.array(ResearchCleaningRunSchema).default([]),
  analysisRuns: z.array(ResearchAnalysisRunSchema).default([]),
  reports: z.array(ResearchReportVersionSchema).default([]),
});

export type ResearchProject = z.infer<typeof ResearchProjectSchema>;
export type ResearchStudy = z.infer<typeof ResearchStudySchema>;
export type StudySpecInput = z.infer<typeof StudySpecInputSchema>;
export type ResearchSource = z.infer<typeof ResearchSourceSchema>;
export type ResearchAsset = z.infer<typeof ResearchAssetSchema>;
export type ResearchTextSegment = z.infer<typeof ResearchTextSegmentSchema>;
export type ResearchTextView = z.infer<typeof ResearchTextViewSchema>;
export type ResearchEvidence = z.infer<typeof ResearchEvidenceSchema>;
export type ResearchEvidenceVerification = z.infer<typeof ResearchEvidenceVerificationSchema>;
export type ResearchPlanVersion = z.infer<typeof ResearchPlanVersionSchema>;
export type ResearchExecutionTarget = z.infer<typeof ResearchExecutionTargetSchema>;
export type ResearchExecutionSnapshot = z.infer<typeof ResearchExecutionSnapshotSchema>;
export type ResearchExecutionLink = z.infer<typeof ResearchExecutionLinkSchema>;
export type ResearchExecutionLinkStatus = z.infer<typeof ResearchExecutionLinkStatusSchema>;
export type ResearchExecutionReviewReason = z.infer<typeof ResearchExecutionReviewReasonSchema>;
export type ResearchTableProfile = z.infer<typeof ResearchTableProfileSchema>;
export type ResearchCleaningRecipe = z.infer<typeof ResearchCleaningRecipeSchema>;
export type ResearchCleaningCounts = z.infer<typeof ResearchCleaningCountsSchema>;
export type ResearchCleaningRun = z.infer<typeof ResearchCleaningRunSchema>;
export type ResearchAnalysisSummary = z.infer<typeof ResearchAnalysisSummarySchema>;
export type ResearchAnalysisRun = z.infer<typeof ResearchAnalysisRunSchema>;
export type ResearchAnalysisRunStatus = z.infer<typeof ResearchAnalysisRunStatusSchema>;
export type ResearchAnalysisReviewReason = z.infer<typeof ResearchAnalysisReviewReasonSchema>;
export type ResearchClaim = z.infer<typeof ResearchClaimSchema>;
export type ResearchReportCreate = z.infer<typeof ResearchReportCreateSchema>;
export type ResearchReportVersion = z.infer<typeof ResearchReportVersionSchema>;
export type ResearchReportStatus = z.infer<typeof ResearchReportStatusSchema>;
export type ResearchReportReviewReason = z.infer<typeof ResearchReportReviewReasonSchema>;
export type ResearchDecision = z.infer<typeof ResearchDecisionSchema>;

/** A newer file version does not erase old evidence; it makes review visible. */
export function staleEvidenceIds(study: ResearchStudy): Set<string> {
  const latestBySource = new Map<string, ResearchAsset>();
  for (const asset of study.assets) {
    const current = latestBySource.get(asset.sourceId);
    if (!current || asset.version > current.version) latestBySource.set(asset.sourceId, asset);
  }
  return new Set(study.evidence.filter((evidence) =>
    evidence.assetId && latestBySource.get(evidence.sourceId)?.id !== evidence.assetId,
  ).map((evidence) => evidence.id));
}

/** Local invalidation is derived from immutable plan/spec/evidence versions. */
export function executionLinkReviewReasons(study: ResearchStudy, link: ResearchExecutionLink): ResearchExecutionReviewReason[] {
  const plan = study.plans.find((record) => record.id === link.planVersionId);
  if (!plan) return ["plan_changed"];
  const reasons: ResearchExecutionReviewReason[] = [];
  if (plan.specVersionId !== study.specs.at(-1)?.id) reasons.push("study_definition_changed");
  if (study.plans.at(-1)?.id !== plan.id) reasons.push("plan_changed");
  const stale = staleEvidenceIds(study);
  if (plan.evidenceIds.some((id) => stale.has(id))) reasons.push("source_version_changed");
  return reasons;
}

/** Cleaning versions are independent for each plan and immutable CSV asset. */
export function latestCleaningRunForAsset(study: ResearchStudy, planVersionId: string, assetId: string): ResearchCleaningRun | undefined {
  return study.cleaningRuns.findLast((record) => record.planVersionId === planVersionId && record.assetId === assetId);
}

/** Pure version checks; the backend additionally recomputes the stored result. */
export function analysisRunReviewReasons(study: ResearchStudy, run: ResearchAnalysisRun): ResearchAnalysisReviewReason[] {
  const cleaning = study.cleaningRuns.find((record) => record.id === run.cleaningRunId);
  const plan = study.plans.find((record) => record.id === run.planVersionId);
  const reasons: ResearchAnalysisReviewReason[] = [];
  if (!plan || plan.specVersionId !== study.specs.at(-1)?.id) reasons.push("study_definition_changed");
  if (study.plans.at(-1)?.id !== run.planVersionId) reasons.push("plan_changed");
  if (!cleaning || latestCleaningRunForAsset(study, run.planVersionId, run.assetId)?.id !== cleaning.id) {
    reasons.push("cleaning_version_changed");
  }
  const asset = study.assets.find((record) => record.id === run.assetId);
  const latest = study.assets.filter((record) => record.sourceId === run.sourceId && record.mediaType === "text/csv").at(-1);
  if (!asset || latest?.id !== asset.id || asset.sha256 !== run.inputSha256) reasons.push("source_version_changed");
  if (plan?.evidenceIds.some((id) => staleEvidenceIds(study).has(id))) {
    if (!reasons.includes("source_version_changed")) reasons.push("source_version_changed");
  }
  return reasons;
}
