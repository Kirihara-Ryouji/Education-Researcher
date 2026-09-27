import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  ResearchClaimCreateSchema,
  ResearchCleaningRunCreateSchema,
  ResearchAnalysisRunCreateSchema,
  ResearchDecisionCreateSchema,
  ResearchExecutionLinkCreateSchema,
  ResearchEvidenceCreateSchema,
  ResearchManualPageCreateSchema,
  ResearchEvidenceVerificationCreateSchema,
  ResearchPlanCreateSchema,
  ResearchProjectCreateSchema,
  ResearchProjectSchema,
  ResearchReportCreateSchema,
  ResearchReportVersionSchema,
  ResearchSourceCreateSchema,
  ResearchStudySchema,
  StudySpecInputSchema,
  staleEvidenceIds,
  executionLinkReviewReasons,
  analysisRunReviewReasons,
  latestCleaningRunForAsset,
  type ResearchAnalysisRun,
  type ResearchAnalysisRunStatus,
  type ResearchAnalysisReviewReason,
  type ResearchCleaningRun,
  type ResearchCleaningRecipe,
  type ResearchExecutionLink,
  type ResearchExecutionLinkStatus,
  type ResearchExecutionReviewReason,
  type ResearchExecutionSnapshot,
  type ResearchExecutionTarget,
  type ResearchProject,
  type ResearchReportReviewReason,
  type ResearchReportStatus,
  type ResearchReportVersion,
  type ResearchStudy,
} from "@brainpilot/protocol";
import type { StagedResearchAsset } from "./research-asset-upload.js";
import { cleanResearchCsv, parseResearchCsv, summarizeResearchRows, ResearchTableError } from "./research-tabular.js";
import { renderResearchReportMarkdown } from "./research-report.js";
import { withResearchStateLock } from "./research-state-lock.js";

const ResearchStateSchema = z.object({
  version: z.literal(1),
  projects: z.array(ResearchProjectSchema),
  studies: z.array(ResearchStudySchema),
}).strict();
type ResearchState = z.infer<typeof ResearchStateSchema>;

export class ResearchRecordError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "ResearchRecordError";
  }
}

export class ResearchStoreError extends Error {
  constructor(cause: unknown) {
    super("Research state could not be read", { cause });
    this.name = "ResearchStoreError";
  }
}

/**
 * Local, single-user research business state. This deliberately does
 * not read or mutate Runtime's session/task ledger. Records are append-only
 * where academic history matters (specs, plans, evidence, claims, decisions).
 */
export class ResearchStore {
  private readonly dataDir: string;
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly resolveExecutionTarget?: (sessionId: string, target: ResearchExecutionTarget) => Promise<ResearchExecutionSnapshot>;

  constructor(dataDir: string, resolveExecutionTarget?: (sessionId: string, target: ResearchExecutionTarget) => Promise<ResearchExecutionSnapshot>) {
    this.dataDir = dataDir;
    this.file = join(dataDir, "research", "research-v1.json");
    this.resolveExecutionTarget = resolveExecutionTarget;
  }

