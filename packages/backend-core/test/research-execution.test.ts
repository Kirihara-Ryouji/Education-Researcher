import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResearchExecutionLinkStatus, ResearchStudy } from "@brainpilot/protocol";
import { createApp } from "../src/app.js";
import type { Orchestrator } from "../src/orchestrator.js";
import { createServer } from "../../runtime/src/server.js";
import { mockAgentFactory } from "../../runtime/src/agent-factory.js";

const spec = {
  title: "Independent learning after AI feedback",
  question: "How does AI feedback relate to later independent learning?",
  entry: "idea" as const,
};
const sessionId = randomUUID();
const taskId = "task_000001";
const nodeId = "node_analysis_1";
const artifactId = "artifact_table_1";

interface MockNode {
  id: string;
  title: string;
  type: string;
  status: string;
  parents: unknown[];
  artifacts: Array<{ path: string; type: string }>;
  parentIds: string[];
  childIds: string[];
  toolCalls: string[];
  artifactIds: string[];
  executionResult: "completed" | "failed";
  revoked: boolean;
}

interface MockArtifact {
  id: string;
  producerNodeId: string;
  path: string;
  kind: string;
  type: string;
  checkpointId: string;
  blobHash: string;
  exists: "unknown" | "present" | "missing";
  verificationStatus: "reserved" | "unverified" | "verified" | "missing";
  role: "input" | "output" | "checkpoint" | "reference";
}

function mockRuntime() {
  const stamp = new Date().toISOString();
  const state = {
    online: true,
    sessionExists: true,
    session: { id: sessionId, title: "Analysis session", createdAt: stamp, updatedAt: stamp },
    tasks: [{
      id: taskId, seq: 1, created_by: "principal", assigned_to: "analyst",
      content: "Analyze the uploaded table", status: "replied", reply: "Analysis complete",
      created_at: Date.now(), completed_at: Date.now(),
    }],
    graph: {
      schemaVersion: "2.0" as const,
      revision: 2,
      meta: { sessionId },
      nodes: [{
        id: nodeId, title: "Table analysis", type: "analysis", status: "completed",
        parents: [], artifacts: [{ path: "results/table.csv", type: "file" }],
        parentIds: [], childIds: [], toolCalls: [], artifactIds: [artifactId],
        executionResult: "completed" as const, revoked: false,
      }] as MockNode[],
      dependencies: [],
      episodes: [],
      artifacts: [{
        id: artifactId, producerNodeId: nodeId, path: "results/table.csv",
        kind: "file", type: "file", checkpointId: "checkpoint_1", blobHash: "blob_v1",
        exists: "present" as const, verificationStatus: "verified" as const, role: "output" as const,
      }] as MockArtifact[],
    },
    calls: [] as string[],
  };
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    state.calls.push(url.pathname);
    if (!state.online) throw new Error("runtime connection lost");
    const prefix = `/sessions/${encodeURIComponent(sessionId)}`;
    if (!state.sessionExists || !url.pathname.startsWith(prefix)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (url.pathname === prefix) return Response.json(state.session);
    if (url.pathname === `${prefix}/trace`) return Response.json(state.graph);
    if (url.pathname === `${prefix}/tasks`) return Response.json({ tasks: state.tasks });
    return Response.json({ error: "unexpected runtime route" }, { status: 404 });
  }) as typeof fetch;
  return { state, fetchFn };
}

function makeApp(root: string, fetchFn: typeof fetch) {
  const orchestrator: Orchestrator = {
    async ensureRuntime() { return { baseUrl: "http://runtime.test" }; },
    async health() { return true; },
    async stopRuntime() {},
  };
  return createApp({
    dataDir: root, orchestrator, fetchFn, serveWeb: false,
    env: { BP_LOCAL_MODE: "1", BP_DYNAMIC: "0" },
  });
}

type App = ReturnType<typeof makeApp>;

function post(app: App, path: string, data: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
  });
}

async function createdStudy(response: Response): Promise<ResearchStudy> {
  expect(response.status).toBe(201);
  return response.json() as Promise<ResearchStudy>;
}

