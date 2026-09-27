import { describe, it, expect } from "vitest";
import { resolveDataDir, dataPaths } from "./paths.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("resolveDataDir precedence", () => {
  // Use the OS tmpdir so the cwd literal is a valid absolute path on every
  // host (Windows in particular — `/tmp/launch` resolves to `C:\tmp\launch`
  // there, which is technically fine for resolve()-based equality but
  // depends on a fragile detail). (#9 — cross-platform pass.)
  const cwd = join(tmpdir(), "launch");

  it("uses --dir when provided (highest priority)", () => {
    const d = resolveDataDir({
      dir: "custom",
      env: { BP_DATA_DIR: "/from/env" },
      cwd,
    });
    expect(d).toBe(resolve(cwd, "custom"));
  });

  it("resolves an absolute --dir as-is", () => {
    const absolute = join(tmpdir(), "abs", "path");
    const d = resolveDataDir({ dir: absolute, cwd });
    expect(d).toBe(absolute);
  });

  it("falls back to BP_DATA_DIR when no --dir", () => {
    const d = resolveDataDir({ env: { BP_DATA_DIR: "envdir" }, cwd });
    expect(d).toBe(resolve(cwd, "envdir"));
  });

  it("defaults to <cwd>/brainpilot when neither is set", () => {
    const d = resolveDataDir({ env: {}, cwd });
    expect(d).toBe(join(cwd, "brainpilot"));
  });

  it("ignores empty/whitespace --dir and env values", () => {
    const d = resolveDataDir({ dir: "   ", env: { BP_DATA_DIR: "" }, cwd });
    expect(d).toBe(join(cwd, "brainpilot"));
  });
});

describe("dataPaths", () => {
  it("derives all well-known paths under the data dir", () => {
    const dataDir = join(tmpdir(), "bp-data");
    const p = dataPaths(dataDir);
    expect(p.bpTemplate).toBe(join(dataDir, "bp_template"));
    expect(p.bpTemplateAgents).toBe(join(dataDir, "bp_template", "agents"));
    expect(p.bpTemplateSubagents).toBe(join(dataDir, "bp_template", "subagents"));
    expect(p.bpTemplateSettings).toBe(join(dataDir, "bp_template", "settings.json"));
    expect(p.bp).toBe(join(dataDir, ".bp"));
    expect(p.workspaces).toBe(join(dataDir, "workspaces"));
    expect(p.brainpilotConfig).toBe(join(dataDir, "brainpilot.config.json"));
    expect(p.runtimeDir).toBe(join(dataDir, ".runtime"));
    expect(p.logsDir).toBe(join(dataDir, ".runtime", "logs"));
    expect(p.backendLog).toBe(join(dataDir, ".runtime", "logs", "backend.log"));
    expect(p.backendPid).toBe(join(dataDir, ".runtime", "backend.pid"));
    expect(p.runtimePid).toBe(join(dataDir, ".runtime", "runtime.pid"));
  });
});
