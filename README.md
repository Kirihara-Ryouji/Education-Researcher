# Education Researcher

An education research workspace built on the open-source [BrainPilot](https://github.com/NeuroAIHub/BrainPilot) platform. It combines versioned study records, source checks, basic data analysis, report drafting, and agent-assisted research. **New agent sessions default to education research.** Neuroscience remains an explicit option for work that needs the upstream resources.

> **Use this repository from source.** The published `@brainpilot/app` package and `brainpilot.chat` are upstream BrainPilot releases and do not contain this fork's education-domain changes. The underlying model still comes from the provider you configure; a domain setting cannot erase its pretrained knowledge. See the [usage guide](EDUCATION-RESEARCH.md) for the workflow and limits.

[简体中文](README-zh.md) · [Get started](#get-started) · [Education workflow](#education-research-workflow) · [Resources](#methods-and-research-resources) · [Evaluation](#evaluation-status) · [Upstream and license](#upstream-project-and-attribution)

## What this project does

The research workspace keeps the researcher's decisions and supporting material in one place. Agents can help explore a question, but the researcher accepts plans, evidence claims, analyses, and reports.

| Step | Available in this repository |
| --- | --- |
| Define a study | Create projects and version a study's question, purpose, approach, and educational context. |
| Check sources | Register sources, attach PDF/DOCX/TXT/Markdown files, inspect excerpts, and record what a source actually supports. |
| Plan and analyze | Review and accept a research plan; run supported cleaning and descriptive analyses on data with traceable versions. |
| Write a report | Build versioned reports from accepted claims, including analysis results when used, with citation and freshness checks. |
| Continue with agents | Create an education session from the current accepted plan. A **draft** handoff includes at most 12 content-checked publication excerpts with citations; inspect it before sending. |

For example, a researcher could define a study of formative feedback in secondary-school mathematics, register the intervention literature, record evidence about outcomes and limitations, review a feasible comparison plan, and then ask an agent to examine open questions. This is an example workflow, **not a reported study result**.

## Get started

Requirements: **Node.js 22.13.0 or newer** and, for real agent responses, access to a supported model provider. From this repository's root:

```sh
npm ci
npm run build
npm run bp -- up
```

Open the local address printed in the terminal. In **Settings → Providers**, add and activate your model provider. The app can launch without a key, but real agent tasks require one. To inspect the interface without calling a model, start with `BP_MOCK=1`; mock responses do not test research quality.

On Windows PowerShell, set mock mode with `$env:BP_MOCK = '1'` before `npm run bp -- up`. Stop a foreground run with `Ctrl+C`. The CLI stores local data under `./brainpilot` by default; `BP_DATA_DIR` or `--dir` selects another location. Run source CLI commands from the repository root.

The published package command `npm install -g @brainpilot/app` installs **upstream BrainPilot**, not this education fork. For optional container deployment from source, see the [Docker guide](packages/docs/content/docs/docker.mdx); its upstream examples may need adapting to this fork's environment.

## Education research workflow

1. Open **Research workspace** and create a project and study. Record the educational setting, participants, question, method, and uncertainties.
2. Add sources and original files. Check each publication's identity, locator, excerpt, and the specific claim it supports. Mark uncertain material for review.
3. Draft and accept a current research plan. Revise it if the study definition or cited file versions change.
4. If using data, inspect missingness and provenance, then use the supported cleaning and descriptive analysis flow. Check the result before accepting a claim or using it in a report.
5. Choose **Continue with an education agent** from an accepted plan. The app opens a new education session with an **unsent** context draft. Review its question, plan, citations, and any free text for identifiable student information before sending.
6. Review the agent's sources and reasoning. Accept or revise claims and report versions in the workspace.

The handoff does not attach raw files, CSVs, or participant records, and it is not a fresh verification of the cited publications. See the [full education guide](EDUCATION-RESEARCH.md) for the exact scope and [acceptance cases](EDUCATION-EVALUATION.md) for checks you can run with your own model provider.

## Methods and research resources

Six bundled education skills cover [evidence reviews](packages/skills/skills/22_Education/education-evidence-review/SKILL.md), [study design](packages/skills/skills/22_Education/education-study-design/SKILL.md), [measurement](packages/skills/skills/22_Education/education-measurement/SKILL.md), [qualitative inquiry](packages/skills/skills/22_Education/education-qualitative-inquiry/SKILL.md), [learning analytics and privacy](packages/skills/skills/22_Education/learning-analytics-privacy/SKILL.md), and [education AI evaluation](packages/skills/skills/22_Education/education-ai-evaluation/SKILL.md). The [source index](packages/skills/skills/22_Education/AUTHORITATIVE_SOURCES.md) points to official methods and ethics resources. It is a list of entry points, **not a downloaded full-text education paper library**. Verify original papers and citations before relying on a result.

Research direction is fixed when a session is created:

| Session | Bundled resources |
| --- | --- |
| **Education** (new-session default) | Education skills and selected general-purpose skills. The original local neuroscience knowledge/paper tools are unavailable. |
| **Neuroscience** (explicit choice) | Upstream neuroscience methods and local knowledge tools, when configured. |
| **Older sessions without a direction tag** | Restore as neuroscience to preserve their original context. Create a new education session to use the education profile. |

External MCP servers can be marked for education, neuroscience, or both in **Settings → MCP**. An older server configuration without a domain tag remains neuroscience-only until you explicitly opt it into education. The original public dataset catalog and `KnowledgeBase/` pipeline remain available as upstream neuroscience resources; merely viewing a catalog entry does not make it evidence for an education answer.

## Data and safety boundaries

The local app is a **single-user workspace** with no research-workspace login or multi-user permission layer. In local process mode, agents can use local tools on your machine; a Docker sandbox is a separate deployment choice. Use fictional or properly de-identified examples while learning the workflow. For actual student data, complete the relevant institutional consent, access, de-identification, and provider arrangements first. Keep provider credentials in local settings, outside chat text and the repository.

Domain controls select prompts and available resources; they do not fine-tune or retrain the underlying model. Review every important methodological decision, citation, and claim against its original source.

## Evaluation status

Code tests have checked the education default, restoration of older neuroscience sessions, bundled and external tool boundaries, and the workspace handoff. The full build and web regression suite also passed at the last recorded run; see the [dated verification record](EDUCATION-EVALUATION.md). **Education-domain answer quality has not yet been evaluated with a configured live model provider.** The E1–E6 cases in that document are acceptance tasks, not achieved benchmark scores.

The published ALE and BrainPilotBench-v0 results belong to **upstream BrainPilot's neuroscience tasks**. They do not measure this fork's education research quality. See the [upstream repository](https://github.com/NeuroAIHub/BrainPilot) and [upstream benchmark page](https://brainpilot.chat/bench) for those historical results.

## Architecture and development

This is a TypeScript npm workspace with **14 packages**. The inherited `@brainpilot/*` package names identify code modules; they do not mean this fork is published under those package names.

| Area | Main directory | Responsibility |
| --- | --- | --- |
| Contracts | `packages/protocol` | Session, research-domain, event, and API types. |
| Agent runtime | `packages/runtime` | Sessions, prompts, specialists, tools, MCP isolation, and trace events. |
| Research backend | `packages/backend-core` | Research records, source and report APIs, HTTP backend, and runtime orchestration. |
| Web interface | `packages/web` | Research workspace, agent chat, domain selection, and settings. |
| Method content | `packages/skills` | Education and retained upstream skills. |
| Launch and tooling | `packages/cli`, `packages/client-cli`, `packages/kb-scripts`, `packages/plugin-*`, `packages/docs` | Local launch, verification, optional upstream knowledge tools, plugins, and documentation. |

To check a change, run `npm run build` and `npm test`; the web package has its own test script. See [CONTRIBUTING.md](CONTRIBUTING.md) for development details and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Upstream project and attribution

Education Researcher is derived from [NeuroAIHub/BrainPilot](https://github.com/NeuroAIHub/BrainPilot). The upstream project introduced the multi-agent research platform and [Graph of Trace](https://aclanthology.org/2026.acl-demo.29/); its [brain-science paper](https://arxiv.org/abs/2607.15079), [release history](CHANGELOG.md), case studies, and benchmark results remain upstream work. This fork has **no independent education benchmark or paper** to cite at present. When referring to upstream methods or results, credit their original authors rather than presenting them as education findings.

The code retains the upstream **[GNU AGPL v3](LICENSE)** license and attribution. Contributions to this fork should follow that license and cite the upstream work where appropriate.
