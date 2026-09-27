# Local launcher for Education Researcher

This source directory retains the upstream npm package name `@brainpilot/app`. In **this repository**, the CLI launches the Education Researcher fork: new agent sessions default to education research, and neuroscience is an explicit choice. The package currently published on npm under `@brainpilot/app` is **upstream BrainPilot** and does not contain this fork's education changes.

The launcher starts a single-user Hono backend and React interface. It does not train a model or supply a model provider. See the [repository README](../../README.md) and [education usage guide](../../EDUCATION-RESEARCH.md) for the research workflow.

## Run this fork from source

Use Node.js **22.13.0 or newer**. At the repository root:

```sh
npm ci
npm run build
npm run bp -- up
```

Open the local URL printed by the command. Add and activate a model service in **Settings → Providers** before running real agent tasks. The app can open without a key; `BP_MOCK=1` enables a deterministic smoke run that cannot evaluate education research quality. In Windows PowerShell, run `$env:BP_MOCK = '1'` before starting the app.

Source CLI commands must run from the repository root unless a data directory is set explicitly with `BP_DATA_DIR` or `--dir`. The default data directory is `./brainpilot` under the current directory. Stop a foreground run with `Ctrl+C`.

For a detached run:

```sh
npm run bp -- up --detach
npm run bp -- status
npm run bp -- logs
npm run bp -- down
```

The CLI also supports `--port <n>`, `--dir <path>`, and `--no-open`. `npm run bp -- init` can configure a provider from the command line; the web **Providers** setting is usually simpler and avoids putting credentials into shell history.

## Upstream npm distribution

The following commands install and run the **published upstream BrainPilot release**. They are shown only to distinguish that distribution from this fork:

```sh
npm install -g @brainpilot/app
brainpilot up
```

That published CLI also exposes the `bnpt` alias. Its version, behavior, and hosted documentation are maintained by [NeuroAIHub/BrainPilot](https://github.com/NeuroAIHub/BrainPilot), not by this fork.

## Optional plugins

This fork retains the upstream plugin importer. For an unpacked local plugin directory, use the source CLI:

```sh
npm run bp -- plugin import ./plugin --format claude-code --dir ./brainpilot
```

The importer accepts `codex`, `claude-code`, and `pi-package` formats. Enabling an imported plugin can run its command hooks and introduce MCP tools. Check a plugin before enabling it, and check its MCP research-domain assignment: education sessions only receive servers explicitly allowed for education. Start a new session after changing MCP or hook configuration.

## Attribution

This CLI is derived from upstream BrainPilot and remains under the repository's [GNU AGPL v3 license](../../LICENSE). The fork-specific education behavior is documented in this repository; upstream's release history and documentation are linked from the [main README](../../README.md).
