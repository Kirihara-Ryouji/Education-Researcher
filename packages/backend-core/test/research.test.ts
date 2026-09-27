import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { staleEvidenceIds, type ResearchStudy } from "@brainpilot/protocol";
import { createApp } from "../src/app.js";
import { stageResearchAsset } from "../src/research-asset-upload.js";
import { ResearchStore } from "../src/research-store.js";
import { samplePdf } from "./research-pdf-fixture.js";

const spec = {
  title: "AI feedback and independent learning",
  question: "How is AI feedback associated with later independent learning?",
  entry: "idea" as const,
};

describe("research business records", () => {
  it("persists a project and versioned plan separately from runtime sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-"));
    const store = new ResearchStore(root);
    const project = await store.createProject({ title: "Education AI" });
    let study = await store.createStudy(project.id, spec, "researcher-1");
    study = await store.addPlan(study.id, { content: "Compare outcomes and report limits." }, "researcher-1");
    const firstPlan = study.plans[0]!;
    study = await store.decide(study.id, { target: "plan", targetId: firstPlan.id, decision: "accept", reason: "Approved for exploratory analysis" }, "researcher-1");
    expect(study.decisions[0]).toMatchObject({ actorId: "researcher-1", targetId: firstPlan.id });

    const reopened = new ResearchStore(root);
    expect((await reopened.getStudy(study.id)).plans).toHaveLength(1);
    const revised = await reopened.addPlan(study.id, { content: "Use a held-out sample.", reason: "New data arrived" }, "researcher-1");
    expect(revised.plans.map((plan) => plan.version)).toEqual([1, 2]);
    await expect(reopened.decide(study.id, { target: "plan", targetId: firstPlan.id, decision: "return", reason: "Outdated" }, "researcher-1"))
      .rejects.toMatchObject({ status: 409 });
  });

  it("keeps source provenance and rejects cross-study evidence links", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-"));
    const store = new ResearchStore(root);
    const project = await store.createProject({ title: "Evidence" });
    const a = await store.createStudy(project.id, spec, "local");
    const b = await store.createStudy(project.id, { ...spec, title: "Other study" }, "local");
    const withSource = await store.addSource(a.id, { title: "Interview transcript", kind: "interview", origin: "observed", locator: "transcript-1" });
    const source = withSource.sources[0]!;
    await expect(store.addEvidence(b.id, { sourceId: source.id, kind: "source_excerpt", locator: "line 4", content: "A passage" }))
      .rejects.toMatchObject({ status: 400 });
    const withEvidence = await store.addEvidence(a.id, { sourceId: source.id, kind: "source_excerpt", locator: "line 4", content: "A passage" });
    expect(withEvidence.evidence[0]).toMatchObject({ verification: "unverified", captureMethod: "manual", sourceId: source.id });
    const verified = await store.verifyEvidence(a.id, { evidenceId: withEvidence.evidence[0]!.id, level: "content_checked", reason: "Compared with the transcript" }, "researcher-2");
    expect(verified.evidence[0]?.verification).toBe("content_checked");
    expect(verified.verifications[0]).toMatchObject({ actorId: "researcher-2", reason: "Compared with the transcript" });
    await expect(store.addClaim(b.id, { text: "A claim", kind: "interpretation", evidence: [{ evidenceId: withEvidence.evidence[0]!.id, relation: "supports" }] }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("requires a new plan when the research question changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-"));
    const store = new ResearchStore(root);
    const project = await store.createProject({ title: "Version check" });
    let study = await store.createStudy(project.id, spec, "local");
    study = await store.addPlan(study.id, { content: "Initial design" }, "local");
    const planId = study.plans[0]!.id;
    study = await store.reviseStudy(study.id, { spec: { ...spec, question: "A revised question" }, reason: "Scope changed" }, "local");
    expect(study.plans[0]!.specVersionId).not.toBe(study.specs.at(-1)!.id);
    await expect(store.decide(study.id, { target: "plan", targetId: planId, decision: "accept", reason: "Looks fine" }, "local"))
      .rejects.toMatchObject({ status: 409 });
  });

  it("fails closed when the persisted business state is corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-"));
    await mkdir(join(root, "research"));
    await writeFile(join(root, "research", "research-v1.json"), "{bad json");
    await expect(new ResearchStore(root).listProjects()).rejects.toThrow();
    const orchestrator = { ensureRuntime: async () => ({ baseUrl: "http://unused" }), health: async () => true, stopRuntime: async () => {} };
    const app = createApp({ dataDir: root, orchestrator, serveWeb: false, env: { BP_LOCAL_MODE: "1" } });
    expect((await app.request("/api/research/projects")).status).toBe(500);
  });

  it("reads earlier evidence records as manually entered when capture method is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-"));
    const store = new ResearchStore(root);
    const project = await store.createProject({ title: "Migration" });
    let study = await store.createStudy(project.id, spec, "local");
    study = await store.addSource(study.id, { title: "Source", kind: "document", origin: "curated" });
    study = await store.addEvidence(study.id, { sourceId: study.sources[0]!.id, kind: "source_excerpt", locator: "line 1", content: "Original" });
    const file = join(root, "research", "research-v1.json");
    const state = JSON.parse(await readFile(file, "utf8")) as { studies: Array<{ evidence: Array<Record<string, unknown>> }> };
    delete state.studies[0]!.evidence[0]!.captureMethod;
    await writeFile(file, JSON.stringify(state));
    expect((await new ResearchStore(root).getStudy(study.id)).evidence[0]?.captureMethod).toBe("manual");
  });

  it("exposes the local API and disables it for hosted mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-"));
    const orchestrator = { ensureRuntime: async () => ({ baseUrl: "http://unused" }), health: async () => true, stopRuntime: async () => {} };
    const app = createApp({ dataDir: root, orchestrator, serveWeb: false, env: { BP_LOCAL_MODE: "1" } });
    const created = await app.request("/api/research/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "A project" }) });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const study = await app.request(`/api/research/projects/${project.id}/studies`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
    expect(study.status).toBe(201);
    const listed = await app.request("/api/research/projects");
    expect((await listed.json() as { projects: unknown[] }).projects).toHaveLength(1);

    const hosted = createApp({ dataDir: root, orchestrator, serveWeb: false, env: { BP_LOCAL_MODE: "0" } });
    expect((await hosted.request("/api/research/projects")).status).toBe(404);
  });

  it("uploads immutable file versions and blocks acceptance of stale evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-"));
    const orchestrator = { ensureRuntime: async () => ({ baseUrl: "http://unused" }), health: async () => true, stopRuntime: async () => {} };
    const app = createApp({ dataDir: root, orchestrator, serveWeb: false, env: { BP_LOCAL_MODE: "1" } });
    const store = new ResearchStore(root);
    const project = await store.createProject({ title: "Files" });
    let study = await store.createStudy(project.id, spec, "local");
    study = await store.addSource(study.id, { title: "Reading", kind: "publication", origin: "curated" });
    const sourceId = study.sources[0]!.id;
    const upload = async (content: string) => app.request(`/api/research/studies/${study.id}/sources/${sourceId}/assets`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-bp-filename": "reading.txt", "x-bp-access-note": "Locally owned copy" },
      body: content,
    });
    const first = await upload("First version");
    expect(first.status).toBe(201);
    study = await first.json() as ResearchStudy;
    expect(study.assets[0]).toMatchObject({ version: 1, filename: "reading.txt", sizeBytes: 13 });
    expect(study.assets[0]!.sha256).toBe(createHash("sha256").update("First version").digest("hex"));
    expect((await upload("First version")).status).toBe(201);
    expect((await store.getStudy(study.id)).assets).toHaveLength(1);
    const assetId = study.assets[0]!.id;
    const downloaded = await app.request(`/api/research/studies/${study.id}/assets/${assetId}/download`);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe("First version");
    expect(downloaded.headers.get("content-disposition")).toContain("reading.txt");

    study = await store.addEvidence(study.id, { sourceId, assetId, kind: "source_excerpt", locator: "paragraph 1", content: "First version" });
    const evidenceId = study.evidence[0]!.id;
    study = await store.addSource(study.id, { title: "Other source", kind: "document", origin: "curated" });
    await expect(store.addEvidence(study.id, { sourceId: study.sources[1]!.id, assetId, kind: "source_excerpt", locator: "paragraph 1", content: "Wrong file" }))
      .rejects.toMatchObject({ status: 400 });
    study = await store.addPlan(study.id, { content: "Plan based on reading", evidenceIds: [evidenceId] }, "local");
    const planId = study.plans[0]!.id;
    study = await (await upload("Second version")).json() as ResearchStudy;
    expect(study.assets.map((asset) => asset.version)).toEqual([1, 2]);
    expect(staleEvidenceIds(study).has(evidenceId)).toBe(true);
    await expect(store.decide(study.id, { target: "plan", targetId: planId, decision: "accept", reason: "Reviewed" }, "local"))
      .rejects.toMatchObject({ status: 409 });
    study = await store.addClaim(study.id, { text: "A claim", kind: "description", evidence: [{ evidenceId, relation: "supports" }] });
    await expect(store.decide(study.id, { target: "claim", targetId: study.claims[0]!.id, decision: "accept", reason: "Reviewed" }, "local"))
      .rejects.toMatchObject({ status: 409 });
  });

  it("rejects invalid and oversized uploads without storing a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-"));
    const orchestrator = { ensureRuntime: async () => ({ baseUrl: "http://unused" }), health: async () => true, stopRuntime: async () => {} };
    const app = createApp({ dataDir: root, orchestrator, serveWeb: false, env: { BP_LOCAL_MODE: "1" } });
    const store = new ResearchStore(root);
    const project = await store.createProject({ title: "Files" });
    let study = await store.createStudy(project.id, spec, "local");
    study = await store.addSource(study.id, { title: "Source", kind: "document", origin: "curated" });
    const response = await app.request(`/api/research/studies/${study.id}/sources/${study.sources[0]!.id}/assets`, {
      method: "POST", headers: { "x-bp-filename": "bad.pdf", "x-bp-access-note": "Permission granted" }, body: "not a PDF",
    });
    expect(response.status).toBe(400);
    const invalidText = await app.request(`/api/research/studies/${study.id}/sources/${study.sources[0]!.id}/assets`, {
      method: "POST", headers: { "x-bp-filename": "bad.txt", "x-bp-access-note": "Permission granted" },
      body: new Uint8Array([0xff, 0xfe]),
    });
    expect(invalidText.status).toBe(400);
    expect((await store.getStudy(study.id)).assets).toHaveLength(0);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("too long")); controller.close(); } });
    await expect(stageResearchAsset(root, "notes.txt", stream, 3)).rejects.toMatchObject({ status: 413 });
  });

  it("refuses to download a file whose stored bytes no longer match its checksum", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-"));
    const store = new ResearchStore(root);
    const project = await store.createProject({ title: "Integrity" });
    let study = await store.createStudy(project.id, spec, "local");
    study = await store.addSource(study.id, { title: "Notes", kind: "document", origin: "curated" });
    const staged = await stageResearchAsset(root, "notes.txt", new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("Original")); controller.close(); },
    }));
    study = await store.addAsset(study.id, study.sources[0]!.id, staged, "Owned notes");
    const assetId = study.assets[0]!.id;
    await writeFile(join(root, "research", "assets", study.id, `${assetId}.bin`), "Changed");
    await expect(store.readAsset(study.id, assetId)).rejects.toThrow("Research state could not be read");
  });

  it("records an exact passage from a checked file version", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-"));
    const orchestrator = { ensureRuntime: async () => ({ baseUrl: "http://unused" }), health: async () => true, stopRuntime: async () => {} };
    const app = createApp({ dataDir: root, orchestrator, serveWeb: false, env: { BP_LOCAL_MODE: "1" } });
    const store = new ResearchStore(root);
    const project = await store.createProject({ title: "Passages" });
    let study = await store.createStudy(project.id, spec, "local");
    study = await store.addSource(study.id, { title: "Local notes", kind: "document", origin: "curated" });
    const sourceId = study.sources[0]!.id;
    const staged = await stageResearchAsset(root, "notes.md", new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("First line\nSecond line")); controller.close(); },
    }));
    study = await store.addAsset(study.id, sourceId, staged, "Owned notes");
    const assetId = study.assets[0]!.id;
    const viewResponse = await app.request(`/api/research/studies/${study.id}/assets/${assetId}/text?section=1`);
    expect(viewResponse.status).toBe(200);
    expect((await viewResponse.json() as { segments: Array<{ locator: string }> }).segments[1]?.locator).toBe("text:l2");
    const created = await app.request(`/api/research/studies/${study.id}/evidence/from-asset`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId, section: 1, segmentIndex: 1, start: 0, end: 6 }),
    });
    expect(created.status).toBe(201);
    study = await created.json() as ResearchStudy;
    expect(study.evidence[0]).toMatchObject({ sourceId, assetId, locator: "text:l2:u160-6", content: "Second", kind: "source_excerpt", captureMethod: "extracted", verification: "unverified" });
    const invalidRange = await app.request(`/api/research/studies/${study.id}/evidence/from-asset`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId, section: 1, segmentIndex: 1, start: 0, end: 100 }),
    });
    expect(invalidRange.status).toBe(400);
    const forged = await app.request(`/api/research/studies/${study.id}/evidence/from-asset`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId, section: 1, segmentIndex: 99 }),
    });
    expect(forged.status).toBe(404);
    expect((await store.getStudy(study.id)).evidence).toHaveLength(1);
  });

  it("keeps a scanned PDF page transcription distinct and checks the real page count", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-"));
    const orchestrator = { ensureRuntime: async () => ({ baseUrl: "http://unused" }), health: async () => true, stopRuntime: async () => {} };
    const app = createApp({ dataDir: root, orchestrator, serveWeb: false, env: { BP_LOCAL_MODE: "1" } });
    const store = new ResearchStore(root);
    const project = await store.createProject({ title: "Scans" });
    let study = await store.createStudy(project.id, spec, "local");
    study = await store.addSource(study.id, { title: "Scanned report", kind: "publication", origin: "curated" });
    const sourceId = study.sources[0]!.id;
    const pdf = samplePdf("");
    const staged = await stageResearchAsset(root, "scan.pdf", new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(pdf); controller.close(); },
    }));
    study = await store.addAsset(study.id, sourceId, staged, "Library access");
    const assetId = study.assets[0]!.id;
    const original = await app.request(`/api/research/studies/${study.id}/assets/${assetId}/view`);
    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toBe("application/pdf");
    expect(original.headers.get("content-disposition")).toContain("inline");
    const manual = (page: number) => app.request(`/api/research/studies/${study.id}/evidence/manual-page`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId, page, content: "Figure text transcribed by researcher", note: "Checked the PDF image" }),
    });
    expect((await manual(2)).status).toBe(400);
    const created = await manual(1);
    expect(created.status).toBe(201);
    study = await created.json() as ResearchStudy;
    expect(study.evidence[0]).toMatchObject({ sourceId, assetId, kind: "manual_transcription", captureMethod: "transcribed", locator: "pdf:p1:manual", verification: "unverified" });
    const forged = await app.request(`/api/research/studies/${study.id}/evidence`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId, assetId, kind: "manual_transcription", locator: "pdf:p100:manual", content: "Forged" }),
    });
    expect(forged.status).toBe(400);
    expect((await store.getStudy(study.id)).evidence).toHaveLength(1);
  });
});
