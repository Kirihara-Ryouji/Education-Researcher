# Contributing to Education Researcher

Education Researcher is a fork of [BrainPilot](https://github.com/NeuroAIHub/BrainPilot) focused on education research. This guide covers local development and contributions to this repository. The `@brainpilot/*` package names and command names remain for compatibility with the upstream codebase.

## How to Contribute

| Contribution type | What to do |
| --- | --- |
| **Bug fix** | Open a PR directly (link the issue if one exists) |
| **New skill** | Open a PR directly — see [Contributing a skill](#contributing-a-skill) |
| **Extending existing features** (e.g. a new model provider, a new tool) | Open a PR directly |
| **New feature or architecture change** | Open an issue or discussion **before** opening a PR |
| **Refactor-only PR** | Not accepted unless a maintainer explicitly requests it |
| **Documentation** | Open a PR directly |
| **Question** | Open an issue in this repository |

## Prerequisites

- **[Node.js](https://nodejs.org/) ≥ 22.13**
- **npm** (bundled with Node)
- A configured model provider for real agent runs — or use `BP_MOCK=1` to develop without one

## Getting Started (run from source)

```bash
# Clone the repository
git clone https://github.com/Kirihara-Ryouji/Education-Researcher.git
cd Education-Researcher

# Install dependencies and build all packages
npm ci
npm run build

# Launch from source (equivalent to `brainpilot up --port 9005`)
npm run bp -- up --port 9005
```

> **Pass flags after `--`.** With `npm run`, the `--` separator is required so npm forwards
> `up --port 9005` to the CLI instead of consuming `--port` itself. `npm run bp up --port
> 9005` (no `--`) silently drops the flag and falls back to the default port. To skip npm
> entirely, call the built binary directly:
>
> ```bash
> node packages/cli/dist/bin.js up --port 9005
> ```
>
> (the runtime uses `port + 1`).

For a no-key smoke run on Unix shells: `BP_MOCK=1 npm run bp -- up`. On PowerShell, run `$env:BP_MOCK = '1'` before `npm run bp -- up`. Mock responses do not validate the education research quality of a model.

## Development Workflow

This repository follows a simple GitHub Flow: **`main` is the single source of truth.**
You branch off `main`, open a PR, and merge back into `main` once CI is green and a
maintainer approves.

1. **Fork** the repository and create a branch from `main`:
   ```bash
   git checkout -b feat/your-feature main
   ```
2. **Branch naming:**
   - `feat/` — new features or enhancements
   - `fix/` — bug fixes
   - `docs/` — documentation changes
   - `ci/` / `chore/` — tooling and maintenance
3. Make your changes and **test locally**.
4. Run **all checks** before committing (see below).
5. Open a **Pull Request** against `main`.

### How your PR is verified

Run the public CI checks and review the actual user flow. For changes to prompts, sources, study plans, or domain isolation, also use [education evaluation cases](EDUCATION-EVALUATION.md). Code tests establish tool and data boundaries; real-model answer quality requires a configured provider and manual source review. State clearly in a PR when that evaluation has not been run.

## Before You Submit a PR

Run these locally — CI runs them too, but catching issues early saves everyone time:

```bash
npm run typecheck                    # tsc -b across non-web packages
BP_MOCK=1 npx vitest run             # all non-web tests, deterministic mock (no API quota)
( cd packages/web && npm test && npm run build )   # web: vitest + vite build
npm run docs:check && npm run docs:build           # docs: MDX/types/static export + secret scan
```

`BP_MOCK=1` selects a deterministic mock agent so tests never consume API quota.

Optional end-to-end smoke tests:

```bash
bash scripts/smoke-e2e.sh            # backend → runtime(mock) → SSE → client smoke
bash scripts/smoke-docker.sh         # manual real-Docker smoke (needs a local daemon)
```

### Local verification

Before marking a PR **Ready for Review**, please:

1. **Verify your goal** — confirm the PR does what it set out to do (bug fixed, feature works).
2. **Regression-check** — make sure existing behavior still works (key flows, related features).
3. **Run the checks above.**

If you haven't completed local verification, keep the PR in **Draft**.

### PR Guidelines

- **Link an issue** — use `Closes #123` / `Fixes #456` in the description. If no issue
  exists, create one first.
- **Keep PRs focused** — one concern per PR; don't mix unrelated changes.
- **Describe what and why** — fill out the [PR template](.github/pull_request_template.md).
- **Include screenshots / recordings** for UI changes (before/after).
- **Ensure CI passes** before requesting review.

## Commit Message Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

[optional body]

[optional footer]
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `perf`, `style`

Examples:

```
feat(runtime): add result_deliver mailbox message type
fix(web): stop trace panel from resetting on session switch
docs: add bilingual README and CONTRIBUTING
```

## AI-Assisted PRs 🤖

PRs built with AI tools (Claude, Codex, Cursor, etc.) are welcome — we just ask for
transparency and self-review:

- **Mark it** — note in the PR title or description that the PR is AI-assisted.
- **AI-review your own code first** — before requesting maintainer review, run an AI code
  review on your changes and address the findings. This is **required** for AI-assisted PRs
  so maintainers aren't handed large amounts of unreviewed generated code.
- **You own what you submit** — understand the code, not just the prompt.

AI-assisted PRs are held to the same quality standard as any other PR.

## Project Structure

Education Researcher uses the BrainPilot TypeScript workspace layout. The research-domain policy lives in `protocol` and `runtime`; the education research record and handoff API live in `backend-core`; the interface lives in `web`; education methods live under `packages/skills/skills/22_Education/`:

```
Education-Researcher/
├── packages/
│   ├── protocol/        # zod wire SSOT: AG-UI events, domain types, HTTP route contract
│   ├── plugin-sdk/      # plugin manifests, compatibility, packaging, preview RPC
│   ├── plugin-auditor/  # bundled Auditor system-plugin prompts and skill
│   ├── runtime/         # Pi SDK orchestration, SessionManager, mailbox, system tools,
│   │                    #   MCP bridge, Hono + SSE server
│   ├── backend-core/    # Hono REST + SSE passthrough, Orchestrator (Local/Static/Docker)
│   ├── web/             # React/Vite SPA (AG-UI consumer)
│   ├── cli/             # @brainpilot/app — `brainpilot` / `bnpt` Docker-free launch
│   ├── client-cli/      # @brainpilot/client-cli — headless verification client (private)
│   ├── skills/          # @brainpilot/skills — built-in skills content library
│   ├── plugin-got/      # research trace plugin
│   ├── plugin-research/ # research plugin
│   ├── plugin-monitor/  # monitoring plugin
│   ├── kb-scripts/      # packaged KnowledgeBase Python scripts and model sidecar
│   └── docs/            # documentation site workspace (private)
├── docker/              # Dockerfiles & sandbox build hooks
├── scripts/            # smoke tests, release tooling
└── .github/            # issue/PR templates, CI workflows
```

## Contributing a skill

Skills encode research-method guidance and live in `packages/skills/skills/` as a
two-level `<category>/<skill-name>/SKILL.md` tree. Education skills belong under `22_Education`; the runtime exposes only skills allowed for the session's research domain. See the [education research guide](EDUCATION-RESEARCH.md) and the existing skills for the folder layout and source-review expectations. In short:

1. Add `<category>/<skill-name>/SKILL.md` with `name` / `description` / `domain` / `version`
   frontmatter (the `description` helps skill discovery).
2. Put drill-down material under `references/` rather than inline; keep `SKILL.md` under 500
   lines; cite every numerical parameter.
3. `npm run build -w packages/skills`, then restart the runtime to pick it up.

Review claims and citations against primary sources; an AI-generated skill is not itself evidence. The `contribute-skills-via-pr` and `verify-skill` Meta-Skills document the full workflow.

## Upstream release tooling (maintainers)

The following npm and Docker commands belong to the upstream `@brainpilot` release process. This education fork has not published its changes under those package names. Do not use the commands below to distribute this fork without a separate release plan, package ownership, and version review. See [RELEASING.md](RELEASING.md).

### npm packages

```bash
npm login                 # account with @brainpilot scope access
npm run version:check     # verify all workspace package versions are aligned
npm run release:dry       # pack-preview all public packages (no upload)
npm run release           # upstream script publishes 12 public workspaces in dependency order
```

`@brainpilot/client-cli` stays private and is never published.

### Docker images

Image versions match the npm version (root `package.json`). Three images:
`brainpilot-main`, `brainpilot-sandbox` (CPU), `brainpilot-sandbox-gpu` (CUDA torch).

```bash
# one-time: copy the example configs and fill in your mirrors / private registries
cp scripts/release-mirrors.example.sh scripts/release-mirrors.local.sh   # pip/apt mirrors
cp scripts/release-targets.example.sh scripts/release-targets.local.sh   # ACR / intranet registry

# build (default = all; pass a substring to build a subset)
bash scripts/release-build.sh                # all three images
bash scripts/release-build.sh main           # main only
bash scripts/release-build.sh sandbox-gpu    # GPU variant only (large, slow)

# push (docker login each registry first)
bash scripts/release-push.sh --dry-run                              # preview the plan
bash scripts/release-push.sh                                        # all images → all registries
bash scripts/release-push.sh --image sandbox-gpu --registry acr,intranet
```

The GPU image is approximately 10 GB unpacked. Reused layers make subsequent pushes much
smaller, but the first publication can take time. Use a registry endpoint in the build server's
region (for example, an ACR VPC endpoint) when available.

## Reporting Bugs

Use the [Bug Report](https://github.com/Kirihara-Ryouji/Education-Researcher/issues/new?template=bug_report.yml)
template. Include reproduction steps, expected vs. actual behavior, the selected research direction, the source commit or upstream package version, Node version, and sanitized logs. If the issue occurs only in the published upstream npm package, report it to [upstream BrainPilot](https://github.com/NeuroAIHub/BrainPilot/issues).

## Requesting Features

Use the [Feature Request](https://github.com/Kirihara-Ryouji/Education-Researcher/issues/new?template=feature_request.yml)
template. For larger features, please open an issue or discussion first.

## Security Vulnerabilities

**Do not** open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md)
for private reporting via GitHub Security Advisories.

## License

By contributing to Education Researcher, you agree that your contributions will be licensed under the
[GNU AGPL v3](LICENSE).