async function setupStudy(app: App, accepted = true): Promise<{ study: ResearchStudy; planId: string; projectId: string }> {
  const projectResponse = await post(app, "/api/research/projects", { title: "Execution linkage" });
  expect(projectResponse.status).toBe(201);
  const project = await projectResponse.json() as { id: string };
  let study = await createdStudy(await post(app, `/api/research/projects/${project.id}/studies`, spec));
  study = await createdStudy(await post(app, `/api/research/studies/${study.id}/plans`, { content: "Analyze the table and review the conclusion." }));
  const planId = study.plans.at(-1)!.id;
  if (accepted) {
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "plan", targetId: planId, decision: "accept", reason: "Ready for execution",
    }));
  }
  return { study, planId, projectId: project.id };
}

async function bind(
  app: App, studyId: string, planVersionId: string,
  target: { kind: "session" } | { kind: "task" | "trace_node" | "trace_artifact"; id: string },
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return post(app, `/api/research/studies/${studyId}/execution-links`, {
    planVersionId, sessionId, target, note: "Researcher selected this execution record", ...extra,
  });
}

async function statuses(app: App, studyId: string): Promise<ResearchExecutionLinkStatus[]> {
  const response = await app.request(`/api/research/studies/${studyId}/execution-links/status`);
  expect(response.status).toBe(200);
  return (await response.json() as { statuses: ResearchExecutionLinkStatus[] }).statuses;
}

function statusFor(items: ResearchExecutionLinkStatus[], id: string): ResearchExecutionLinkStatus {
  const found = items.find((item) => item.linkId === id);
  expect(found).toBeDefined();
  return found!;
}

