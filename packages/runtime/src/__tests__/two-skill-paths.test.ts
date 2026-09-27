/**
 * Integration test for the two-path skill-loading design:
 *
 *   - bp_template/skills/         → Pi-native `additionalSkillPaths` (always-on)
 *   - bp_template/skills-router/  → `skill_search` Pi-native custom tool
 *
 * After materialization, the always-on dir must contain ONLY the Meta-Skills
 * category, the router dir must contain every other shipped category, and the
 * SessionManager must hand each path to the right consumer (the agent factory's
 * `skillPaths` vs the `skill_search` tool's router base).
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALWAYS_ON_CATEGORY, materializeSkills } from "../materialize-skills.js";
import { SessionManager } from "../session-manager.js";
import { mockAgentFactory } from "../agent-factory.js";
import { shouldBlockToolCall } from "../router-skill-access.js";
import type { AgentSessionFactory } from "../types.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bp-two-paths-"));
}

describe("two-path skill loading", () => {
  it("materialize splits Meta-Skills into always-on and the rest into router", async () => {
    const root = await tmp();
    const res = await materializeSkills(root);

    const alwaysOnDirs = (await readdir(res.dest, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const routerDirs = (await readdir(res.routerDest, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    expect(alwaysOnDirs).toEqual([ALWAYS_ON_CATEGORY]);
    expect(routerDirs).not.toContain(ALWAYS_ON_CATEGORY);
    expect(routerDirs.length).toBeGreaterThan(0);
  });

  it("SessionManager passes ONLY always-on to the factory's skillPaths", async () => {
    const root = await tmp();
    await materializeSkills(root); // populate both sides up-front

    let capturedSkillPaths: string[] | undefined;
    // Wrap the mock factory so we can observe what the manager handed to it.
    const wrappedFactory: AgentSessionFactory = async (params) => {
      capturedSkillPaths = params.skillPaths;
      return mockAgentFactory(params);
    };

    const mgr = new SessionManager({
      dataRoot: root,
      agentFactory: wrappedFactory,
      persist: false,
    });
    const session = await mgr.createSession({});
    await mgr.ensureAgent(session.id, "principal");

    // App-controlled Meta-Skills plus targeted bundled system-plugin Skills are
    // native Pi paths; the router is never in this list.
    expect(capturedSkillPaths).toEqual([
      join(root, "bp_template", "skills"),
      expect.stringMatching(/plugin-auditor.*audit-feedback-loop/),
    ]);
    expect(capturedSkillPaths).not.toContain(join(root, "bp_template", "skills-router"));
  });

  it("skill_search tool reads from the router dir, not the always-on dir", async () => {
    const root = await tmp();
    await materializeSkills(root);

    let capturedRouterDir: string | undefined;
    let toolNamesSeen: string[] | undefined;
    const wrappedFactory: AgentSessionFactory = async (params) => {
      toolNamesSeen = params.systemTools.map((t) => t.name);
      // The skill_search tool's execute closure captured the router dir;
      // invoke it with browse('') and confirm it lists router categories.
      const skillSearch = params.systemTools.find((t) => t.name === "skill_search");
      if (skillSearch) {
        const out = await skillSearch.execute({ mode: "browse", relative_path: "" });
        const payload = JSON.parse(out.content[0]!.text);
        // The router dir must NOT contain the Meta-Skills category — that one
        // lives only in the always-on dir.
        const names = payload.children.map((c: { name: string }) => c.name);
        expect(names).not.toContain(ALWAYS_ON_CATEGORY);
        expect(names.length).toBeGreaterThan(0);
        capturedRouterDir = root; // success signal
      }
      return mockAgentFactory(params);
    };

    const mgr = new SessionManager({
      dataRoot: root,
      agentFactory: wrappedFactory,
      persist: false,
    });
    const session = await mgr.createSession({});
    await mgr.ensureAgent(session.id, "librarian");

    expect(toolNamesSeen).toContain("skill_search");
    expect(capturedRouterDir).toBe(root);
  });

  it("defaults new sessions to education and limits discovery without losing general tools", async () => {
    const root = await tmp();
    await materializeSkills(root);
    type Captured = Parameters<AgentSessionFactory>[0];
    const captured: Captured[] = [];
    const mgr = new SessionManager({
      dataRoot: root,
      persist: false,
      agentFactory: async (params) => {
        captured.push(params);
        return mockAgentFactory(params);
      },
    });
    const session = await mgr.createSession();
    expect(session.researchDomain).toBe("education");
    expect(mgr.getSessionState(session.id)?.researchDomain).toBe("education");
    for (const name of ["principal", "librarian", "experimentalist", "engineer", "writer", "trace"]) {
      await mgr.ensureAgent(session.id, name);
    }
    for (const params of captured) {
      expect(params.systemPrompt).toContain("Education research focus");
      expect(params.systemPrompt).not.toMatch(/\bEEG\b|\bfMRI\b|MNE-Python/i);
      if (params.agentName === "trace") continue;
      const tools = params.systemTools.map((tool) => tool.name);
      expect(tools).not.toContain("get_domain_knowledge_local");
      expect(tools).not.toContain("search_papers_local");
      expect(tools).toContain("skill_search");
      expect(params.allowedToolNames).toContain("read");
      // File tools cannot open the unfiltered router path around skill_search.
      expect(params.blockRouterSkills).toBe(true);
    }
    const principal = captured.find((item) => item.agentName === "principal")!;
    expect(shouldBlockToolCall({
      toolName: "read",
      input: { path: join(root, "bp_template", "skills-router", "05_EEG_ERP") },
      routerSkillsDir: principal.routerSkillsDir!,
      cwd: principal.cwd,
    })).toMatch(/Direct file access to the router skill library is disabled/);
    const search = principal.systemTools.find((tool) => tool.name === "skill_search")!;
    const browse = JSON.parse((await search.execute({ mode: "browse", relative_path: "" })).content[0]!.text);
    const categories = browse.children.map((item: { name: string }) => item.name);
    expect(categories).toContain("22_Education");
    expect(categories).not.toContain("05_EEG_ERP");
    expect(categories).not.toContain("02_Cross-Domain_Foundation");
    const education = JSON.parse((await search.execute({ mode: "browse", relative_path: "22_Education" })).content[0]!.text);
    expect(education.children.map((item: { name: string }) => item.name)).toContain("AUTHORITATIVE_SOURCES.md");
    const sourceIndex = await search.execute({ mode: "browse", relative_path: "22_Education/AUTHORITATIVE_SOURCES.md" });
    expect(sourceIndex.content[0]!.text).toContain("教育研究权威来源索引");
    const neuroQuery = JSON.parse((await search.execute({ mode: "query", keywords: "EEG, fMRI" })).content[0]!.text);
    expect(neuroQuery.total_matched).toBe(0);
    await expect(search.execute({ mode: "browse", relative_path: "05_EEG_ERP" })).rejects.toThrow(/not available/);
    await expect(search.execute({ mode: "query", skill_name: "cogsci-power-analysis" })).rejects.toThrow(/not found/);
    const educationSkill = await search.execute({ mode: "query", skill_name: "education-study-design" });
    expect(educationSkill.content[0]!.text).toContain("教育研究设计");
  });

  it("trace receives only its targeted GoT skill and no skill_search", async () => {
    const root = await tmp();
    await materializeSkills(root);

    let traceTools: string[] | undefined;
    let traceSkillPaths: string[] | undefined;
    const wrappedFactory: AgentSessionFactory = async (params) => {
      if (params.agentName === "trace") {
        traceTools = params.systemTools.map((t) => t.name);
        traceSkillPaths = params.skillPaths;
      }
      return mockAgentFactory(params);
    };

    const mgr = new SessionManager({
      dataRoot: root,
      agentFactory: wrappedFactory,
      persist: false,
    });
    const session = await mgr.createSession({});
    await mgr.ensureAgent(session.id, "trace");

    expect(traceTools).toBeDefined();
    expect(traceTools).not.toContain("skill_search");
    expect(traceSkillPaths).toEqual([
      expect.stringMatching(/plugin-got.*curate-research-trace/),
    ]);
    expect(traceSkillPaths).not.toContain(join(root, "bp_template", "skills"));
    expect(traceSkillPaths).not.toContain(join(root, "bp_template", "skills-router"));
  });

  it("keeps full and base sessions isolated without global mutation", async () => {
    const root = await tmp();
    type Captured = Parameters<AgentSessionFactory>[0];
    const captured = new Map<string, Captured>();
    const wrappedFactory: AgentSessionFactory = async (params) => {
      captured.set(params.sessionId, params);
      return mockAgentFactory(params);
    };
    const mgr = new SessionManager({
      dataRoot: root,
      agentFactory: wrappedFactory,
      persist: false,
      toolToggles: {},
    });
    const base = await mgr.createSession({ domainResources: "base", researchDomain: "neuroscience" });
    const full = await mgr.createSession({ domainResources: "full", researchDomain: "neuroscience" });
    await mgr.ensureAgent(base.id, "principal");
    await mgr.ensureAgent(full.id, "principal");

    const baseParams = captured.get(base.id)!;
    const fullParams = captured.get(full.id)!;
    for (const name of ["skill_search", "get_domain_knowledge_local", "search_papers_local"]) {
      expect(baseParams.systemTools.map((tool) => tool.name)).not.toContain(name);
      expect(fullParams.systemTools.map((tool) => tool.name)).toContain(name);
    }
    expect(baseParams.skillPaths).toEqual([
      expect.stringMatching(/plugin-auditor.*audit-feedback-loop/),
    ]);
    expect(fullParams.skillPaths).toEqual([
      join(root, "bp_template", "skills"),
      expect.stringMatching(/plugin-auditor.*audit-feedback-loop/),
    ]);
    expect(baseParams.systemPrompt).not.toMatch(/skill_search|<available_skills>|SKILL\.md/i);
    expect(fullParams.systemPrompt).toContain("skill_search");
    expect(baseParams.allowedToolNames).toEqual(expect.arrayContaining(["read", "write", "bash"]));
    expect(mgr.getSessionState(base.id)?.domainResources).toBe("base");
    expect(mgr.getSessionState(full.id)?.domainResources).toBe("full");
  });

  it("skill_search off: strips router prompt, drops tool, and flags blockRouterSkills (#309)", async () => {
    const root = await tmp();
    type Captured = Parameters<AgentSessionFactory>[0];
    const captured: Captured[] = [];
    const wrappedFactory: AgentSessionFactory = async (params) => {
      captured.push(params);
      return mockAgentFactory(params);
    };
    const mgr = new SessionManager({
      dataRoot: root,
      agentFactory: wrappedFactory,
      persist: false,
      toolToggles: { skill_search: false },
    });
    const session = await mgr.createSession({ domainResources: "full", researchDomain: "neuroscience" });
    await mgr.ensureAgent(session.id, "principal");
    await mgr.ensureAgent(session.id, "librarian");

    expect(captured.length).toBe(2);
    for (const params of captured) {
      expect(params.systemTools.map((t) => t.name)).not.toContain("skill_search");
      // App Meta-Skills still load alongside system-plugin Skills targeted to
      // the current role, independently of the router toggle.
      expect(params.skillPaths).toEqual([
        join(root, "bp_template", "skills"),
        params.agentName === "principal"
          ? expect.stringMatching(/plugin-auditor.*audit-feedback-loop/)
          : expect.stringMatching(/plugin-research.*source-grounded-research-report/),
      ]);
      expect(params.systemTools.map((t) => t.name)).toContain("get_domain_knowledge_local");
      // Prompt no longer teaches skill_search / router library.
      expect(params.systemPrompt).not.toMatch(/skill_search/i);
      expect(params.systemPrompt).not.toMatch(/Router skill library/i);
      // Hard path guard is armed for the real factory.
      expect(params.blockRouterSkills).toBe(true);
      expect(params.routerSkillsDir).toBe(join(root, "bp_template", "skills-router"));
      // #346: durable roots for logical /workspace rewrite on the real factory.
      expect(params.managedPathRoots).toEqual({
        cwd: join(root, "workspaces", session.id),
        persistentDir: join(root, "data"),
      });
      // Builtins still include read (always-on skills remain loadable via read).
      expect(params.allowedToolNames).toContain("read");
    }
  });
});
