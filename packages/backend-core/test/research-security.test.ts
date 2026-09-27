import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";

const orchestrator = {
  ensureRuntime: async () => ({ baseUrl: "http://unused" }),
  health: async () => true,
  stopRuntime: async () => {},
};

async function localApp(env: Record<string, string> = { BP_LOCAL_MODE: "1" }) {
  const dataDir = await mkdtemp(join(tmpdir(), "bp-research-security-"));
  return createApp({ dataDir, orchestrator, serveWeb: false, env });
}

const projectBody = JSON.stringify({ title: "Local project" });

describe("local research HTTP boundary", () => {
  it("allows the local CLI without an Origin header and a same-origin browser request", async () => {
    const app = await localApp();
    const cli = await app.request("http://127.0.0.1:9001/api/research/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: projectBody,
    });
    expect(cli.status).toBe(201);

    const browser = await app.request("http://localhost:9001/api/research/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:9001",
        "sec-fetch-site": "same-origin",
      },
      body: projectBody,
    });
    expect(browser.status).toBe(201);
    expect((await app.request("http://localhost:9001/api/research/projects")).status).toBe(200);
    expect((await app.request("http://localhost:9001/api/info").then((r) => r.json()) as { researchAvailable: boolean }).researchAvailable).toBe(true);
  });

  it("rejects foreign origins, cross-site fetches, and non-loopback authorities", async () => {
    const app = await localApp();
    const badOrigin = await app.request("http://127.0.0.1:9001/api/research/projects", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: projectBody,
    });
    expect(badOrigin.status).toBe(403);
    const badFetchSite = await app.request("http://127.0.0.1:9001/api/research/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: projectBody,
    });
    expect(badFetchSite.status).toBe(403);
    expect((await app.request("http://attacker.example/api/research/projects")).status).toBe(403);
    expect((await app.request("http://127.0.0.1:9001/api/research/projects", {
      headers: { host: "attacker.example" },
    })).status).toBe(403);
    expect((await app.request("http://127.0.0.1:9001/api/research/projects", {
      headers: { origin: "https://attacker.example" },
    })).status).toBe(403);
  });

  it("refuses a text/plain simple POST even when it contains valid JSON", async () => {
    const app = await localApp();
    const response = await app.request("http://127.0.0.1:9001/api/research/projects", {
      method: "POST", headers: { "content-type": "text/plain" }, body: projectBody,
    });
    expect(response.status).toBe(415);
    expect((await app.request("http://127.0.0.1:9001/api/research/projects").then((r) => r.json()) as { projects: unknown[] }).projects).toHaveLength(0);
  });

  it("does not enable the shared research store in hosted or dynamic deployments", async () => {
    for (const env of [{ BP_LOCAL_MODE: "0" }, { BP_LOCAL_MODE: "false" }, { BP_DYNAMIC: "1" }]) {
      const app = await localApp(env);
      const response = await app.request("http://127.0.0.1:9001/api/research/projects");
      expect(response.status).toBe(404);
      expect((await response.json() as { code: string }).code).toBe("RESEARCH_UNAVAILABLE");
      expect((await app.request("http://127.0.0.1:9001/api/info").then((r) => r.json()) as { localMode: boolean; researchAvailable: boolean })).toMatchObject({ localMode: false, researchAvailable: false });
    }
  });
});
