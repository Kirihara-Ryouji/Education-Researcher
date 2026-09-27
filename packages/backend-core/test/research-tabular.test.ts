import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Orchestrator } from "../src/orchestrator.js";

const spec = {
  title: "AI feedback and independent learning",
  question: "How is AI feedback associated with independent learning?",
  entry: "idea" as const,
};

interface Stats {
  n: number;
  mean: number | null;
  sampleSd: number | null;
  min: number | null;
  max: number | null;
}

interface Study {
  id: string;
  sources: Array<{ id: string }>;
  assets: Array<{ id: string; sha256: string; version: number }>;
  plans: Array<{ id: string }>;
  cleaningRuns: Array<{
    id: string;
    cleanedSha256: string;
    counts: {
      rawRows: number;
      includedRows: number;
      missingValueRows: number;
      invalidValueRows: number;
      missingGroupRows: number;
    };
  }>;
  analysisRuns: Array<{
    id: string;
    resultSha256: string;
    result: { overall: Stats; groups: Array<Stats & { group: string }> };
  }>;
  claims: Array<{ id: string }>;
}

interface Profile {
  assetId: string;
  sha256: string;
  rowCount: number;
  columns: Array<{ name: string; nonEmptyCount: number; numericCount: number }>;
}

function makeApp(root: string, env: Record<string, string> = { BP_LOCAL_MODE: "1", BP_DYNAMIC: "0" }) {
  let runtimeCalls = 0;
  const orchestrator: Orchestrator = {
    async ensureRuntime() { runtimeCalls++; throw new Error("Tabular analysis must not start Runtime"); },
    async health() { return true; },
    async stopRuntime() {},
  };
  const fetchFn = (async () => {
    runtimeCalls++;
    throw new Error("Tabular analysis must not make an external request");
  }) as typeof fetch;
  return {
    app: createApp({ dataDir: root, orchestrator, fetchFn, serveWeb: false, env }),
    runtimeCalls: () => runtimeCalls,
  };
}

type App = ReturnType<typeof makeApp>["app"];

