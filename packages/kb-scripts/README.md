# @brainpilot/kb-scripts — retained upstream knowledge-base pipeline

**Content-only package.** This fork retains the BrainPilot KnowledgeBase Python
pipeline (setup, build, model-server scripts, and `requirements.txt`) for
compatibility with the upstream neuroscience workflow. It is **not an education
paper corpus or education retrieval pipeline**. New education sessions do not
receive the two built-in local knowledge/paper tools, even if this pipeline has
been prepared. For education literature, use checked source records in the
[research workspace](../../EDUCATION-RESEARCH.md) and explicitly configured
education MCP retrieval tools.

The package published on npm under this upstream name does not contain the
Education Researcher fork's domain settings. Run this repository from source
for those settings.

The `kb/` directory is populated by this package's `prepack` lifecycle hook
(`scripts/stage.mjs`) from the canonical `KnowledgeBase/` at the BrainPilot
repo root; it is deliberately absent from git. Every published tarball
includes `kb/scripts/`, `kb/server/`, `kb/requirements.txt` and
`kb/README.md`. (The `.gitignore` at the KnowledgeBase root is not staged
— npm strips dotfiles at the package root from tarballs, and the file
is purely cosmetic in the materialised `~/.brainpilot/KnowledgeBase/`
which is not a git repo.)

## How it reaches an installed upstream user

On the first `brainpilot up` from an installed upstream package (or backend
startup in a container), the runtime calls `materializeKb()`
(`packages/runtime/src/materialize-kb.ts`). If the bundled npm content is the
effective source, it copies `kb/` into `~/.brainpilot/KnowledgeBase/`.
`findKbRoot()` and `detectKbRoot()` can then find the build scripts and model
sidecar there.

`BP_KB_ROOT`, if set, still wins — the materialisation is a no-op then.

In this source fork, use `npm run bp -- up` from the repository root. The
checkout's sibling `KnowledgeBase/` is used directly, so the materialization
step is skipped. The education profile prevents its local retrieval tools
from being offered to education agents.

## Editing scripts

Edit `KnowledgeBase/*` at the repo root — this package is a mirror.
`npm pack --workspace=@brainpilot/kb-scripts` runs `prepack` to refresh
`kb/` deterministically before the tarball is written.
