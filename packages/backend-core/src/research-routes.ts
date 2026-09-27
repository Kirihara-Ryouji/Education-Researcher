import { Hono } from "hono";
import { readFile, unlink } from "node:fs/promises";
import { z, ZodError } from "zod";
import { ResearchManualPageCreateSchema, type ResearchExecutionSnapshot, type ResearchExecutionTarget } from "@brainpilot/protocol";
import { ResearchAssetError, stageResearchAsset } from "./research-asset-upload.js";
import { ResearchRecordError, ResearchStore } from "./research-store.js";
import { ResearchRuntimeUnavailableError } from "./research-runtime.js";
import { ResearchStateLockError } from "./research-state-lock.js";
import { parseResearchCsv, profileResearchCsv, RESEARCH_CSV_MAX_BYTES, ResearchTableError } from "./research-tabular.js";
import { countResearchPdfPages, extractResearchText, ResearchTextError, selectResearchQuote } from "./research-text-extraction.js";

class ResearchMediaTypeError extends Error {}

/** Local research business API. It never starts or mutates an agent runtime. */
export function createResearchRoutes(
  dataDir: string,
  enabled: boolean,
  resolveExecutionTarget?: (sessionId: string, target: ResearchExecutionTarget) => Promise<ResearchExecutionSnapshot>,
): Hono {
  const api = new Hono();
  const store = new ResearchStore(dataDir, resolveExecutionTarget);

  api.use("/*", async (c, next) => {
    if (!enabled) return c.json({ error: "Research workspace is available in local single-user mode only", code: "RESEARCH_UNAVAILABLE" }, 404);
    // The research store has no user authentication. A loopback-only listener is
    // the deployment boundary; check the HTTP authority as well so a browser
    // cannot reach it through DNS rebinding or a forwarded Host header.
    let requestUrl: URL;
    try {
      requestUrl = new URL(c.req.url);
      const hostHeader = c.req.header("host");
      if (!isLoopbackHost(requestUrl.hostname) || (hostHeader && new URL(`${requestUrl.protocol}//${hostHeader}`).host !== requestUrl.host)) {
        return c.json({ error: "Research workspace requires a loopback host", code: "RESEARCH_LOCAL_ONLY" }, 403);
      }
    } catch {
      return c.json({ error: "Invalid research request host", code: "RESEARCH_LOCAL_ONLY" }, 403);
    }
    const origin = c.req.header("origin");
    const fetchSite = c.req.header("sec-fetch-site");
    if ((origin && origin !== requestUrl.origin) || (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")) {
      return c.json({ error: "Cross-origin research access is unavailable", code: "RESEARCH_CROSS_ORIGIN" }, 403);
    }
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    await next();
  });

  api.onError((error, c) => {
    if (error instanceof ResearchMediaTypeError) return c.json({ error: error.message }, 415);
    if (error instanceof ResearchStateLockError) {
      c.header("retry-after", "1");
      return c.json({ error: error.message, code: "RESEARCH_BUSY" }, 503);
    }
    if (error instanceof ZodError) return c.json({ error: "Invalid research record", details: error.issues }, 400);
    if (error instanceof ResearchRecordError) return c.json({ error: error.message }, error.status);
    if (error instanceof ResearchAssetError) return c.json({ error: error.message }, error.status);
    if (error instanceof ResearchTextError) return c.json({ error: error.message }, error.status);
    if (error instanceof ResearchRuntimeUnavailableError) return c.json({ error: error.message }, 503);
    if (error instanceof ResearchTableError) return c.json({ error: error.message }, error.status);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON body" }, 400);
    // A corrupt store or failed write is not an empty project list.
    return c.json({ error: "Research records are unavailable", code: "RESEARCH_STORE_ERROR" }, 500);
  });

  // This API is local-only. A caller-supplied identity header is not evidence
  // of who made a scholarly decision; hosted identity needs a trusted gateway.
  const actor = () => "local";
  const body = (c: import("hono").Context) => {
    // JSON has a non-simple content type, so a cross-site HTML form cannot
    // submit research decisions as text/plain without a CORS preflight.
    if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new ResearchMediaTypeError("Research JSON requests require application/json");
    }
    return c.req.json() as Promise<unknown>;
  };

  api.get("/projects", async (c) => c.json({ projects: await store.listProjects() }));
  api.post("/projects", async (c) => c.json(await store.createProject(await body(c)), 201));
  api.get("/projects/:projectId", async (c) => c.json(await store.getProject(c.req.param("projectId"))));
  api.post("/projects/:projectId/studies", async (c) => c.json(
    await store.createStudy(c.req.param("projectId"), await body(c), actor()), 201,
  ));
  api.get("/studies/:studyId", async (c) => c.json(await store.getStudy(c.req.param("studyId"))));
  api.post("/studies/:studyId/specs", async (c) => c.json(
    await store.reviseStudy(c.req.param("studyId"), await body(c), actor()), 201,
  ));
  api.post("/studies/:studyId/sources", async (c) => c.json(
    await store.addSource(c.req.param("studyId"), await body(c)), 201,
  ));
  api.post("/studies/:studyId/sources/:sourceId/assets", async (c) => {
    const studyId = c.req.param("studyId");
    const sourceId = c.req.param("sourceId");
    const study = await store.getStudy(studyId);
    const source = study.sources.find((record) => record.id === sourceId);
    if (!source) {
      throw new ResearchRecordError("Source does not belong to this study", 404);
    }
    if (source.kind === "dataset") throw new ResearchRecordError("Use the dataset CSV upload for dataset sources");
    let filename: string;
    let accessNote: string;
    try {
      filename = decodeURIComponent(c.req.header("x-bp-filename") ?? "");
      accessNote = decodeURIComponent(c.req.header("x-bp-access-note") ?? "");
    } catch {
      throw new ResearchAssetError("Invalid file metadata", 400);
    }
    if (filename.toLowerCase().endsWith(".csv")) throw new ResearchAssetError("Use the dataset CSV upload for tabular files", 400);
    if (!accessNote.trim() || accessNote.length > 2000) {
      throw new ResearchAssetError("Describe your right to use this file", 400);
    }
    const staged = await stageResearchAsset(dataDir, filename, c.req.raw.body);
    return c.json(await store.addAsset(studyId, sourceId, staged, accessNote), 201);
  });
  api.post("/studies/:studyId/sources/:sourceId/table-assets", async (c) => {
    const studyId = c.req.param("studyId");
    const sourceId = c.req.param("sourceId");
    const study = await store.getStudy(studyId);
    const source = study.sources.find((record) => record.id === sourceId);
    if (!source || source.kind !== "dataset") throw new ResearchRecordError("Choose a dataset source in this study");
    let filename: string;
    let accessNote: string;
    try {
      filename = decodeURIComponent(c.req.header("x-bp-filename") ?? "");
      accessNote = decodeURIComponent(c.req.header("x-bp-access-note") ?? "");
    } catch { throw new ResearchAssetError("Invalid file metadata", 400); }
    if (!filename.toLowerCase().endsWith(".csv")) throw new ResearchAssetError("Choose a UTF-8 CSV file", 400);
    if (!accessNote.trim() || accessNote.length > 2000) throw new ResearchAssetError("Describe your right to use this file", 400);
    const staged = await stageResearchAsset(dataDir, filename, c.req.raw.body, RESEARCH_CSV_MAX_BYTES);
    try {
      parseResearchCsv(await readFile(staged.path));
      return c.json(await store.addAsset(studyId, sourceId, staged, accessNote), 201);
    } finally {
      await unlink(staged.path).catch(() => {});
    }
  });
  api.get("/studies/:studyId/assets/:assetId/download", async (c) => {
    const { asset, bytes } = await store.readAsset(c.req.param("studyId"), c.req.param("assetId"));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  });
  api.get("/studies/:studyId/assets/:assetId/view", async (c) => {
    const { asset, bytes } = await store.readAsset(c.req.param("studyId"), c.req.param("assetId"));
    if (asset.mediaType !== "application/pdf") throw new ResearchRecordError("Only PDF files can be viewed inline");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  });
  api.get("/studies/:studyId/assets/:assetId/text", async (c) => {
    const { asset, bytes } = await store.readAsset(c.req.param("studyId"), c.req.param("assetId"));
    const section = Number(c.req.query("section") ?? "1");
    c.header("cache-control", "no-store");
    return c.json(await extractResearchText(asset, bytes, section));
  });
  api.get("/studies/:studyId/assets/:assetId/table-profile", async (c) => {
    const studyId = c.req.param("studyId");
    const { asset, bytes } = await store.readAsset(studyId, c.req.param("assetId"));
    const study = await store.getStudy(studyId);
    if (asset.mediaType !== "text/csv" || study.sources.find((record) => record.id === asset.sourceId)?.kind !== "dataset") {
      throw new ResearchRecordError("This file is not a dataset CSV");
    }
    c.header("cache-control", "no-store");
    return c.json(profileResearchCsv(parseResearchCsv(bytes), asset.id, asset.sha256));
  });
  api.post("/studies/:studyId/evidence/from-asset", async (c) => {
    const parsed = z.object({
      assetId: z.string().uuid(),
      section: z.number().int().positive(),
      segmentIndex: z.number().int().nonnegative(),
      start: z.number().int().nonnegative().optional(),
      end: z.number().int().positive().optional(),
      note: z.string().trim().max(20_000).default(""),
    }).strict().parse(await body(c));
    const studyId = c.req.param("studyId");
    const { asset, bytes } = await store.readAsset(studyId, parsed.assetId);
    const view = await extractResearchText(asset, bytes, parsed.section);
    const segment = view.segments[parsed.segmentIndex];
    if (!segment) throw new ResearchRecordError("Extracted text passage not found", 404);
    const quote = selectResearchQuote(segment, parsed.start, parsed.end);
    return c.json(await store.addEvidence(studyId, {
      sourceId: asset.sourceId, assetId: asset.id, kind: "source_excerpt",
      locator: quote.locator, content: quote.content, note: parsed.note,
    }, "extracted"), 201);
  });
  api.post("/studies/:studyId/evidence/manual-page", async (c) => {
    const parsed = ResearchManualPageCreateSchema.parse(await body(c));
    const studyId = c.req.param("studyId");
    const { asset, bytes } = await store.readAsset(studyId, parsed.assetId);
    if (asset.mediaType !== "application/pdf") throw new ResearchRecordError("Manual page transcription requires a PDF file");
    const pageCount = await countResearchPdfPages(bytes);
    return c.json(await store.addManualPageEvidence(studyId, parsed, pageCount), 201);
  });
  api.post("/studies/:studyId/evidence", async (c) => c.json(
    await store.addEvidence(c.req.param("studyId"), await body(c)), 201,
  ));
  api.post("/studies/:studyId/verifications", async (c) => c.json(
    await store.verifyEvidence(c.req.param("studyId"), await body(c), actor()), 201,
  ));
  api.post("/studies/:studyId/plans", async (c) => c.json(
    await store.addPlan(c.req.param("studyId"), await body(c), actor()), 201,
  ));
  api.post("/studies/:studyId/execution-links", async (c) => c.json(
    await store.addExecutionLink(c.req.param("studyId"), await body(c)), 201,
  ));
  api.get("/studies/:studyId/execution-links/status", async (c) => c.json({
    statuses: await store.getExecutionStatuses(c.req.param("studyId")),
  }));
  api.post("/studies/:studyId/cleaning-runs", async (c) => c.json(
    await store.addCleaningRun(c.req.param("studyId"), await body(c), actor()), 201,
  ));
  api.post("/studies/:studyId/analysis-runs", async (c) => c.json(
    await store.addAnalysisRun(c.req.param("studyId"), await body(c), actor()), 201,
  ));
  api.get("/studies/:studyId/analysis-runs/status", async (c) => c.json({
    statuses: await store.getAnalysisStatuses(c.req.param("studyId")),
  }));
  api.post("/studies/:studyId/claims", async (c) => c.json(
    await store.addClaim(c.req.param("studyId"), await body(c)), 201,
  ));
  api.post("/studies/:studyId/reports", async (c) => c.json(
    await store.addReport(c.req.param("studyId"), await body(c), actor()), 201,
  ));
  api.get("/studies/:studyId/reports/status", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ statuses: await store.getReportStatuses(c.req.param("studyId")) });
  });
  api.get("/studies/:studyId/reports/:reportId/download", async (c) => {
    const report = await store.getReport(c.req.param("studyId"), c.req.param("reportId"));
    return new Response(report.markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="research-report-v${report.version}-${report.id}.md"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  });
  api.get("/studies/:studyId/reports/:reportId/manifest", async (c) => {
    const studyId = c.req.param("studyId");
    const report = await store.getReport(studyId, c.req.param("reportId"));
    const currentStatus = (await store.getReportStatuses(studyId)).find((status) => status.reportId === report.id);
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    c.header("content-disposition", `attachment; filename="research-report-v${report.version}-${report.id}-manifest.json"`);
    return c.json({
      reportId: report.id, version: report.version, title: report.title,
      planVersionId: report.planVersionId, claimIds: report.claimIds,
      analysisRunIds: report.analysisRunIds, sha256: report.sha256,
      createdAt: report.createdAt, createdBy: report.createdBy, currentStatus,
    });
  });
  api.post("/studies/:studyId/decisions", async (c) => c.json(
    await store.decide(c.req.param("studyId"), await body(c), actor()), 201,
  ));
  return api;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname.toLowerCase() === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
