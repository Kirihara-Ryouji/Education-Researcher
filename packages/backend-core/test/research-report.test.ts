import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Orchestrator } from "../src/orchestrator.js";

const spec = {
  title: "AI feedback and independent learning",
  question: "How is AI feedback associated with later independent learning?",
  entry: "idea" as const,
};

interface Study {
  id: string;
  specs: Array<{ id: string }>;
  plans: Array<{ id: string }>;
  sources: Array<{ id: string }>;
  assets: Array<{ id: string; sha256: string }>;
  evidence: Array<{ id: string }>;
  claims: Array<{ id: string }>;
  cleaningRuns: Array<{ id: string }>;
  analysisRuns: Array<{ id: string }>;
  reports: Array<{
    id: string;
    version: number;
    title: string;
    markdown: string;
    sha256: string;
    planVersionId: string;
    claimIds: string[];
    analysisRunIds: string[];
  }>;
}

function makeApp(root: string, env: Record<string, string> = { BP_LOCAL_MODE: "1", BP_DYNAMIC: "0" }) {
  let runtimeCalls = 0;
  const orchestrator: Orchestrator = {
    async ensureRuntime() { runtimeCalls++; throw new Error("Reports must not start Runtime"); },
    async health() { return true; },
    async stopRuntime() {},
  };
  const fetchFn = (async () => {
    runtimeCalls++;
    throw new Error("Reports must not make an external request");
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

async function setupStudy(app: App): Promise<{ study: Study; planId: string }> {
  const projectResponse = await post(app, "/api/research/projects", { title: `Report project ${randomUUID()}` });
  expect(projectResponse.status).toBe(201);
  const project = await projectResponse.json() as { id: string };
  let study = await createdStudy(await post(app, `/api/research/projects/${project.id}/studies`, spec));
  study = await createdStudy(await post(app, `/api/research/studies/${study.id}/plans`, {
    content: "Describe the evidence, report uncertainty, and review each conclusion.",
  }));
  const planId = study.plans.at(-1)!.id;
  study = await createdStudy(await post(app, `/api/research/studies/${study.id}/decisions`, {
    target: "plan", targetId: planId, decision: "accept", reason: "Approved for a report",
  }));
  return { study, planId };
}

async function addAcceptedClaim(app: App, study: Study, text: string, analysisRunIds: string[] = []) {
  let updated = await createdStudy(await post(app, `/api/research/studies/${study.id}/claims`, {
    text, kind: "description", analysisRunIds,
  }));
  const claimId = updated.claims.at(-1)!.id;
  updated = await createdStudy(await post(app, `/api/research/studies/${study.id}/decisions`, {
    target: "claim", targetId: claimId, decision: "accept", reason: "Checked against the record",
  }));
  return { study: updated, claimId };
}

function reportInput(claimIds: string[], analysisRunIds: string[] = [], title = "Research summary") {
  return {
    title,
    summary: "An exploratory synthesis of the local study record.",
    sections: [{ heading: "Findings", content: "The results are descriptive and require further study." }],
    limitations: ["The sample is limited."],
    claimIds,
    analysisRunIds,
    reason: "Freeze a version for review",
  };
}

async function reportStatus(app: App, studyId: string, reportId: string) {
  const response = await app.request(`/api/research/studies/${studyId}/reports/status`);
  expect(response.status).toBe(200);
  const data = await response.json() as { statuses: Array<{ reportId: string; status: string; reasons: string[] }> };
  return data.statuses.find((status) => status.reportId === reportId);
}

describe("research report versions", () => {
  it("freezes accepted claims into reproducible Markdown with a manifest and safe download", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-report-"));
    const { app, runtimeCalls } = makeApp(root);
    let { study, planId } = await setupStudy(app);
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/sources`, {
      title: "Classroom observation notes", kind: "observation", origin: "observed",
      locator: "Local field notes", accessNote: "Researcher-owned notes",
    }));
    const sourceId = study.sources.at(-1)!.id;
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/evidence`, {
      sourceId, kind: "researcher_note", locator: "day 1", content: "Learners asked fewer follow-up questions.",
    }));
    const evidenceId = study.evidence.at(-1)!.id;
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/claims`, {
      text: "Follow-up questions were less frequent in the observed lesson.", kind: "description",
      evidence: [{ evidenceId, relation: "supports" }],
    }));
    const claimId = study.claims.at(-1)!.id;
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "claim", targetId: claimId, decision: "accept", reason: "Reviewed the note",
    }));

    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/reports`, reportInput([claimId])));
    const report = study.reports.at(-1)!;
    expect(report).toMatchObject({ version: 1, title: "Research summary", planVersionId: planId, claimIds: [claimId], analysisRunIds: [] });
    expect(report.markdown).toContain("Research summary");
    expect(report.markdown).toContain("Follow-up questions were less frequent");
    expect(report.markdown).toContain("Classroom observation notes");
    expect(report.sha256).toBe(createHash("sha256").update(report.markdown, "utf8").digest("hex"));

    const manifestResponse = await app.request(`/api/research/studies/${study.id}/reports/${report.id}/manifest`);
    expect(manifestResponse.status).toBe(200);
    const manifest = await manifestResponse.json() as Record<string, unknown>;
    expect(manifest).toMatchObject({
      reportId: report.id, version: 1, sha256: report.sha256,
      planVersionId: planId, claimIds: [claimId], analysisRunIds: [], title: report.title,
    });
    expect(manifest.createdAt).toEqual(expect.any(String));
    expect(manifest.createdBy).toEqual(expect.any(String));
    expect(manifest.currentStatus).toBeDefined();
    expect(JSON.stringify(manifest)).not.toContain("An exploratory synthesis");

    const downloadPath = `/api/research/studies/${study.id}/reports/${report.id}/download`;
    const downloaded = await app.request(downloadPath);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toContain("text/markdown");
    expect(downloaded.headers.get("content-disposition")).toContain("attachment");
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
    expect(downloaded.headers.get("cache-control")).toBe("no-store");
    expect(await downloaded.text()).toBe(report.markdown);
    expect((await reportStatus(app, study.id, report.id))?.status).toBe("current");
    const accepted = await createdStudy(await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "report", targetId: report.id, decision: "accept", reason: "Approved after reviewing citations",
    }));
    expect(accepted.reports[0]).toEqual(report);

    const reopened = makeApp(root);
    const saved = await reopened.app.request(`/api/research/studies/${study.id}`);
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Study).reports[0]).toEqual(report);
    expect(await (await reopened.app.request(downloadPath)).text()).toBe(report.markdown);
    expect(runtimeCalls()).toBe(0);
    expect(reopened.runtimeCalls()).toBe(0);
  });

  it("rejects unaccepted claims, foreign references and incomplete analysis citations without creating a report", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-report-"));
    const { app } = makeApp(root);
    const first = await setupStudy(app);
    const second = await setupStudy(app);
    let study = await createdStudy(await post(app, `/api/research/studies/${first.study.id}/claims`, {
      text: "This draft claim needs review.", kind: "interpretation",
    }));
    const draftClaimId = study.claims.at(-1)!.id;
    expect((await post(app, `/api/research/studies/${study.id}/reports`, reportInput([draftClaimId]))).status).toBe(409);
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "claim", targetId: draftClaimId, decision: "accept", reason: "Checked",
    }));
    const foreign = await post(app, `/api/research/studies/${second.study.id}/reports`, reportInput([draftClaimId]));
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.status).toBeLessThan(500);
    const unknownAnalysis = await post(app, `/api/research/studies/${study.id}/reports`, reportInput([draftClaimId], [randomUUID()]));
    expect(unknownAnalysis.status).toBeGreaterThanOrEqual(400);
    expect(unknownAnalysis.status).toBeLessThan(500);
    const noClaim = await post(app, `/api/research/studies/${study.id}/reports`, reportInput([]));
    expect(noClaim.status).toBe(400);
    const saved = await app.request(`/api/research/studies/${study.id}`);
    expect(((await saved.json()) as Study).reports).toHaveLength(0);
  });

  it("retains frozen historical exports while a new research plan supersedes the old version", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-report-"));
    const { app } = makeApp(root);
    let { study } = await setupStudy(app);
    const firstClaim = await addAcceptedClaim(app, study, "The original question produced an exploratory finding.");
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/reports`, reportInput([firstClaim.claimId], [], "First report")));
    const original = study.reports[0]!;
    expect((await reportStatus(app, study.id, original.id))?.status).toBe("current");

    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/plans`, {
      content: "Revise the synthesis after checking the evidence.", reason: "Methods review",
    }));
    const nextPlanId = study.plans.at(-1)!.id;
    expect((await reportStatus(app, study.id, original.id))?.status).toBe("needs_review");
    expect((await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "report", targetId: original.id, decision: "accept", reason: "Old draft",
    })).status).toBe(409);
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "plan", targetId: nextPlanId, decision: "accept", reason: "Approved revision",
    }));
    const secondClaim = await addAcceptedClaim(app, study, "A revised conclusion reflects the new synthesis plan.");
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/reports`, reportInput([secondClaim.claimId], [], "Revised report")));
    expect(study.reports.map((report) => report.version)).toEqual([1, 2]);
    expect(study.reports[0]).toEqual(original);
    expect(study.reports[1]).toMatchObject({ planVersionId: nextPlanId, claimIds: [secondClaim.claimId] });
    expect((await reportStatus(app, study.id, study.reports[1]!.id))?.status).toBe("current");
    const oldDownload = await app.request(`/api/research/studies/${study.id}/reports/${original.id}/download`);
    expect(await oldDownload.text()).toBe(original.markdown);
  });

  it("requires explicit, reproducible analysis citations and never exports raw table rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-report-"));
    const { app } = makeApp(root);
    let { study, planId } = await setupStudy(app);
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/sources`, {
      title: "De-identified assessment scores", kind: "dataset", origin: "observed",
      accessNote: "Researcher supplied a local copy",
    }));
    const sourceId = study.sources.at(-1)!.id;
    const upload = (csv: string) => app.request(`/api/research/studies/${study.id}/sources/${sourceId}/table-assets`, {
      method: "POST",
      headers: {
        "content-type": "text/csv",
        "x-bp-filename": encodeURIComponent("scores.csv"),
        "x-bp-access-note": encodeURIComponent("Researcher supplied a de-identified local copy"),
      },
      body: csv,
    });
    study = await createdStudy(await upload("student_id,score\nPRIVATE_ROW_A,1\nPRIVATE_ROW_B,2\n"));
    const assetId = study.assets.at(-1)!.id;
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/cleaning-runs`, {
      planVersionId: planId, assetId, recipe: { valueColumn: "score" },
    }));
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/analysis-runs`, {
      cleaningRunId: study.cleaningRuns.at(-1)!.id,
    }));
    const analysisRunId = study.analysisRuns.at(-1)!.id;
    const claim = await addAcceptedClaim(app, study, "The observed mean score was 1.5.", [analysisRunId]);
    study = claim.study;
    const omitted = await post(app, `/api/research/studies/${study.id}/reports`, reportInput([claim.claimId]));
    expect(omitted.status).toBe(400);
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/reports`, reportInput([claim.claimId], [analysisRunId])));
    const report = study.reports.at(-1)!;
    expect(report.analysisRunIds).toEqual([analysisRunId]);
    expect(report.markdown).toContain("1.5");
    expect(report.markdown).not.toContain("PRIVATE_ROW_A");
    expect(report.markdown).not.toContain("PRIVATE_ROW_B");
    expect((await reportStatus(app, study.id, report.id))?.status).toBe("current");

    await createdStudy(await upload("student_id,score\nPRIVATE_ROW_C,10\nPRIVATE_ROW_D,20\n"));
    expect((await reportStatus(app, study.id, report.id))?.status).toBe("needs_review");
    expect((await post(app, `/api/research/studies/${study.id}/reports`, reportInput([claim.claimId], [analysisRunId]))).status).toBe(409);
    const oldDownload = await app.request(`/api/research/studies/${study.id}/reports/${report.id}/download`);
    expect(await oldDownload.text()).toBe(report.markdown);
  });

  it.each(["missing", "changed"] as const)("marks reports unavailable when a cited file is %s", async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-report-"));
    const { app } = makeApp(root);
    let { study } = await setupStudy(app);
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/sources`, {
      title: "Research notes", kind: "document", origin: "observed",
      accessNote: "Researcher-owned field notes",
    }));
    const sourceId = study.sources.at(-1)!.id;
    const upload = await app.request(`/api/research/studies/${study.id}/sources/${sourceId}/assets`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-bp-filename": encodeURIComponent("notes.txt"),
        "x-bp-access-note": encodeURIComponent("Researcher-owned field notes"),
      },
      body: "The first observed result.\nA second line.",
    });
    study = await createdStudy(upload);
    const assetId = study.assets.at(-1)!.id;
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/evidence/from-asset`, {
      assetId, section: 1, segmentIndex: 0, start: 0, end: 10,
    }));
    const evidenceId = study.evidence.at(-1)!.id;
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/claims`, {
      text: "The first result was observed.", kind: "description",
      evidence: [{ evidenceId, relation: "supports" }],
    }));
    const claimId = study.claims.at(-1)!.id;
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "claim", targetId: claimId, decision: "accept", reason: "Verified against the file",
    }));
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/reports`, reportInput([claimId])));
    const report = study.reports.at(-1)!;
    expect((await reportStatus(app, study.id, report.id))?.status).toBe("current");

    const filePath = join(root, "research", "assets", study.id, `${assetId}.bin`);
    if (failure === "missing") await unlink(filePath);
    else await writeFile(filePath, "The bytes changed after the report was saved.");
    expect((await reportStatus(app, study.id, report.id))?.status).toBe("unavailable");
    expect((await post(app, `/api/research/studies/${study.id}/decisions`, {
      target: "report", targetId: report.id, decision: "accept", reason: "Cannot verify missing evidence",
    })).status).toBe(409);
    expect((await post(app, `/api/research/studies/${study.id}/reports`, reportInput([claimId]))).status).toBe(409);
    const saved = await app.request(`/api/research/studies/${study.id}`);
    expect(((await saved.json()) as Study).reports).toHaveLength(1);
    const download = await app.request(`/api/research/studies/${study.id}/reports/${report.id}/download`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(report.markdown);
  });

  it("keeps user content in a downloadable Markdown attachment and uses opaque report IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-report-"));
    const { app } = makeApp(root);
    let { study } = await setupStudy(app);
    const claim = await addAcceptedClaim(app, study, "A harmless text finding.");
    const attack = '<img src=x onerror="alert(1)">';
    study = await createdStudy(await post(app, `/api/research/studies/${study.id}/reports`, {
      ...reportInput([claim.claimId], [], `Title ${attack}`),
      sections: [{ heading: `Heading ${attack}`, content: `User supplied text ${attack}` }],
    }));
    const report = study.reports.at(-1)!;
    expect(report.markdown).not.toContain(attack);
    expect(report.markdown).toContain("&lt;img");
    const response = await app.request(`/api/research/studies/${study.id}/reports/${report.id}/download`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).not.toContain("text/html");
    expect(response.headers.get("content-disposition")).not.toContain("<img");
    expect(await response.text()).toBe(report.markdown);

    const arbitrary = await app.request(`/api/research/studies/${study.id}/reports/${randomUUID()}/download`);
    expect(arbitrary.status).toBe(404);
    const foreign = await setupStudy(app);
    expect((await app.request(`/api/research/studies/${foreign.study.id}/reports/${report.id}/download`)).status).toBe(404);
    expect((await app.request(`/api/research/studies/${foreign.study.id}/reports/${report.id}/manifest`)).status).toBe(404);
    const hosted = makeApp(root, { BP_LOCAL_MODE: "0", BP_DYNAMIC: "1" }).app;
    expect((await hosted.request(`/api/research/studies/${study.id}/reports/${report.id}/download`)).status).toBe(404);

    const recordsPath = join(root, "research", "research-v1.json");
    const records = JSON.parse(await readFile(recordsPath, "utf8")) as {
      studies: Array<{ id: string; reports: Array<{ id: string; markdown: string }> }>;
    };
    records.studies.find((item) => item.id === study.id)!.reports.find((item) => item.id === report.id)!.markdown = "Tampered export";
    await writeFile(recordsPath, JSON.stringify(records));
    const corruptDownload = await app.request(`/api/research/studies/${study.id}/reports/${report.id}/download`);
    expect(corruptDownload.status).toBe(409);
  });
});
