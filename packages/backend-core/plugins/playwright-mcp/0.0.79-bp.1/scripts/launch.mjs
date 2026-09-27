import { spawn } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exists = async (file) => access(file).then(() => true, () => false);

async function cachedChromiumCandidates() {
  const defaultRoot = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
    : process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || os.homedir(), "ms-playwright")
      : path.join(os.homedir(), ".cache", "ms-playwright");
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || defaultRoot;
  let entries = [];
  try { entries = await readdir(root); } catch { return []; }
  const candidates = [];
  for (const entry of entries.filter((name) => /^chromium-\d+$/.test(name))) {
    for (const relative of [
      "chrome-linux64/chrome",
      "chrome-linux/chrome",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
      "chrome-win/chrome.exe",
    ]) {
      const file = path.join(root, entry, relative);
      if (await exists(file)) candidates.push({ file, modified: (await stat(file)).mtimeMs });
    }
  }
  return candidates.sort((left, right) => right.modified - left.modified).map(({ file }) => file);
}

async function browserExecutable() {
  const configured = process.env.BRAINPILOT_PLAYWRIGHT_EXECUTABLE_PATH;
  if (configured) return await exists(configured) ? configured : undefined;
  const cached = await cachedChromiumCandidates();
  if (cached[0]) return cached[0];
  const system = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : process.platform === "win32"
      ? [path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"), path.join(process.env.LOCALAPPDATA || "", "Chromium/Application/chrome.exe")]
      : ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const candidate of system) if (candidate && await exists(candidate)) return candidate;
  return undefined;
}

async function windowsNpxCli() {
  // Node's native spawn cannot execute .cmd shims with shell:false on modern
  // Windows (EINVAL). Run npx's JavaScript entry through node.exe instead so
  // plugin paths and browser paths never pass through cmd.exe parsing.
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(path.join(path.dirname(process.env.npm_execpath), "npx-cli.js"));
  for (const directory of [path.dirname(process.execPath), ...(process.env.PATH || "").split(path.delimiter)]) {
    if (directory) candidates.push(path.join(directory.replace(/^"|"$/g, ""), "node_modules", "npm", "bin", "npx-cli.js"));
  }
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return undefined;
}

const executable = await browserExecutable();
if (!executable) {
  console.error("Playwright MCP requires Chrome/Chromium. Install it with `npx playwright install chromium` or set BRAINPILOT_PLAYWRIGHT_EXECUTABLE_PATH.");
  process.exit(1);
}
if (process.argv.includes("--check")) process.exit(0);

const outputDir = process.env.BRAINPILOT_PLUGIN_DATA || path.join(os.tmpdir(), "brainpilot-playwright-mcp");
const npxArgs = [
  "-y", "@playwright/mcp@0.0.78",
  "--headless",
  "--isolated",
  "--block-service-workers",
  "--output-dir", outputDir,
  "--executable-path", executable,
];
const npxCli = process.platform === "win32" ? await windowsNpxCli() : undefined;
if (process.platform === "win32" && !npxCli) {
  console.error("Playwright MCP requires npm's npx-cli.js alongside the Node.js installation.");
  process.exit(1);
}
const child = spawn(npxCli ? process.execPath : "npx", npxCli ? [npxCli, ...npxArgs] : npxArgs, { stdio: "inherit", env: process.env });

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error.message); process.exit(1); });
child.on("exit", (code, signal) => process.exitCode = signal ? 1 : (code ?? 1));