function post(app: App, path: string, data: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function createdStudy(response: Response): Promise<Study> {
  expect(response.status).toBe(201);
  return response.json() as Promise<Study>;
}

async function setupStudy(app: App): Promise<{ study: Study; planId: string; sourceId: string }> {
  const projectResponse = await post(app, "/api/research/projects", { title: `Tabular project ${randomUUID()}` });
  expect(projectResponse.status).toBe(201);
  const project = await projectResponse.json() as { id: string };
  let study = await createdStudy(await post(app, `/api/research/projects/${project.id}/studies`, spec));
  study = await createdStudy(await post(app, `/api/research/studies/${study.id}/sources`, {
    title: "De-identified study table", kind: "dataset", origin: "observed",
    accessNote: "Researcher-provided local data for an exploratory analysis",
  }));
  const sourceId = study.sources.at(-1)!.id;
  study = await createdStudy(await post(app, `/api/research/studies/${study.id}/plans`, {
    content: "Summarize a numeric outcome by cohort, report exclusions and review the result.",
  }));
  const planId = study.plans.at(-1)!.id;
  study = await createdStudy(await post(app, `/api/research/studies/${study.id}/decisions`, {
    target: "plan", targetId: planId, decision: "accept", reason: "Approved for local descriptive analysis",
  }));
  return { study, planId, sourceId };
}

function uploadCsv(app: App, studyId: string, sourceId: string, body: string | Uint8Array, filename = "observations.csv") {
  return app.request(`/api/research/studies/${studyId}/sources/${sourceId}/table-assets`, {
    method: "POST",
    headers: {
      "content-type": "text/csv",
      "x-bp-filename": encodeURIComponent(filename),
      "x-bp-access-note": encodeURIComponent("Researcher supplied a local de-identified copy"),
    },
    body,
  });
}

async function clean(app: App, studyId: string, planVersionId: string, assetId: string, recipe: unknown) {
  return createdStudy(await post(app, `/api/research/studies/${studyId}/cleaning-runs`, {
    planVersionId, assetId, recipe, reason: "Reproducible descriptive analysis",
  }));
}

async function analyze(app: App, studyId: string, cleaningRunId: string) {
  return createdStudy(await post(app, `/api/research/studies/${studyId}/analysis-runs`, { cleaningRunId }));
}

async function analysisStatus(app: App, studyId: string, runId: string) {
  const response = await app.request(`/api/research/studies/${studyId}/analysis-runs/status`);
  expect(response.status).toBe(200);
  const payload = await response.json() as { statuses: Array<{ runId: string; status: string; reasons: string[] }> };
  const status = payload.statuses.find((item) => item.runId === runId);
  expect(status).toBeDefined();
  return status!;
}

describe("research tabular analysis", () => {
  it("requires a dataset source and an accepted current plan before running a table analysis", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-table-"));
    const { app } = makeApp(root);
    const projectResponse = await post(app, "/api/research/projects", { title: "Preconditions" });
    expect(projectResponse.status).toBe(201);
    const project = await projectResponse.json() as { id: string };
    let study = await createdStudy(await post(app, `/api/research/projects/${project.id}/studies`, spec));
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/sources`, {
      title: "Reading", kind: "document", origin: "curated",
    }));
    const wrongSource = await uploadCsv(app, study.id, study.sources.at(-1)!.id, "value\n1\n");
    expect(wrongSource.status).toBeGreaterThanOrEqual(400);
    expect(wrongSource.status).toBeLessThan(500);

    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/sources`, {
      title: "Study table", kind: "dataset", origin: "observed",
    }));
    study = await createdStudy(await uploadCsv(app, study.id, study.sources.at(-1)!.id, "value\n1\n2\n"));
    const assetId = study.assets.at(-1)!.id;
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/plans`, { content: "Summarize the table" }));
    const planId = study.plans.at(-1)!.id;
    const beforeApproval = await post(app, `/api/research/studies/${study.id}/cleaning-runs`, {
      planVersionId: planId, assetId, recipe: { valueColumn: "value" },
    });
    expect(beforeApproval.status).toBe(409);
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "plan", targetId: planId, decision: "accept", reason: "Approved",
    }));
    study = await clean(app, study.id, planId, assetId, { valueColumn: "value" });
    const cleaningRunId = study.cleaningRuns.at(-1)!.id;
    await createdStudy(await post(app, `/api/research/studies/${study.id}/plans`, {
      content: "A revised analysis plan", reason: "Review the exclusions",
    }));
    const stalePlan = await post(app, `/api/research/studies/${study.id}/analysis-runs`, { cleaningRunId });
    expect(stalePlan.status).toBe(409);
  });

  it("profiles UTF-8 CSV with a BOM, CRLF, quoted commas, escaped quotes and multiline cells", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-table-"));
    const { app, runtimeCalls } = makeApp(root);
    const { study, sourceId } = await setupStudy(app);
    const csv = '\uFEFFstudent,cohort,score,comment\r\n"ID-001","Group, A",10,"first\r\nline"\r\n"ID-002",B,,plain\r\n"ID-003",B,20,"say ""hello"""\r\n';
    const uploaded = await createdStudy(await uploadCsv(app, study.id, sourceId, csv));
    const asset = uploaded.assets.at(-1)!;
    const profileResponse = await app.request(`/api/research/studies/${study.id}/assets/${asset.id}/table-profile`);
    expect(profileResponse.status).toBe(200);
    const profile = await profileResponse.json() as Profile;
    expect(profile).toMatchObject({ assetId: asset.id, sha256: asset.sha256, rowCount: 3 });
    expect(profile.columns.map((column) => column.name)).toEqual(["student", "cohort", "score", "comment"]);
    expect(profile.columns.find((column) => column.name === "score")).toMatchObject({ nonEmptyCount: 2, numericCount: 2 });
    expect(JSON.stringify(profile)).not.toContain("ID-001");
    expect(runtimeCalls()).toBe(0);
  });

  it("rejects malformed or non-UTF-8 tables without creating an asset", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-table-"));
    const { app } = makeApp(root);
    const { study, sourceId } = await setupStudy(app);
    const invalid: Array<string | Uint8Array> = [
      "name,name\nAlice,1\n",
      "name,value\nAlice\n",
      "name,value\nAlice,1,extra\n",
      'name,value\n"unterminated,1\n',
      new Uint8Array([0xff, 0xfe, 0x2c, 0x31]),
    ];
    for (const body of invalid) {
      const response = await uploadCsv(app, study.id, sourceId, body);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    const saved = await app.request(`/api/research/studies/${study.id}`);
    expect(saved.status).toBe(200);
    expect((await saved.json() as Study).assets).toHaveLength(0);
  });

  it("records every exclusion and computes a finite, reproducible sample summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-table-"));
    const { app, runtimeCalls } = makeApp(root);
    const { study, planId, sourceId } = await setupStudy(app);
    const csv = "group,value\n A , 1 \nA,2\nB,n/a\nB,\nB,bad\nB,Infinity\nB,3\n,4\n";
    const uploaded = await createdStudy(await uploadCsv(app, study.id, sourceId, csv));
    const assetId = uploaded.assets.at(-1)!.id;
    const failed = await post(app, `/api/research/studies/${study.id}/cleaning-runs`, {
      planVersionId: planId, assetId, recipe: { valueColumn: "value", groupColumn: "group" },
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.status).toBeLessThan(500);
    expect((await (await app.request(`/api/research/studies/${study.id}`)).json() as Study).cleaningRuns).toHaveLength(0);

    const cleaned = await clean(app, study.id, planId, assetId, {
      valueColumn: "value", groupColumn: "group", invalidNumeric: "exclude",
    });
    const cleaning = cleaned.cleaningRuns.at(-1)!;
    expect(cleaning.counts).toEqual({
      rawRows: 8, includedRows: 3, missingValueRows: 2, invalidValueRows: 2, missingGroupRows: 1,
    });
    expect(cleaning.cleanedSha256).toMatch(/^[a-f0-9]{64}$/);

    const analyzed = await analyze(app, study.id, cleaning.id);
    const run = analyzed.analysisRuns.at(-1)!;
    expect(run.resultSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.result.overall).toMatchObject({ n: 3, mean: 2, sampleSd: 1, min: 1, max: 3 });
    expect(run.result.groups.map((group) => group.group)).toEqual(["A", "B"]);
    expect(run.result.groups[0]).toMatchObject({ n: 2, mean: 1.5, min: 1, max: 2 });
    expect(run.result.groups[0]!.sampleSd).toBeCloseTo(Math.sqrt(0.5));
    expect(run.result.groups[1]).toMatchObject({ n: 1, mean: 3, min: 3, max: 3 });
    expect(run.result.groups[1]!.sampleSd).toBeNull();
    expect(JSON.stringify(run.result)).not.toMatch(/NaN|Infinity/);

    // Reopening the app exercises persisted input and a fresh calculation.
    const reopened = makeApp(root);
    const repeated = await analyze(reopened.app, study.id, cleaning.id);
    const rerun = repeated.analysisRuns.at(-1)!;
    expect(rerun.result).toEqual(run.result);
    expect(rerun.resultSha256).toBe(run.resultSha256);
    expect(runtimeCalls()).toBe(0);
    expect(reopened.runtimeCalls()).toBe(0);
  });

  it("keeps old results but requires review after a newer source file or cleaning version", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-table-"));
    const { app } = makeApp(root);
    const { study, planId, sourceId } = await setupStudy(app);
    let updated = await createdStudy(await uploadCsv(app, study.id, sourceId, "cohort,score\nA,1\nA,2\n"));
    const firstAssetId = updated.assets.at(-1)!.id;
    updated = await clean(app, study.id, planId, firstAssetId, { valueColumn: "score", groupColumn: "cohort" });
    const firstCleanId = updated.cleaningRuns.at(-1)!.id;
    updated = await analyze(app, study.id, firstCleanId);
    const firstRunId = updated.analysisRuns.at(-1)!.id;
    expect(await analysisStatus(app, study.id, firstRunId)).toMatchObject({ status: "current", reasons: [] });

    // A new recipe supersedes the analysis, even if the original file still exists.
    updated = await clean(app, study.id, planId, firstAssetId, {
      valueColumn: "score", groupColumn: "cohort", trimWhitespace: false,
    });
    expect(updated.cleaningRuns).toHaveLength(2);
    expect((await analysisStatus(app, study.id, firstRunId)).status).toBe("needs_review");
    let claim = await createdStudy(await post(app, `/api/research/studies/${study.id}/claims`, {
      text: "The earlier table shows a mean score of 1.5", kind: "description", analysisRunIds: [firstRunId],
    }));
    expect((await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "claim", targetId: claim.claims.at(-1)!.id, decision: "accept", reason: "Reviewed",
    })).status).toBe(409);

    // A newer source version also invalidates a result tied to the previous bytes.
    updated = await analyze(app, study.id, updated.cleaningRuns.at(-1)!.id);
    const secondRunId = updated.analysisRuns.at(-1)!.id;
    expect((await analysisStatus(app, study.id, secondRunId)).status).toBe("current");
    await createdStudy(await uploadCsv(app, study.id, sourceId, "cohort,score\nA,5\nA,6\n"));
    expect((await analysisStatus(app, study.id, secondRunId)).status).toBe("needs_review");
    claim = await createdStudy(await post(app, `/api/research/studies/${study.id}/claims`, {
      text: "The previous dataset had a mean score of 1.5", kind: "description", analysisRunIds: [secondRunId],
    }));
    expect((await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "claim", targetId: claim.claims.at(-1)!.id, decision: "accept", reason: "Reviewed",
    })).status).toBe(409);
    expect((await (await app.request(`/api/research/studies/${study.id}`)).json() as Study).analysisRuns).toHaveLength(2);
  });

  it("rejects cross-study references and detects changed source bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-table-"));
    const { app } = makeApp(root);
    const first = await setupStudy(app);
    const second = await setupStudy(app);
    let updated = await createdStudy(await uploadCsv(app, first.study.id, first.sourceId, "group,value\nA,1\nA,2\n"));
    const assetId = updated.assets.at(-1)!.id;
    const wrongSource = await uploadCsv(app, second.study.id, first.sourceId, "group,value\nB,3\n");
    expect(wrongSource.status).toBeGreaterThanOrEqual(400);
    expect(wrongSource.status).toBeLessThan(500);
    const wrongAsset = await post(app, `/api/research/studies/${second.study.id}/cleaning-runs`, {
      planVersionId: second.planId, assetId, recipe: { valueColumn: "value" },
    });
    expect(wrongAsset.status).toBeGreaterThanOrEqual(400);
    expect(wrongAsset.status).toBeLessThan(500);

    updated = await clean(app, first.study.id, first.planId, assetId, { valueColumn: "value" });
    const cleaningRunId = updated.cleaningRuns.at(-1)!.id;
    const wrongCleaning = await post(app, `/api/research/studies/${second.study.id}/analysis-runs`, { cleaningRunId });
    expect(wrongCleaning.status).toBeGreaterThanOrEqual(400);
    expect(wrongCleaning.status).toBeLessThan(500);
    updated = await analyze(app, first.study.id, cleaningRunId);
    const runId = updated.analysisRuns.at(-1)!.id;
    const wrongClaim = await post(app, `/api/research/studies/${second.study.id}/claims`, {
      text: "A result from another study", kind: "description", analysisRunIds: [runId],
    });
    expect(wrongClaim.status).toBeGreaterThanOrEqual(400);
    expect(wrongClaim.status).toBeLessThan(500);

    await writeFile(join(root, "research", "assets", first.study.id, `${assetId}.bin`), "group,value\nA,999\nA,2\n");
    const profile = await app.request(`/api/research/studies/${first.study.id}/assets/${assetId}/table-profile`);
    expect(profile.ok).toBe(false);
    expect((await analysisStatus(app, first.study.id, runId)).status).not.toBe("current");
    const claim = await createdStudy(await post(app, `/api/research/studies/${first.study.id}/claims`, {
      text: "The source bytes have not changed", kind: "description", analysisRunIds: [runId],
    }));
    expect((await post(app, `/api/research/studies/${first.study.id}/decisions`, {
      target: "claim", targetId: claim.claims.at(-1)!.id, decision: "accept", reason: "Reviewed",
    })).status).toBe(409);
  });

  it("returns aggregates without raw rows and remains local-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-table-"));
    const { app, runtimeCalls } = makeApp(root);
    const { study, planId, sourceId } = await setupStudy(app);
    const secret = "SENSITIVE_PERSON_XYZ";
    const uploadedResponse = await uploadCsv(app, study.id, sourceId,
      `student_id,cohort,score\n${secret},A,10\nother_student,A,20\n`);
    const uploadedText = await uploadedResponse.text();
    expect(uploadedResponse.status).toBe(201);
    expect(uploadedText).not.toContain(secret);
    const uploaded = JSON.parse(uploadedText) as Study;
    const assetId = uploaded.assets.at(-1)!.id;
    const profileResponse = await app.request(`/api/research/studies/${study.id}/assets/${assetId}/table-profile`);
    const profileText = await profileResponse.text();
    expect(profileResponse.status).toBe(200);
    expect(profileText).not.toContain(secret);
    const cleaned = await clean(app, study.id, planId, assetId, { valueColumn: "score", groupColumn: "cohort" });
    expect(JSON.stringify(cleaned)).not.toContain(secret);
    const analyzed = await analyze(app, study.id, cleaned.cleaningRuns.at(-1)!.id);
    expect(JSON.stringify(analyzed)).not.toContain(secret);
    expect(analyzed.analysisRuns.at(-1)!.result.overall).toMatchObject({ n: 2, mean: 15 });
    expect(runtimeCalls()).toBe(0);

    const hosted = makeApp(root, { BP_LOCAL_MODE: "0", BP_DYNAMIC: "1" }).app;
    expect((await hosted.request("/api/research/projects")).status).toBe(404);
    expect((await uploadCsv(hosted, study.id, sourceId, "cohort,score\nA,1\n")).status).toBe(404);
  });
});
