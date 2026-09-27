import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Orchestrator } from "../src/orchestrator.js";

const spec = { title: "Two dataset study", question: "How do two datasets compare?", entry: "idea" as const };
type App = ReturnType<typeof createApp>;
type Study = {
  id: string;
  sources: Array<{ id: string }>;
  assets: Array<{ id: string }>;
  plans: Array<{ id: string }>;
  cleaningRuns: Array<{ id: string; assetId: string }>;
  analysisRuns: Array<{ id: string }>;
  claims: Array<{ id: string }>;
};

function post(app: App, path: string, data: unknown): Promise<Response> {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
}

async function created(response: Response): Promise<Study> {
  expect(response.status).toBe(201);
  return response.json() as Promise<Study>;
}

async function upload(app: App, studyId: string, sourceId: string, csv: string): Promise<Study> {
  return created(await app.request(`/api/research/studies/${studyId}/sources/${sourceId}/table-assets`, {
    method: "POST",
    headers: {
      "content-type": "text/csv",
      "x-bp-filename": encodeURIComponent("table.csv"),
      "x-bp-access-note": encodeURIComponent("Locally supplied research data"),
    },
    body: csv,
  }));
}

async function status(app: App, studyId: string, runId: string) {
  const response = await app.request(`/api/research/studies/${studyId}/analysis-runs/status`);
  expect(response.status).toBe(200);
  const body = await response.json() as { statuses: Array<{ runId: string; status: string; reasons: string[] }> };
  return body.statuses.find((entry) => entry.runId === runId);
}

describe("independent cleaning versions for multiple datasets", () => {
  it("keeps A current after cleaning B, then supersedes A only when A is cleaned again", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-multi-dataset-"));
    const orchestrator: Orchestrator = {
      async ensureRuntime() { throw new Error("Unexpected Runtime call"); },
      async health() { return true; },
      async stopRuntime() {},
    };
    const fetchFn = (async () => { throw new Error("Unexpected external request"); }) as typeof fetch;
    const app = createApp({ dataDir: root, orchestrator, fetchFn, serveWeb: false,
      env: { BP_LOCAL_MODE: "1", BP_DYNAMIC: "0" } });
    const projectResponse = await post(app, "/api/research/projects", { title: `Two datasets ${randomUUID()}` });
    expect(projectResponse.status).toBe(201);
    const project = await projectResponse.json() as { id: string };
    let study = await created(await post(app, `/api/research/projects/${project.id}/studies`, spec));
    study = await created(await post(app, `/api/research/studies/${study.id}/sources`, {
      title: "Dataset A", kind: "dataset", origin: "observed", accessNote: "Local copy",
    }));
    const sourceA = study.sources.at(-1)!.id;
    study = await created(await post(app, `/api/research/studies/${study.id}/sources`, {
      title: "Dataset B", kind: "dataset", origin: "observed", accessNote: "Local copy",
    }));
    const sourceB = study.sources.at(-1)!.id;
    study = await created(await post(app, `/api/research/studies/${study.id}/plans`, {
      content: "Describe each dataset separately and report the exclusions.",
    }));
    const planId = study.plans.at(-1)!.id;
    study = await created(await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "plan", targetId: planId, decision: "accept", reason: "Approved",
    }));
    study = await upload(app, study.id, sourceA, "value\n1\n2\n");
    const assetA = study.assets.at(-1)!.id;
    study = await upload(app, study.id, sourceB, "value\n8\n9\n");
    const assetB = study.assets.at(-1)!.id;

    const firstRecipe = { valueColumn: "value", missingTokens: ["", "NA", "N/A"] };
    study = await created(await post(app, `/api/research/studies/${study.id}/cleaning-runs`, {
      planVersionId: planId, assetId: assetA, recipe: firstRecipe,
    }));
    const cleanA1 = study.cleaningRuns.at(-1)!.id;
    study = await created(await post(app, `/api/research/studies/${study.id}/analysis-runs`, { cleaningRunId: cleanA1 }));
    const runA1 = study.analysisRuns.at(-1)!.id;
    expect(await status(app, study.id, runA1)).toMatchObject({ status: "current", reasons: [] });

    study = await created(await post(app, `/api/research/studies/${study.id}/cleaning-runs`, {
      planVersionId: planId, assetId: assetB, recipe: { valueColumn: "value" },
    }));
    const cleanB = study.cleaningRuns.at(-1)!.id;
    expect(await status(app, study.id, runA1)).toMatchObject({ status: "current", reasons: [] });
    study = await created(await post(app, `/api/research/studies/${study.id}/analysis-runs`, { cleaningRunId: cleanA1 }));
    const runA2 = study.analysisRuns.at(-1)!.id;
    expect(await status(app, study.id, runA2)).toMatchObject({ status: "current", reasons: [] });
    study = await created(await post(app, `/api/research/studies/${study.id}/analysis-runs`, { cleaningRunId: cleanB }));
    const runB = study.analysisRuns.at(-1)!.id;
    study = await created(await post(app, `/api/research/studies/${study.id}/claims`, {
      text: "Dataset A has a mean of 1.5.", kind: "description", analysisRunIds: [runA2],
    }));
    expect((await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "claim", targetId: study.claims.at(-1)!.id, decision: "accept", reason: "Reviewed",
    })).status).toBe(201);

    // The cleaning engine treats missing markers as a set, regardless of order or case.
    const duplicate = await post(app, `/api/research/studies/${study.id}/cleaning-runs`, {
      planVersionId: planId, assetId: assetA,
      recipe: { valueColumn: "value", missingTokens: ["n/a", " na ", "NA", ""] },
    });
    expect(duplicate.status).toBe(409);
    study = await created(await post(app, `/api/research/studies/${study.id}/cleaning-runs`, {
      planVersionId: planId, assetId: assetA,
      recipe: { valueColumn: "value", trimWhitespace: false },
    }));
    const cleanA2 = study.cleaningRuns.at(-1)!.id;
    expect(await status(app, study.id, runA1)).toMatchObject({ status: "needs_review", reasons: ["cleaning_version_changed"] });
    expect(await status(app, study.id, runB)).toMatchObject({ status: "current", reasons: [] });
    expect((await post(app, `/api/research/studies/${study.id}/analysis-runs`, { cleaningRunId: cleanA1 })).status).toBe(409);

    // Reusing an earlier recipe is a new, explicit version after a different recipe became current.
    study = await created(await post(app, `/api/research/studies/${study.id}/cleaning-runs`, {
      planVersionId: planId, assetId: assetA, recipe: firstRecipe,
    }));
    expect(study.cleaningRuns.at(-1)!.id).not.toBe(cleanA1);
    expect((await post(app, `/api/research/studies/${study.id}/analysis-runs`, { cleaningRunId: cleanA2 })).status).toBe(409);
    study = await created(await post(app, `/api/research/studies/${study.id}/analysis-runs`, {
      cleaningRunId: study.cleaningRuns.at(-1)!.id,
    }));
    expect(await status(app, study.id, study.analysisRuns.at(-1)!.id)).toMatchObject({ status: "current", reasons: [] });
  });
});