  private async read(): Promise<ResearchState> {
    try {
      return ResearchStateSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projects: [], studies: [] };
      // Corrupt business state must not be silently replaced by an empty file.
      throw new ResearchStoreError(error);
    }
  }

  private async write(state: ResearchState): Promise<void> {
    ResearchStateSchema.parse(state);
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, this.file);
  }

  private mutate<T>(change: (state: ResearchState) => T | Promise<T>): Promise<T> {
    const result = this.queue.then(() => withResearchStateLock(this.file, async () => {
      const state = await this.read();
      const value = await change(state);
      await this.write(state);
      return value;
    }));
    this.queue = result.catch(() => undefined);
    return result;
  }

  async listProjects(): Promise<ResearchProject[]> {
    await this.queue;
    return (await this.read()).projects;
  }

  async getProject(id: string): Promise<{ project: ResearchProject; studies: ResearchStudy[] }> {
    await this.queue;
    const state = await this.read();
    const project = state.projects.find((record) => record.id === id);
    if (!project) throw new ResearchRecordError("Research project not found", 404);
    return { project, studies: state.studies.filter((study) => study.projectId === id) };
  }

  async getStudy(id: string): Promise<ResearchStudy> {
    await this.queue;
    const study = (await this.read()).studies.find((record) => record.id === id);
    if (!study) throw new ResearchRecordError("Research study not found", 404);
    return study;
  }

  createProject(input: unknown): Promise<ResearchProject> {
    const parsed = ResearchProjectCreateSchema.parse(input);
    return this.mutate((state) => {
      const now = new Date().toISOString();
      const project = { ...parsed, id: randomUUID(), createdAt: now, updatedAt: now };
      state.projects.push(project);
      return project;
    });
  }

  createStudy(projectId: string, input: unknown, actorId: string): Promise<ResearchStudy> {
    const spec = StudySpecInputSchema.parse(input);
    return this.mutate((state) => {
      const project = state.projects.find((record) => record.id === projectId);
      if (!project) throw new ResearchRecordError("Research project not found", 404);
      const now = new Date().toISOString();
      const study: ResearchStudy = {
        id: randomUUID(), projectId, createdAt: now, updatedAt: now,
        specs: [{ id: randomUUID(), version: 1, spec, reason: "Initial study definition", createdBy: actorId, createdAt: now }],
        plans: [], sources: [], assets: [], evidence: [], verifications: [], claims: [], decisions: [],
        executionLinks: [], cleaningRuns: [], analysisRuns: [], reports: [],
      };
      state.studies.push(study);
      project.updatedAt = now;
      return study;
    });
  }

  reviseStudy(id: string, input: unknown, actorId: string): Promise<ResearchStudy> {
    const parsed = z.object({ spec: StudySpecInputSchema, reason: z.string().trim().min(1).max(2000) }).strict().parse(input);
    return this.mutate((state) => {
      const study = findStudy(state, id);
      const now = new Date().toISOString();
      study.specs.push({ id: randomUUID(), version: study.specs.length + 1, spec: parsed.spec, reason: parsed.reason, createdBy: actorId, createdAt: now });
      study.updatedAt = now;
      return study;
    });
  }

  addSource(id: string, input: unknown): Promise<ResearchStudy> {
    const parsed = ResearchSourceCreateSchema.parse(input);
    return this.mutate((state) => {
      const study = findStudy(state, id);
      const now = new Date().toISOString();
      study.sources.push({ ...parsed, id: randomUUID(), createdAt: now });
      study.updatedAt = now;
      return study;
    });
  }

  async addAsset(studyId: string, sourceId: string, staged: StagedResearchAsset, accessNote: unknown): Promise<ResearchStudy> {
    let destination: string | undefined;
    try {
      const rights = z.string().trim().min(1).max(2000).parse(accessNote);
      const safeStudyId = z.string().uuid().parse(studyId);
      const safeSourceId = z.string().uuid().parse(sourceId);
      return await this.mutate(async (state) => {
        const study = findStudy(state, safeStudyId);
        if (!study.sources.some((source) => source.id === safeSourceId)) {
          throw new ResearchRecordError("Source does not belong to this study");
        }
        const prior = study.assets.filter((asset) => asset.sourceId === safeSourceId);
        if (prior.some((asset) => asset.sha256 === staged.sha256)) return study;
        const id = randomUUID();
        destination = this.assetPath(safeStudyId, id);
        await mkdir(dirname(destination), { recursive: true });
        await rename(staged.path, destination);
        const now = new Date().toISOString();
        study.assets.push({
          id, sourceId: safeSourceId, version: prior.length + 1,
          filename: staged.filename, mediaType: staged.mediaType,
          sizeBytes: staged.sizeBytes, sha256: staged.sha256, accessNote: rights,
          createdAt: now,
        });
        study.updatedAt = now;
        return study;
      });
    } catch (error) {
      if (destination) await unlink(destination).catch(() => {});
      throw error;
    } finally {
      await unlink(staged.path).catch(() => {});
    }
  }

  async readAsset(studyId: string, assetId: string): Promise<{ asset: ResearchStudy["assets"][number]; bytes: Buffer }> {
    const safeStudyId = z.string().uuid().parse(studyId);
    const safeAssetId = z.string().uuid().parse(assetId);
    const study = await this.getStudy(safeStudyId);
    return this.readAssetForStudy(study, safeAssetId);
  }

  private async readAssetForStudy(study: ResearchStudy, assetId: string): Promise<{ asset: ResearchStudy["assets"][number]; bytes: Buffer }> {
    const asset = study.assets.find((record) => record.id === assetId);
    if (!asset) throw new ResearchRecordError("Research file not found", 404);
    let bytes: Buffer;
    try { bytes = await readFile(this.assetPath(study.id, assetId)); }
    catch (error) { throw new ResearchStoreError(error); }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) throw new ResearchStoreError(new Error("Research file checksum mismatch"));
    return { asset, bytes };
  }

  private async assertEvidenceAssetsAvailable(study: ResearchStudy, evidenceIds: readonly string[]): Promise<void> {
    const assetIds = new Set<string>();
    for (const evidenceId of evidenceIds) {
      const evidence = study.evidence.find((record) => record.id === evidenceId);
      if (!evidence) throw new ResearchRecordError("Referenced evidence is unavailable", 409);
      if (evidence.assetId) assetIds.add(evidence.assetId);
    }
    for (const assetId of assetIds) {
      try { await this.readAssetForStudy(study, assetId); }
      catch { throw new ResearchRecordError("A linked evidence file is missing or has changed; restore it before continuing", 409); }
    }
  }

  private assetPath(studyId: string, assetId: string): string {
    return join(this.dataDir, "research", "assets", studyId, `${assetId}.bin`);
  }

  addEvidence(id: string, input: unknown, captureMethod: "manual" | "extracted" = "manual"): Promise<ResearchStudy> {
    const parsed = ResearchEvidenceCreateSchema.parse(input);
    if (parsed.kind === "manual_transcription") {
      throw new ResearchRecordError("Use the PDF page transcription workflow for manual transcription");
    }
    if (captureMethod === "extracted" && (parsed.kind !== "source_excerpt" || !parsed.assetId || !/:u16\d+-\d+$/.test(parsed.locator))) {
      throw new ResearchRecordError("An extracted quote must identify its file and text range");
    }
    return this.mutate((state) => {
      const study = findStudy(state, id);
      if (!study.sources.some((source) => source.id === parsed.sourceId)) {
        throw new ResearchRecordError("Source does not belong to this study");
      }
      if (parsed.assetId && !study.assets.some((asset) => asset.id === parsed.assetId && asset.sourceId === parsed.sourceId)) {
        throw new ResearchRecordError("File version does not belong to this source");
      }
      const now = new Date().toISOString();
      study.evidence.push({ ...parsed, id: randomUUID(), captureMethod, verification: "unverified", createdAt: now });
      study.updatedAt = now;
      return study;
    });
  }

  addManualPageEvidence(id: string, input: unknown, pageCount: number): Promise<ResearchStudy> {
    const parsed = ResearchManualPageCreateSchema.parse(input);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || parsed.page > pageCount) {
      throw new ResearchRecordError(`Choose a PDF page from 1 to ${pageCount}`);
    }
    return this.mutate((state) => {
      const study = findStudy(state, id);
      const asset = study.assets.find((record) => record.id === parsed.assetId);
      if (!asset || asset.mediaType !== "application/pdf") {
        throw new ResearchRecordError("Manual page transcription requires a PDF file in this study");
      }
      const now = new Date().toISOString();
      study.evidence.push({
        id: randomUUID(), sourceId: asset.sourceId, assetId: asset.id,
        kind: "manual_transcription", locator: `pdf:p${parsed.page}:manual`,
        content: parsed.content, note: parsed.note,
        captureMethod: "transcribed", verification: "unverified", createdAt: now,
      });
      study.updatedAt = now;
      return study;
    });
  }

  verifyEvidence(id: string, input: unknown, actorId: string): Promise<ResearchStudy> {
    const parsed = ResearchEvidenceVerificationCreateSchema.parse(input);
    return this.mutate(async (state) => {
      const study = findStudy(state, id);
      const evidence = study.evidence.find((record) => record.id === parsed.evidenceId);
      if (!evidence) throw new ResearchRecordError("Evidence does not belong to this study");
      await this.assertEvidenceAssetsAvailable(study, [evidence.id]);
      if (evidence.verification === "content_checked" || evidence.verification === parsed.level) {
        throw new ResearchRecordError("Evidence already has this verification level", 409);
      }
      const now = new Date().toISOString();
      study.verifications.push({ ...parsed, id: randomUUID(), actorId, createdAt: now });
      evidence.verification = parsed.level;
      study.updatedAt = now;
      return study;
    });
  }

  addPlan(id: string, input: unknown, actorId: string): Promise<ResearchStudy> {
    const parsed = ResearchPlanCreateSchema.parse(input);
    return this.mutate((state) => {
      const study = findStudy(state, id);
      for (const evidenceId of parsed.evidenceIds) {
        if (!study.evidence.some((evidence) => evidence.id === evidenceId)) {
          throw new ResearchRecordError("Plan references evidence outside this study");
        }
      }
      const now = new Date().toISOString();
      study.plans.push({ ...parsed, id: randomUUID(), version: study.plans.length + 1, specVersionId: study.specs.at(-1)!.id, createdBy: actorId, createdAt: now });
      study.updatedAt = now;
      return study;
    });
  }

  async addExecutionLink(id: string, input: unknown): Promise<ResearchStudy> {
    const parsed = ResearchExecutionLinkCreateSchema.parse(input);
    if (!this.resolveExecutionTarget) throw new ResearchRecordError("Runtime link verification is unavailable", 409);
    // Validate locally before waking Runtime, then validate again inside the
    // serial mutation in case a new plan or file version arrived meanwhile.
    const initialStudy = await this.getStudy(id);
    assertLinkablePlan(initialStudy, parsed.planVersionId);
    await this.assertEvidenceAssetsAvailable(initialStudy, initialStudy.plans.at(-1)!.evidenceIds);
    assertNoDuplicateExecutionLink(initialStudy, parsed.planVersionId, parsed.sessionId, parsed.target);
    const snapshot = await this.resolveExecutionTarget(parsed.sessionId, parsed.target);
    return this.mutate(async (state) => {
      const study = findStudy(state, id);
      assertLinkablePlan(study, parsed.planVersionId);
      await this.assertEvidenceAssetsAvailable(study, study.plans.at(-1)!.evidenceIds);
      assertNoDuplicateExecutionLink(study, parsed.planVersionId, parsed.sessionId, parsed.target);
      const now = new Date().toISOString();
      study.executionLinks.push({ ...parsed, id: randomUUID(), snapshot, createdAt: now });
      study.updatedAt = now;
      return study;
    });
  }

  async getExecutionStatuses(id: string): Promise<ResearchExecutionLinkStatus[]> {
    const study = await this.getStudy(id);
    return this.executionStatusesForStudy(study);
  }

  private executionStatusesForStudy(study: ResearchStudy, links = study.executionLinks): Promise<ResearchExecutionLinkStatus[]> {
    return Promise.all(links.map(async (link) => {
      const reasons: ResearchExecutionReviewReason[] = executionLinkReviewReasons(study, link);
      let unavailable = false;
      if (!this.resolveExecutionTarget) {
        reasons.push("runtime_unavailable");
        unavailable = true;
      } else {
        try {
          const current = await this.resolveExecutionTarget(link.sessionId, link.target);
          reasons.push(...runtimeReviewReasons(link, current));
        } catch (error) {
          if (error instanceof ResearchRecordError && error.status === 404) {
            reasons.push("runtime_target_missing");
            unavailable = true;
          }
          else { reasons.push("runtime_unavailable"); unavailable = true; }
        }
      }
      return { linkId: link.id, status: unavailable ? "unavailable" : reasons.length ? "needs_review" : "current", reasons };
    }));
  }

  async addCleaningRun(id: string, input: unknown, actorId: string): Promise<ResearchStudy> {
    const parsed = ResearchCleaningRunCreateSchema.parse(input);
    const initial = await this.getStudy(id);
    assertCurrentAcceptedPlan(initial, parsed.planVersionId);
    await this.assertEvidenceAssetsAvailable(initial, initial.plans.at(-1)!.evidenceIds);
    const asset = assertCurrentCsvAsset(initial, parsed.assetId);
    const { bytes } = await this.readAssetForStudy(initial, asset.id);
    const cleaned = cleanResearchCsv(parseResearchCsv(bytes), parsed.recipe);
    return this.mutate(async (state) => {
      const study = findStudy(state, id);
      assertCurrentAcceptedPlan(study, parsed.planVersionId);
      await this.assertEvidenceAssetsAvailable(study, study.plans.at(-1)!.evidenceIds);
      assertCurrentCsvAsset(study, parsed.assetId);
      const latestCleaning = latestCleaningRunForAsset(study, parsed.planVersionId, parsed.assetId);
      if (latestCleaning && sameCleaningRecipe(latestCleaning.recipe, parsed.recipe)) {
        throw new ResearchRecordError("This cleaning recipe is already current for this file version", 409);
      }
      const now = new Date().toISOString();
      study.cleaningRuns.push({
        ...parsed, id: randomUUID(), version: study.cleaningRuns.length + 1,
        sourceId: asset.sourceId, inputSha256: asset.sha256,
        cleanedSha256: cleaned.cleanedSha256, counts: cleaned.counts,
        engineVersion: "csv-clean-v1", createdBy: actorId, createdAt: now,
      });
      study.updatedAt = now;
      return study;
    });
  }

  async addAnalysisRun(id: string, input: unknown, actorId: string): Promise<ResearchStudy> {
    const parsed = ResearchAnalysisRunCreateSchema.parse(input);
    const initial = await this.getStudy(id);
    const cleaning = initial.cleaningRuns.find((record) => record.id === parsed.cleaningRunId);
    if (!cleaning) throw new ResearchRecordError("Cleaning run does not belong to this study");
    assertCurrentAcceptedPlan(initial, cleaning.planVersionId);
    await this.assertEvidenceAssetsAvailable(initial, initial.plans.at(-1)!.evidenceIds);
    if (latestCleaningRunForAsset(initial, cleaning.planVersionId, cleaning.assetId)?.id !== cleaning.id) {
      throw new ResearchRecordError("Only the current cleaning version for this dataset can be analyzed", 409);
    }
    assertCurrentCsvAsset(initial, cleaning.assetId);
    const computed = await this.computeAnalysis(initial, cleaning);
    if (computed.cleanedSha256 !== cleaning.cleanedSha256) throw new ResearchRecordError("The cleaning result changed; review before analysis", 409);
    return this.mutate(async (state) => {
      const study = findStudy(state, id);
      assertCurrentAcceptedPlan(study, cleaning.planVersionId);
      await this.assertEvidenceAssetsAvailable(study, study.plans.at(-1)!.evidenceIds);
      if (latestCleaningRunForAsset(study, cleaning.planVersionId, cleaning.assetId)?.id !== cleaning.id) {
        throw new ResearchRecordError("Cleaning version changed before analysis was saved", 409);
      }
      assertCurrentCsvAsset(study, cleaning.assetId);
      const now = new Date().toISOString();
      study.analysisRuns.push({
        id: randomUUID(), version: study.analysisRuns.length + 1,
        cleaningRunId: cleaning.id, planVersionId: cleaning.planVersionId,
        sourceId: cleaning.sourceId, assetId: cleaning.assetId,
        inputSha256: cleaning.inputSha256, cleanedSha256: cleaning.cleanedSha256,
        result: computed.result, resultSha256: computed.resultSha256,
        engineVersion: "csv-descriptive-v1", createdBy: actorId, createdAt: now,
      });
      study.updatedAt = now;
      return study;
    });
  }

  async getAnalysisStatuses(id: string): Promise<ResearchAnalysisRunStatus[]> {
    const study = await this.getStudy(id);
    return this.analysisStatusesForStudy(study);
  }

  private analysisStatusesForStudy(study: ResearchStudy, runs = study.analysisRuns): Promise<ResearchAnalysisRunStatus[]> {
    return Promise.all(runs.map(async (run) => {
      const reasons: ResearchAnalysisReviewReason[] = analysisRunReviewReasons(study, run);
      const cleaning = study.cleaningRuns.find((record) => record.id === run.cleaningRunId);
      if (!cleaning) reasons.push("cleaning_version_changed");
      else {
        try {
          const computed = await this.computeAnalysis(study, cleaning);
          if (computed.cleanedSha256 !== cleaning.cleanedSha256
            || computed.resultSha256 !== run.resultSha256
            || JSON.stringify(canonicalAnalysisResult(computed.result)) !== JSON.stringify(canonicalAnalysisResult(run.result))) {
            reasons.push("result_changed");
          }
        } catch (error) {
          if (error instanceof ResearchStoreError || (error instanceof ResearchRecordError && error.status === 404)) {
            return { runId: run.id, status: "unavailable" as const, reasons: [...new Set([...reasons, "raw_file_unavailable" as const])] };
          }
          if (error instanceof ResearchTableError || error instanceof ResearchRecordError) reasons.push("recompute_failed");
          else throw error;
        }
      }
      return { runId: run.id, status: reasons.length ? "needs_review" as const : "current" as const, reasons: [...new Set(reasons)] };
    }));
  }

  private async computeAnalysis(study: ResearchStudy, cleaning: ResearchCleaningRun): Promise<{
    cleanedSha256: string;
    result: ResearchAnalysisRun["result"];
    resultSha256: string;
  }> {
    const { asset, bytes } = await this.readAssetForStudy(study, cleaning.assetId);
    if (asset.sha256 !== cleaning.inputSha256 || asset.mediaType !== "text/csv") {
      throw new ResearchRecordError("The analysis input no longer matches its recorded file", 409);
    }
    const cleaned = cleanResearchCsv(parseResearchCsv(bytes), cleaning.recipe);
    const result = summarizeResearchRows(cleaned.rows);
    return {
      cleanedSha256: cleaned.cleanedSha256,
      result,
      resultSha256: hashAnalysisResult(cleaning.inputSha256, cleaned.cleanedSha256, result),
    };
  }

  addClaim(id: string, input: unknown): Promise<ResearchStudy> {
    const parsed = ResearchClaimCreateSchema.parse(input);
    return this.mutate((state) => {
      const study = findStudy(state, id);
      for (const link of parsed.evidence) {
        if (!study.evidence.some((evidence) => evidence.id === link.evidenceId)) {
          throw new ResearchRecordError("Claim references evidence outside this study");
        }
      }
      for (const executionLinkId of parsed.executionLinkIds) {
        if (!study.executionLinks.some((link) => link.id === executionLinkId)) {
          throw new ResearchRecordError("Claim references a Runtime link outside this study");
        }
      }
      for (const analysisRunId of parsed.analysisRunIds) {
        if (!study.analysisRuns.some((run) => run.id === analysisRunId)) {
          throw new ResearchRecordError("Claim references an analysis outside this study");
        }
      }
      const now = new Date().toISOString();
      study.claims.push({ ...parsed, id: randomUUID(), createdAt: now });
      study.updatedAt = now;
      return study;
    });
  }

  addReport(id: string, input: unknown, actorId: string): Promise<ResearchStudy> {
    const parsed = ResearchReportCreateSchema.parse(input);
    if (new Set(parsed.claimIds).size !== parsed.claimIds.length || new Set(parsed.analysisRunIds).size !== parsed.analysisRunIds.length) {
      throw new ResearchRecordError("Report references must not repeat the same record");
    }
    return this.mutate(async (state) => {
      const study = findStudy(state, id);
      const project = state.projects.find((record) => record.id === study.projectId);
      if (!project) throw new ResearchRecordError("Research project not found", 404);
      const planVersionId = study.plans.at(-1)?.id;
      if (!planVersionId) throw new ResearchRecordError("Create and accept a research plan before writing a report", 409);
      assertCurrentAcceptedPlan(study, planVersionId);

      const claims = parsed.claimIds.map((claimId) => study.claims.find((claim) => claim.id === claimId));
      if (claims.some((claim) => !claim)) throw new ResearchRecordError("Report references a claim outside this study");
      const requiredAnalyses = new Set(claims.flatMap((claim) => claim!.analysisRunIds));
      if ([...requiredAnalyses].some((runId) => !parsed.analysisRunIds.includes(runId))) {
        throw new ResearchRecordError("Include every analysis linked to the selected claims", 400);
      }
      const runs = parsed.analysisRunIds.map((runId) => study.analysisRuns.find((run) => run.id === runId));
      if (runs.some((run) => !run)) throw new ResearchRecordError("Report references an analysis outside this study");
      const linkIds = [...new Set(claims.flatMap((claim) => claim!.executionLinkIds))];
      const links = linkIds.map((linkId) => study.executionLinks.find((link) => link.id === linkId));
      if (links.some((link) => !link)) throw new ResearchRecordError("Report references a Runtime link outside this study");

      const evidenceIds = [...new Set([
        ...study.plans.at(-1)!.evidenceIds,
        ...claims.flatMap((claim) => claim!.evidence.map((link) => link.evidenceId)),
      ])];
      for (const evidenceId of evidenceIds) {
        const evidence = study.evidence.find((record) => record.id === evidenceId);
        if (!evidence || !study.sources.some((source) => source.id === evidence.sourceId)
          || (evidence.assetId && !study.assets.some((asset) => asset.id === evidence.assetId && asset.sourceId === evidence.sourceId))) {
          throw new ResearchRecordError("Report evidence or its source is unavailable", 409);
        }
      }

      const [analysisStatuses, executionStatuses, unavailableEvidence] = await Promise.all([
        this.analysisStatusesForStudy(study, runs as ResearchAnalysisRun[]),
        this.executionStatusesForStudy(study, links as ResearchExecutionLink[]),
        this.unavailableEvidenceIds(study, evidenceIds),
      ]);
      const now = new Date().toISOString();
      const reportId = randomUUID();
      const version = study.reports.length + 1;
      const draftStatus = reportStatusForStudy(study, {
        ...parsed, id: reportId, version, planVersionId, markdown: "pending", sha256: hashText("pending"),
        createdBy: actorId, createdAt: now,
      }, analysisStatuses, executionStatuses, unavailableEvidence);
      if (draftStatus.status !== "current") {
        throw new ResearchRecordError(`Report references need review: ${draftStatus.reasons.join(", ")}`, 409);
      }
      const markdown = renderResearchReportMarkdown({
        study, project, draft: parsed, reportId, reportVersion: version, planVersionId,
        createdAt: now, createdBy: actorId, analysisStatuses, executionStatuses,
      });
      const report = ResearchReportVersionSchema.parse({
        ...parsed, id: reportId, version, planVersionId, markdown,
        sha256: hashText(markdown), createdBy: actorId, createdAt: now,
      });
      study.reports.push(report);
      study.updatedAt = now;
      return study;
    });
  }

  async getReportStatuses(id: string): Promise<ResearchReportStatus[]> {
    const study = await this.getStudy(id);
    return this.reportStatusesForStudy(study);
  }

  private async reportStatusesForStudy(study: ResearchStudy): Promise<ResearchReportStatus[]> {
    const evidenceIds = [...new Set(study.reports.flatMap((report) => [
      ...(study.plans.find((plan) => plan.id === report.planVersionId)?.evidenceIds ?? []),
      ...report.claimIds.flatMap((claimId) => study.claims.find((claim) => claim.id === claimId)?.evidence.map((link) => link.evidenceId) ?? []),
    ]))];
    const [analysisStatuses, executionStatuses, unavailableEvidence] = await Promise.all([
      this.analysisStatusesForStudy(study), this.executionStatusesForStudy(study), this.unavailableEvidenceIds(study, evidenceIds),
    ]);
    return study.reports.map((report) => reportStatusForStudy(study, report, analysisStatuses, executionStatuses, unavailableEvidence));
  }

  private async unavailableEvidenceIds(study: ResearchStudy, evidenceIds: string[]): Promise<Set<string>> {
    const unavailable = new Set<string>();
    const checked = new Map<string, boolean>();
    for (const evidenceId of evidenceIds) {
      const evidence = study.evidence.find((record) => record.id === evidenceId);
      if (!evidence?.assetId) continue;
      let available = checked.get(evidence.assetId);
      if (available === undefined) {
        try { await this.readAssetForStudy(study, evidence.assetId); available = true; }
        catch (error) {
          if (!(error instanceof ResearchStoreError || error instanceof ResearchRecordError)) throw error;
          available = false;
        }
        checked.set(evidence.assetId, available);
      }
      if (!available) unavailable.add(evidenceId);
    }
    return unavailable;
  }

  async getReport(id: string, reportId: string): Promise<ResearchReportVersion> {
    const safeReportId = z.string().uuid().parse(reportId);
    const study = await this.getStudy(id);
    const report = study.reports.find((record) => record.id === safeReportId);
    if (!report) throw new ResearchRecordError("Report version not found", 404);
    if (hashText(report.markdown) !== report.sha256) throw new ResearchRecordError("Report export checksum does not match its saved version", 409);
    return report;
  }

  decide(id: string, input: unknown, actorId: string): Promise<ResearchStudy> {
    const parsed = ResearchDecisionCreateSchema.parse(input);
    return this.mutate(async (state) => {
      const study = findStudy(state, id);
      if (parsed.target === "plan") {
        const latest = study.plans.at(-1);
        if (!latest || latest.id !== parsed.targetId) throw new ResearchRecordError("Only the current plan version can be decided", 409);
        if (latest.specVersionId !== study.specs.at(-1)!.id) throw new ResearchRecordError("The study definition changed; create a new plan version", 409);
      } else if (parsed.target === "claim" && !study.claims.some((claim) => claim.id === parsed.targetId)) {
        throw new ResearchRecordError("Claim does not belong to this study");
      } else if (parsed.target === "report" && !study.reports.some((report) => report.id === parsed.targetId)) {
        throw new ResearchRecordError("Report does not belong to this study");
      }
      if (parsed.target === "report" && study.reports.at(-1)?.id !== parsed.targetId) {
        throw new ResearchRecordError("Only the current report version can be decided", 409);
      }
      if (parsed.decision === "accept") {
        const stale = staleEvidenceIds(study);
        let referenced: string[] = [];
        if (parsed.target === "plan") referenced = study.plans.at(-1)!.evidenceIds;
        if (parsed.target === "claim") {
          const claim = study.claims.find((record) => record.id === parsed.targetId)!;
          const planIds = [
            ...claim.analysisRunIds.map((runId) => study.analysisRuns.find((run) => run.id === runId)?.planVersionId),
            ...claim.executionLinkIds.map((linkId) => study.executionLinks.find((link) => link.id === linkId)?.planVersionId),
          ];
          referenced = [...new Set([
            ...claim.evidence.map((link) => link.evidenceId),
            ...planIds.flatMap((planId) => study.plans.find((plan) => plan.id === planId)?.evidenceIds ?? []),
          ])];
        }
        if (referenced.some((evidenceId) => stale.has(evidenceId))) {
          throw new ResearchRecordError("A linked file version changed; review and replace stale evidence before acceptance", 409);
        }
        await this.assertEvidenceAssetsAvailable(study, referenced);
        if (parsed.target === "claim") {
          const claim = study.claims.find((record) => record.id === parsed.targetId)!;
          for (const analysisRunId of claim.analysisRunIds) {
            const run = study.analysisRuns.find((record) => record.id === analysisRunId)!;
            if (analysisRunReviewReasons(study, run).length > 0) {
              throw new ResearchRecordError("A linked analysis needs review under the current data and plan", 409);
            }
            const cleaning = study.cleaningRuns.find((record) => record.id === run.cleaningRunId);
            if (!cleaning) throw new ResearchRecordError("A linked cleaning version is unavailable", 409);
            let computed: Awaited<ReturnType<ResearchStore["computeAnalysis"]>>;
            try { computed = await this.computeAnalysis(study, cleaning); }
            catch { throw new ResearchRecordError("A linked analysis could not be reproduced", 409); }
            if (computed.cleanedSha256 !== cleaning.cleanedSha256 || computed.resultSha256 !== run.resultSha256
              || JSON.stringify(canonicalAnalysisResult(computed.result)) !== JSON.stringify(canonicalAnalysisResult(run.result))) {
              throw new ResearchRecordError("A linked analysis result changed and needs review", 409);
            }
          }
          for (const executionLinkId of claim.executionLinkIds) {
            const link = study.executionLinks.find((record) => record.id === executionLinkId)!;
            if (executionLinkReviewReasons(study, link).length > 0) {
              throw new ResearchRecordError("A linked execution result needs review under the current plan", 409);
            }
            if (!this.resolveExecutionTarget) throw new ResearchRecordError("Runtime verification is unavailable", 409);
            let current: ResearchExecutionSnapshot;
            try { current = await this.resolveExecutionTarget(link.sessionId, link.target); }
            catch { throw new ResearchRecordError("A linked Runtime result could not be verified", 409); }
            if (runtimeReviewReasons(link, current).length > 0) {
              throw new ResearchRecordError("A linked Runtime result changed and needs review", 409);
            }
          }
        }
        if (parsed.target === "report") {
          const report = study.reports.find((record) => record.id === parsed.targetId)!;
          const statuses = await this.reportStatusesForStudy(study);
          const status = statuses.find((record) => record.reportId === report.id)!;
          if (status.status !== "current") throw new ResearchRecordError(`Report references need review: ${status.reasons.join(", ")}`, 409);
        }
      }
      if (study.decisions.some((decision) => decision.target === parsed.target && decision.targetId === parsed.targetId)) {
        throw new ResearchRecordError("This version already has a decision", 409);
      }
      const now = new Date().toISOString();
      study.decisions.push({ ...parsed, id: randomUUID(), actorId, createdAt: now });
      study.updatedAt = now;
      return study;
    });
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function reportStatusForStudy(
  study: ResearchStudy,
  report: ResearchReportVersion,
  analysisStatuses: ResearchAnalysisRunStatus[],
  executionStatuses: ResearchExecutionLinkStatus[],
  unavailableEvidence = new Set<string>(),
): ResearchReportStatus {
  const reasons: ResearchReportReviewReason[] = [];
  let unavailable = false;
  const plan = study.plans.find((record) => record.id === report.planVersionId);
  if (!plan || plan.specVersionId !== study.specs.at(-1)?.id) reasons.push("study_definition_changed");
  if (study.plans.at(-1)?.id !== report.planVersionId) reasons.push("plan_changed");
  if (!study.decisions.some((decision) => decision.target === "plan" && decision.targetId === report.planVersionId && decision.decision === "accept")) {
    reasons.push("plan_not_accepted");
  }
  const staleEvidence = staleEvidenceIds(study);
  if (plan?.evidenceIds.some((id) => !study.evidence.some((evidence) => evidence.id === id) || staleEvidence.has(id))) {
    reasons.push("evidence_changed");
  }
  if (plan?.evidenceIds.some((id) => unavailableEvidence.has(id))) { reasons.push("evidence_changed"); unavailable = true; }
  const analysisById = new Map(analysisStatuses.map((status) => [status.runId, status]));
  const executionById = new Map(executionStatuses.map((status) => [status.linkId, status]));
  for (const claimId of report.claimIds) {
    const claim = study.claims.find((record) => record.id === claimId);
    if (!claim) { reasons.push("claim_missing"); unavailable = true; continue; }
    if (!study.decisions.some((decision) => decision.target === "claim" && decision.targetId === claim.id && decision.decision === "accept")) {
      reasons.push("claim_not_accepted");
    }
    if (claim.evidence.some((link) => !study.evidence.some((evidence) => evidence.id === link.evidenceId) || staleEvidence.has(link.evidenceId))) {
      reasons.push("evidence_changed");
    }
    if (claim.evidence.some((link) => unavailableEvidence.has(link.evidenceId))) { reasons.push("evidence_changed"); unavailable = true; }
    if (claim.analysisRunIds.some((id) => !report.analysisRunIds.includes(id))) reasons.push("analysis_needs_review");
    for (const linkId of claim.executionLinkIds) {
      const status = executionById.get(linkId);
      if (!status || status.status === "unavailable") { reasons.push("execution_unavailable"); unavailable = true; }
      else if (status.status === "needs_review") reasons.push("execution_needs_review");
    }
  }
  for (const runId of report.analysisRunIds) {
    const status = analysisById.get(runId);
    if (!status || status.status === "unavailable") { reasons.push("analysis_unavailable"); unavailable = true; }
    else if (status.status === "needs_review") reasons.push("analysis_needs_review");
  }
  if (hashText(report.markdown) !== report.sha256) { reasons.push("report_content_changed"); unavailable = true; }
  const distinct = [...new Set(reasons)];
  return { reportId: report.id, status: unavailable ? "unavailable" : distinct.length ? "needs_review" : "current", reasons: distinct };
}

function hashAnalysisResult(inputSha256: string, cleanedSha256: string, result: ResearchAnalysisRun["result"]): string {
  return createHash("sha256")
    .update(JSON.stringify({ engineVersion: "csv-descriptive-v1", inputSha256, cleanedSha256, result: canonicalAnalysisResult(result) }), "utf8")
    .digest("hex");
}

function canonicalAnalysisResult(result: ResearchAnalysisRun["result"]): ResearchAnalysisRun["result"] {
  const stats = (value: ResearchAnalysisRun["result"]["overall"]) => ({
    n: value.n, mean: value.mean, sampleSd: value.sampleSd, min: value.min, max: value.max,
  });
  return {
    overall: stats(result.overall),
    groups: result.groups.map((group) => ({ group: group.group, ...stats(group) })),
  };
}

function assertCurrentCsvAsset(study: ResearchStudy, assetId: string): ResearchStudy["assets"][number] {
  const asset = study.assets.find((record) => record.id === assetId);
  if (!asset || asset.mediaType !== "text/csv") throw new ResearchRecordError("Choose a CSV file in this study");
  const source = study.sources.find((record) => record.id === asset.sourceId);
  if (!source || source.kind !== "dataset") throw new ResearchRecordError("CSV analysis requires a dataset source");
  const latest = study.assets.filter((record) => record.sourceId === asset.sourceId && record.mediaType === "text/csv").at(-1);
  if (latest?.id !== asset.id) throw new ResearchRecordError("Choose the latest file version for this dataset", 409);
  return asset;
}

/** Missing markers are a set in the cleaning engine; their order and case do not change the operation. */
function sameCleaningRecipe(left: ResearchCleaningRecipe, right: ResearchCleaningRecipe): boolean {
  const identity = (recipe: ResearchCleaningRecipe): string => {
    const tokens = [...new Set(recipe.missingTokens.map((token) =>
      (recipe.trimWhitespace ? token.trim() : token).toLowerCase(),
    ).filter(Boolean))].sort();
    return JSON.stringify([
      recipe.valueColumn, recipe.groupColumn ?? null, tokens, recipe.trimWhitespace, recipe.invalidNumeric,
    ]);
  };
  return identity(left) === identity(right);
}

function assertCurrentAcceptedPlan(study: ResearchStudy, planVersionId: string): void {
  const plan = study.plans.at(-1);
  if (!plan || plan.id !== planVersionId) throw new ResearchRecordError("Choose the current research plan", 409);
  if (plan.specVersionId !== study.specs.at(-1)?.id || plan.evidenceIds.some((id) => staleEvidenceIds(study).has(id))) {
    throw new ResearchRecordError("Review the research plan and its evidence before running analysis", 409);
  }
  if (!study.decisions.some((decision) => decision.target === "plan" && decision.targetId === plan.id && decision.decision === "accept")) {
    throw new ResearchRecordError("Accept the current plan before running analysis", 409);
  }
}

function assertLinkablePlan(study: ResearchStudy, planVersionId: string): void {
  const plan = study.plans.at(-1);
  if (!plan || plan.id !== planVersionId) throw new ResearchRecordError("Only the current plan can be linked to Runtime", 409);
  if (plan.specVersionId !== study.specs.at(-1)?.id || plan.evidenceIds.some((id) => staleEvidenceIds(study).has(id))) {
    throw new ResearchRecordError("Review the current plan and its evidence before linking Runtime", 409);
  }
  if (!study.decisions.some((decision) => decision.target === "plan" && decision.targetId === plan.id && decision.decision === "accept")) {
    throw new ResearchRecordError("Accept the current plan before linking Runtime", 409);
  }
}

function assertNoDuplicateExecutionLink(study: ResearchStudy, planVersionId: string, sessionId: string, target: ResearchExecutionTarget): void {
  if (study.executionLinks.some((link) => link.planVersionId === planVersionId && link.sessionId === sessionId
    && JSON.stringify(link.target) === JSON.stringify(target))) {
    throw new ResearchRecordError("This Runtime object is already linked to this plan", 409);
  }
}

function runtimeReviewReasons(link: ResearchExecutionLink, current: ResearchExecutionSnapshot): ResearchExecutionReviewReason[] {
  const reasons: ResearchExecutionReviewReason[] = [];
  if (current.fingerprint !== link.snapshot.fingerprint || current.contentHash !== link.snapshot.contentHash) {
    reasons.push("runtime_target_changed");
  } else if ((link.target.kind === "trace_node" || link.target.kind === "trace_artifact")
    && !link.snapshot.contentHash && current.traceRevision !== link.snapshot.traceRevision) {
    // Without a content hash, a newer trace cannot prove that the referenced
    // result is byte-for-byte identical, even when its metadata still matches.
    reasons.push("runtime_trace_changed");
  }
  return reasons;
}

function findStudy(state: ResearchState, id: string): ResearchStudy {
  const study = state.studies.find((record) => record.id === id);
  if (!study) throw new ResearchRecordError("Research study not found", 404);
  return study;
}
