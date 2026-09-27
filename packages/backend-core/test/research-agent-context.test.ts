import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const orchestrator = {
  ensureRuntime: async () => { throw new Error("Context preview must not start Runtime"); },
  health: async () => true,
  stopRuntime: async () => {},
};

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "bp-agent-context-"));
  const app = createApp({ dataDir, orchestrator, serveWeb: false, env: { BP_LOCAL_MODE: "1" } });
  const post = async (path: string, input: unknown) => app.request(`/api/research${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  const project = await (await post("/projects", { title: "Teaching study" })).json() as { id: string };
  const study = await (await post(`/projects/${project.id}/studies`, {
    title: "Feedback study", question: "How does feedback affect learning?", entry: "idea",
  })).json() as { id: string };
  const context = () => app.request(`/api/research/studies/${study.id}/agent-context`);
  return { app, post, study, context };
}

describe("education agent context handoff", () => {
  it("requires the latest plan to be accepted for the current study definition", async () => {
    const { post, study, context } = await fixture();
    expect((await context()).status).toBe(409);
    let record = await (await post(`/studies/${study.id}/plans`, { content: "Study the feedback evidence." })).json() as { plans: Array<{ id: string }> };
    expect((await context()).status).toBe(409);
    const planId = record.plans.at(-1)!.id;
    record = await (await post(`/studies/${study.id}/decisions`, {
      target: "plan", targetId: planId, decision: "accept", reason: "Reviewed",
    })).json() as typeof record;
    expect((await context()).status).toBe(200);
    await post(`/studies/${study.id}/specs`, {
      spec: { title: "Revised study", question: "A new question?", entry: "idea" }, reason: "Change scope",
    });
    expect((await context()).status).toBe(409);
  });

  it("sends checked and cited publication excerpts, excluding participant data and unchecked records", async () => {
    const { post, study, context } = await fixture();
    const addSource = async (kind: "publication" | "dataset", title: string, citation: string) => {
      const record = await (await post(`/studies/${study.id}/sources`, { title, kind, origin: "curated", citation })).json() as { sources: Array<{ id: string }> };
      return record.sources.at(-1)!.id;
    };
    const publicationId = await addSource("publication", "Evidence review", "Review (2025), p. 4");
    const datasetId = await addSource("dataset", "Student rows", "Private CSV");
    const addEvidence = async (sourceId: string, content: string) => {
      const record = await (await post(`/studies/${study.id}/evidence`, {
        sourceId, kind: "source_excerpt", locator: "p. 4", content,
      })).json() as { evidence: Array<{ id: string }> };
      return record.evidence.at(-1)!.id;
    };
    const checkedId = await addEvidence(publicationId, "Feedback timing was associated with revision quality.");
    const uncheckedId = await addEvidence(publicationId, "UNVERIFIED_SENTINEL");
    const studentId = await addEvidence(datasetId, "PRIVATE_STUDENT_ROW_SENTINEL");
    for (const evidenceId of [checkedId, studentId]) {
      const response = await post(`/studies/${study.id}/verifications`, { evidenceId, level: "content_checked", reason: "Compared with the source" });
      expect(response.status).toBe(201);
    }
    let response = await post(`/studies/${study.id}/plans`, {
      content: "Compare feedback strategies and report uncertainty.",
      evidenceIds: [checkedId, uncheckedId, studentId],
    });
    expect(response.status).toBe(201);
    const planId = (await response.json() as { plans: Array<{ id: string }> }).plans.at(-1)!.id;
    response = await post(`/studies/${study.id}/decisions`, {
      target: "plan", targetId: planId, decision: "accept", reason: "Reviewed",
    });
    expect(response.status).toBe(201);
    const handoff = await context();
    expect(handoff.status).toBe(200);
    const result = await handoff.json() as { prompt: string; planVersionId: string; evidenceCount: number; omittedEvidenceCount: number };
    expect(result.planVersionId).toBe(planId);
    expect(result.evidenceCount).toBe(1);
    expect(result.omittedEvidenceCount).toBe(2);
    expect(result.prompt).toContain("Feedback timing was associated");
    expect(result.prompt).toContain("Review (2025), p. 4");
    expect(result.prompt).toContain('"locator": "p. 4"');
    expect(result.prompt).not.toContain("UNVERIFIED_SENTINEL");
    expect(result.prompt).not.toContain("PRIVATE_STUDENT_ROW_SENTINEL");
    expect(result.prompt).not.toContain("Private CSV");
  });

  it("rejects an accepted plan after its cited file receives a newer version", async () => {
    const { app, post, study, context } = await fixture();
    let record = await (await post(`/studies/${study.id}/sources`, {
      title: "Published article", kind: "publication", origin: "curated", citation: "Article (2025)",
    })).json() as { sources: Array<{ id: string }> };
    const sourceId = record.sources.at(-1)!.id;
    const upload = async (content: string) => app.request(`/api/research/studies/${study.id}/sources/${sourceId}/assets`, {
      method: "POST", headers: {
        "content-type": "application/octet-stream", "x-bp-filename": "article.txt",
        "x-bp-access-note": "Licensed copy",
      }, body: content,
    });
    const first = await upload("The first version of the article.");
    expect(first.status).toBe(201);
    const assetId = (await first.json() as { assets: Array<{ id: string }> }).assets.at(-1)!.id;
    const evidence = await post(`/studies/${study.id}/evidence`, {
      sourceId, assetId, kind: "source_excerpt", locator: "text:l1", content: "The first version of the article.",
    });
    expect(evidence.status).toBe(201);
    const evidenceId = (await evidence.json() as { evidence: Array<{ id: string }> }).evidence.at(-1)!.id;
    expect((await post(`/studies/${study.id}/verifications`, {
      evidenceId, level: "content_checked", reason: "Compared with the first version",
    })).status).toBe(201);
    const plan = await post(`/studies/${study.id}/plans`, { content: "Use the article cautiously.", evidenceIds: [evidenceId] });
    const planId = (await plan.json() as { plans: Array<{ id: string }> }).plans.at(-1)!.id;
    expect((await post(`/studies/${study.id}/decisions`, {
      target: "plan", targetId: planId, decision: "accept", reason: "Reviewed",
    })).status).toBe(201);
    expect((await context()).status).toBe(200);
    expect((await upload("A revised version of the article.")).status).toBe(201);
    expect((await context()).status).toBe(409);
  });
});