describe("research execution links", () => {
  it("proxies the real Runtime Task Ledger snapshot and preserves unknown-session 404", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-execution-"));
    const runtime = createServer({ dataRoot: root, persist: false, agentFactory: mockAgentFactory });
    try {
      await runtime.manager.createSession({ id: sessionId });
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return runtime.app.request(`${url.pathname}${url.search}`, init);
      }) as typeof fetch;
      const app = makeApp(root, fetchFn);
      const response = await app.request(`/api/sessions/${sessionId}/tasks`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ tasks: runtime.manager.listTasks(sessionId) });
      const missing = await app.request(`/api/sessions/${randomUUID()}/tasks`);
      expect(missing.status).toBe(404);
    } finally {
      await runtime.manager.shutdownAndSave();
    }
  });

  it("binds only real Runtime objects and persists their captured snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-execution-"));
    const runtime = mockRuntime();
    const app = makeApp(root, runtime.fetchFn);
    const { study, planId } = await setupStudy(app);
    const targets = [
      { kind: "session" as const },
      { kind: "task" as const, id: taskId },
      { kind: "trace_node" as const, id: nodeId },
      { kind: "trace_artifact" as const, id: artifactId },
    ];
    let latest = study;
    for (const target of targets) latest = await createdStudy(await bind(app, study.id, planId, target));
    expect(latest.executionLinks).toHaveLength(targets.length);
    expect(latest.executionLinks.map((link) => link.target)).toEqual(targets);
    for (const link of latest.executionLinks) {
      expect(link).toMatchObject({ planVersionId: planId, sessionId, note: "Researcher selected this execution record" });
      expect(link.snapshot).toMatchObject({ sessionTitle: "Analysis session" });
      expect(link.snapshot.targetLabel.length).toBeGreaterThan(0);
      expect(link.snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(latest.executionLinks.find((link) => link.target.kind === "trace_artifact")?.snapshot.contentHash).toBe("blob_v1");
    expect((await statuses(app, study.id)).map((item) => item.status)).toEqual(targets.map(() => "current"));

    const reopened = makeApp(root, runtime.fetchFn);
    const saved = await reopened.request(`/api/research/studies/${study.id}`);
    expect(saved.status).toBe(200);
    expect((await saved.json() as ResearchStudy).executionLinks).toEqual(latest.executionLinks);
  });

  it("rejects unaccepted plans, nonexistent targets, and caller-supplied snapshot fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-execution-"));
    const runtime = mockRuntime();
    const app = makeApp(root, runtime.fetchFn);
    const { study, planId } = await setupStudy(app, false);
    expect((await bind(app, study.id, planId, { kind: "session" })).status).toBe(409);
    await createdStudy(await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "plan", targetId: planId, decision: "accept", reason: "Approved",
    }));
    expect((await bind(app, study.id, randomUUID(), { kind: "session" })).status).toBeGreaterThanOrEqual(400);
    expect((await bind(app, study.id, planId, { kind: "task", id: "task_missing" })).status).toBe(404);
    expect((await bind(app, study.id, planId, { kind: "trace_node", id: "node_missing" })).status).toBe(404);
    expect((await bind(app, study.id, planId, { kind: "trace_artifact", id: "artifact_missing" })).status).toBe(404);
    runtime.state.sessionExists = false;
    expect((await bind(app, study.id, planId, { kind: "session" })).status).toBe(404);
    runtime.state.sessionExists = true;
    expect((await bind(app, study.id, planId, { kind: "session" }, {
      snapshot: { sessionTitle: "Forged", targetLabel: "Forged", fingerprint: "0".repeat(64) },
    })).status).toBe(400);
    expect((await bind(app, study.id, planId, { kind: "session" }, { id: randomUUID() })).status).toBe(400);
    const saved = await app.request(`/api/research/studies/${study.id}`);
    expect((await saved.json() as ResearchStudy).executionLinks).toHaveLength(0);
  });

  it("marks a linked execution for review when its study definition or plan changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-execution-"));
    const runtime = mockRuntime();
    const app = makeApp(root, runtime.fetchFn);
    const { study, planId } = await setupStudy(app);
    const linked = await createdStudy(await bind(app, study.id, planId, { kind: "session" }));
    const linkId = linked.executionLinks[0]!.id;
    await createdStudy(await post(app, `/api/research/studies/${study.id}/specs`, {
      spec: { ...spec, question: "Does AI feedback change persistence?" }, reason: "Question refined",
    }));
    expect(statusFor(await statuses(app, study.id), linkId)).toMatchObject({
      status: "needs_review", reasons: expect.arrayContaining(["study_definition_changed"]),
    });
    await createdStudy(await post(app, `/api/research/studies/${study.id}/plans`, {
      content: "Analyze the revised question.", reason: "Definition changed",
    }));
    expect(statusFor(await statuses(app, study.id), linkId)).toMatchObject({
      status: "needs_review", reasons: expect.arrayContaining(["plan_changed"]),
    });
  });

  it("reviews a session link after the Runtime records new session activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-execution-"));
    const runtime = mockRuntime();
    const app = makeApp(root, runtime.fetchFn);
    const { study, planId } = await setupStudy(app);
    const linked = await createdStudy(await bind(app, study.id, planId, { kind: "session" }));
    const linkId = linked.executionLinks[0]!.id;
    expect(statusFor(await statuses(app, study.id), linkId).status).toBe("current");

    // The session ID stays fixed while Runtime updates updatedAt on new work.
    runtime.state.session.updatedAt = new Date(Date.now() + 60_000).toISOString();
    expect(statusFor(await statuses(app, study.id), linkId)).toMatchObject({
      status: "needs_review", reasons: expect.arrayContaining(["runtime_target_changed"]),
    });
    const claim = await createdStudy(await post(app, `/api/research/studies/${study.id}/claims`, {
      text: "The linked session produced the result", kind: "description", executionLinkIds: [linkId],
    }));
    expect((await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "claim", targetId: claim.claims[0]!.id, decision: "accept", reason: "Ready",
    })).status).toBe(409);
  });

  it("links only present, verified Runtime output artifacts and invalidates one that loses verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-execution-"));
    const runtime = mockRuntime();
    const app = makeApp(root, runtime.fetchFn);
    const { study, planId } = await setupStudy(app);
    const artifact = runtime.state.graph.artifacts[0]!;
    for (const invalid of [
      { role: "input" as const },
      { role: "reference" as const },
      { exists: "unknown" as const },
      { verificationStatus: "reserved" as const },
      { verificationStatus: "unverified" as const },
    ]) {
      Object.assign(artifact, invalid);
      expect((await bind(app, study.id, planId, { kind: "trace_artifact", id: artifactId })).status).toBe(404);
      Object.assign(artifact, { role: "output", exists: "present", verificationStatus: "verified" });
    }

    const linked = await createdStudy(await bind(app, study.id, planId, { kind: "trace_artifact", id: artifactId }));
    const linkId = linked.executionLinks[0]!.id;
    expect(statusFor(await statuses(app, study.id), linkId).status).toBe("current");
    artifact.verificationStatus = "unverified";
    expect(statusFor(await statuses(app, study.id), linkId)).toMatchObject({
      status: "unavailable", reasons: expect.arrayContaining(["runtime_target_missing"]),
    });
  });

  it("marks an execution for review when a referenced source gets a new file version", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-execution-"));
    const runtime = mockRuntime();
    const app = makeApp(root, runtime.fetchFn);
    const project = await post(app, "/api/research/projects", { title: "Versioned materials" });
    const projectId = (await project.json() as { id: string }).id;
    let study = await createdStudy(await post(app, `/api/research/projects/${projectId}/studies`, spec));
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/sources`, {
      title: "Learning record", kind: "document", origin: "curated",
    }));
    const sourceId = study.sources[0]!.id;
    const upload = (content: string) => app.request(`/api/research/studies/${study.id}/sources/${sourceId}/assets`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-bp-filename": encodeURIComponent("record.txt"),
        "x-bp-access-note": encodeURIComponent("Researcher supplied the file"),
      },
      body: content,
    });
    study = await createdStudy(await upload("First file version"));
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/evidence`, {
      sourceId, assetId: study.assets[0]!.id, kind: "source_excerpt", locator: "line 1", content: "First file version",
    }));
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/plans`, {
      content: "Use the learning record", evidenceIds: [study.evidence[0]!.id],
    }));
    const planId = study.plans[0]!.id;
    await createdStudy(await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "plan", targetId: planId, decision: "accept", reason: "Approved",
    }));
    const linked = await createdStudy(await bind(app, study.id, planId, { kind: "session" }));
    const linkId = linked.executionLinks[0]!.id;
    await createdStudy(await upload("Second file version"));
    expect(statusFor(await statuses(app, study.id), linkId)).toMatchObject({
      status: "needs_review", reasons: expect.arrayContaining(["source_version_changed"]),
    });
    const claim = await createdStudy(await post(app, `/api/research/studies/${study.id}/claims`, {
      text: "The learning record supports the result", kind: "interpretation", executionLinkIds: [linkId],
    }));
    expect((await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "claim", targetId: claim.claims[0]!.id, decision: "accept", reason: "Ready",
    })).status).toBe(409);
  });

  it("detects changed or missing Trace targets and prevents accepting a stale claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-execution-"));
    const runtime = mockRuntime();
    const app = makeApp(root, runtime.fetchFn);
    const { study, planId } = await setupStudy(app);
    let linked = await createdStudy(await bind(app, study.id, planId, { kind: "trace_node", id: nodeId }));
    linked = await createdStudy(await bind(app, study.id, planId, { kind: "trace_artifact", id: artifactId }));
    const nodeLink = linked.executionLinks[0]!;
    const artifactLink = linked.executionLinks[1]!;
    runtime.state.graph.revision += 1;
    runtime.state.graph.nodes[0]!.title = "Revised table analysis";
    runtime.state.graph.artifacts[0]!.blobHash = "blob_v2";
    const changed = await statuses(app, study.id);
    expect(statusFor(changed, nodeLink.id)).toMatchObject({
      status: "needs_review", reasons: expect.arrayContaining(["runtime_target_changed"]),
    });
    expect(statusFor(changed, artifactLink.id)).toMatchObject({
      status: "needs_review", reasons: expect.arrayContaining(["runtime_target_changed"]),
    });
    const claim = await createdStudy(await post(app, `/api/research/studies/${study.id}/claims`, {
      text: "AI feedback was associated with later persistence", kind: "association",
      executionLinkIds: [nodeLink.id, artifactLink.id],
    }));
    expect((await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "claim", targetId: claim.claims[0]!.id, decision: "accept", reason: "Ready",
    })).status).toBe(409);
    runtime.state.graph.nodes = [];
    runtime.state.graph.artifacts = [];
    expect(statusFor(await statuses(app, study.id), nodeLink.id)).toMatchObject({
      status: "unavailable", reasons: expect.arrayContaining(["runtime_target_missing"]),
    });
  });

  it("reviews an unhashed Trace target on revision alone but keeps a hashed artifact current", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-execution-"));
    const runtime = mockRuntime();
    const app = makeApp(root, runtime.fetchFn);
    const { study, planId } = await setupStudy(app);
    let linked = await createdStudy(await bind(app, study.id, planId, { kind: "trace_node", id: nodeId }));
    linked = await createdStudy(await bind(app, study.id, planId, { kind: "trace_artifact", id: artifactId }));
    const nodeLink = linked.executionLinks[0]!;
    const artifactLink = linked.executionLinks[1]!;
    expect(nodeLink.snapshot.contentHash).toBeUndefined();
    expect(artifactLink.snapshot.contentHash).toBe("blob_v1");

    runtime.state.graph.revision += 1;
    const revised = await statuses(app, study.id);
    expect(statusFor(revised, nodeLink.id)).toMatchObject({
      status: "needs_review", reasons: expect.arrayContaining(["runtime_trace_changed"]),
    });
    expect(statusFor(revised, artifactLink.id)).toMatchObject({ status: "current", reasons: [] });

    runtime.state.graph.nodes[0]!.revoked = true;
    const revoked = await statuses(app, study.id);
    for (const linkId of [nodeLink.id, artifactLink.id]) {
      expect(statusFor(revoked, linkId)).toMatchObject({
        status: "unavailable", reasons: expect.arrayContaining(["runtime_target_missing"]),
      });
    }
  });

  it("rejects a Trace whose session identity does not match the requested session", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-execution-"));
    const runtime = mockRuntime();
    const app = makeApp(root, runtime.fetchFn);
    const { study, planId } = await setupStudy(app);
    runtime.state.graph.meta.sessionId = randomUUID();
    expect((await bind(app, study.id, planId, { kind: "trace_node", id: nodeId })).status).toBe(503);
    const saved = await app.request(`/api/research/studies/${study.id}`);
    expect((await saved.json() as ResearchStudy).executionLinks).toHaveLength(0);
  });

  it("reports Runtime outages without treating a cached snapshot as current", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-execution-"));
    const runtime = mockRuntime();
    const app = makeApp(root, runtime.fetchFn);
    const { study, planId } = await setupStudy(app);
    const linked = await createdStudy(await bind(app, study.id, planId, { kind: "session" }));
    runtime.state.online = false;
    expect(statusFor(await statuses(app, study.id), linked.executionLinks[0]!.id)).toMatchObject({
      status: "unavailable", reasons: expect.arrayContaining(["runtime_unavailable"]),
    });
    const claim = await createdStudy(await post(app, `/api/research/studies/${study.id}/claims`, {
      text: "The analysis produced a result", kind: "description", executionLinkIds: [linked.executionLinks[0]!.id],
    }));
    expect((await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "claim", targetId: claim.claims[0]!.id, decision: "accept", reason: "Looks complete",
    })).status).toBe(409);
  });

  it("rejects cross-study claim references and duplicate bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-execution-"));
    const runtime = mockRuntime();
    const app = makeApp(root, runtime.fetchFn);
    const first = await setupStudy(app);
    const second = await setupStudy(app);
    const linked = await createdStudy(await bind(app, first.study.id, first.planId, { kind: "session" }));
    const link = linked.executionLinks[0]!;
    expect((await bind(app, first.study.id, first.planId, { kind: "session" }, { note: "Different note" })).status).toBe(409);
    expect((await bind(app, second.study.id, first.planId, { kind: "session" })).status).toBeGreaterThanOrEqual(400);
    expect((await post(app, `/api/research/studies/${second.study.id}/claims`, {
      text: "A cross-study claim", kind: "interpretation", executionLinkIds: [link.id],
    })).status).toBe(400);
    const saved = await app.request(`/api/research/studies/${first.study.id}`);
    expect((await saved.json() as ResearchStudy).executionLinks).toHaveLength(1);
  });
});
