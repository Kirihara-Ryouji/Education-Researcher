import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const launcher = fileURLToPath(new URL("../plugins/playwright-mcp/0.0.78/scripts/launch.mjs", import.meta.url));

async function runCheck(browserRoot: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, "--check"], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot, BRAINPILOT_PLAYWRIGHT_EXECUTABLE_PATH: "" },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

describe("Playwright MCP launcher browser discovery", () => {
  it.each([
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
    "chrome-win/chrome.exe",
    "chrome-linux/chrome",
  ])("accepts a cached Chromium layout at %s", async (relative) => {
    const root = await mkdtemp(path.join(tmpdir(), "bp-playwright-cache-"));
    const executable = path.join(root, "chromium-1234", relative);
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture");

    await expect(runCheck(root)).resolves.toBe(0);
  });
});

describe.runIf(process.platform === "win32")("Playwright MCP Windows launch", () => {
  it.each(["0.0.78", "0.0.79-bp.1"])("runs npx's JavaScript entry without a shell in %s", async (version) => {
    const root = await mkdtemp(path.join(tmpdir(), "bp-playwright-npx-"));
    try {
      const fakeNpx = path.join(root, "npx-cli.js");
      const captured = path.join(root, "arguments.json");
      const outputDir = path.join(root, "plugin data & logs");
      await writeFile(fakeNpx, "require('node:fs').writeFileSync(process.env.BP_TEST_NPX_CAPTURE, JSON.stringify(process.argv.slice(2)));\n");
      const versionLauncher = fileURLToPath(new URL(`../plugins/playwright-mcp/${version}/scripts/launch.mjs`, import.meta.url));
      // Windows environment keys are case insensitive. npm may have supplied
      // NPM_EXECPATH, which would override a second npm_execpath key here.
      const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_execpath"));
      const result = spawnSync(process.execPath, [versionLauncher], {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...inheritedEnv,
          npm_execpath: path.join(root, "npm-cli.js"),
          BRAINPILOT_PLAYWRIGHT_EXECUTABLE_PATH: process.execPath,
          BRAINPILOT_PLUGIN_DATA: outputDir,
          BP_TEST_NPX_CAPTURE: captured,
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(await readFile(captured, "utf8"))).toEqual([
        "-y", "@playwright/mcp@0.0.78",
        "--headless", "--isolated", "--block-service-workers",
        "--output-dir", outputDir,
        "--executable-path", process.execPath,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
