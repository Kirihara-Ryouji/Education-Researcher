import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stageResearchAsset } from "../src/research-asset-upload.js";
import { ResearchStore } from "../src/research-store.js";

const spec = {
  title: "Research integrity study",
  question: "Can evidence linked to a local file still be checked?",
  entry: "idea" as const,
};

async function evidenceFixture() {
  const root = await mkdtemp(join(tmpdir(), "bp-research-integrity-"));
  const store = new ResearchStore(root);
  const project = await store.createProject({ title: "File integrity" });
  let study = await store.createStudy(project.id, spec, "researcher");
  study = await store.addSource(study.id, {
    title: "Research notes", kind: "document", origin: "curated",
  });
  const sourceId = study.sources[0]!.id;
  const original = "Original passage";
  const staged = await stageResearchAsset(root, "notes.txt", new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(original)); controller.close(); },
  }));
  study = await store.addAsset(study.id, sourceId, staged, "Researcher owns this local copy");
  const assetId = study.assets[0]!.id;
  study = await store.addEvidence(study.id, {
    sourceId, assetId, kind: "source_excerpt", locator: "paragraph 1", content: original,
  });
  const evidenceId = study.evidence[0]!.id;
  study = await store.addPlan(study.id, {
    content: "Check the cited notes before drawing a conclusion.", evidenceIds: [evidenceId],
  }, "researcher");
  const planId = study.plans[0]!.id;
  study = await store.addClaim(study.id, {
    text: "The notes contain the original passage.", kind: "description",
    evidence: [{ evidenceId, relation: "supports" }],
  });
  return {
    root, store, studyId: study.id, evidenceId, planId, claimId: study.claims[0]!.id,
    file: join(root, "research", "assets", study.id, `${assetId}.bin`),
  };
}

const fileChanges: Array<[string, (file: string) => Promise<void>]> = [
  ["missing", async (file) => unlink(file)],
  ["changed", async (file) => writeFile(file, "Modified passage")],
];

describe("research state and evidence integrity", () => {
  it("retains both projects from concurrent ResearchStore instances using one data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-concurrent-"));
    const first = new ResearchStore(root);
    const second = new ResearchStore(root);
    const names = Array.from({ length: 12 }, (_, index) => `Concurrent project ${index + 1}`);
    for (let index = 0; index < names.length; index += 2) {
      const [a, b] = await Promise.all([
        first.createProject({ title: names[index] }),
        second.createProject({ title: names[index + 1] }),
      ]);
      expect(a.id).not.toBe(b.id);
    }
    const reopened = new ResearchStore(root);
    expect((await reopened.listProjects()).map((project) => project.title).sort()).toEqual([...names].sort());
    expect((await first.listProjects()).map((project) => project.title).sort()).toEqual([...names].sort());
  });

  it("retires an abandoned lock once while several processes contend for recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-research-abandoned-lock-"));
    const directory = join(root, "research");
    await mkdir(directory);
    await writeFile(join(directory, "research-v1.json.lock"), JSON.stringify({ pid: 999_999_999, token: "dead-owner", createdAt: Date.now() - 60_000 }));
    const titles = Array.from({ length: 8 }, (_, index) => `Recovered ${index}`);
    await Promise.all(titles.map((title) => new ResearchStore(root).createProject({ title })));
    expect((await new ResearchStore(root).listProjects()).map((project) => project.title).sort()).toEqual([...titles].sort());
  });

  it.each(fileChanges)("rejects plan and claim acceptance when a linked file is %s", async (_state, change) => {
    const fixture = await evidenceFixture();
    await change(fixture.file);
    await expect(fixture.store.verifyEvidence(fixture.studyId, {
      evidenceId: fixture.evidenceId, level: "content_checked", reason: "Compared with original",
    }, "researcher")).rejects.toMatchObject({ status: 409 });
    await expect(fixture.store.decide(fixture.studyId, {
      target: "plan", targetId: fixture.planId, decision: "accept", reason: "Checked",
    }, "researcher")).rejects.toMatchObject({ status: 409 });
    await expect(fixture.store.decide(fixture.studyId, {
      target: "claim", targetId: fixture.claimId, decision: "accept", reason: "Checked",
    }, "researcher")).rejects.toMatchObject({ status: 409 });
    expect((await fixture.store.getStudy(fixture.studyId)).decisions).toHaveLength(0);
  });
});
