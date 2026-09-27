# Security Policy — Education Researcher

Education Researcher is a source-run fork of [BrainPilot](https://github.com/NeuroAIHub/BrainPilot). Its education-domain changes are available in this repository's current `main` branch; they are not part of the upstream npm package or hosted service. Report a problem in the project that actually contains the affected code.

## Private vulnerability reports

Do not disclose an exploitable issue in a public issue or discussion. Use this repository's [Security tab](https://github.com/Kirihara-Ryouji/Education-Researcher/security) and its private reporting option when available. Include the affected source revision, reproduction steps, impact, and a minimal sanitized example. Do not include API keys or identifiable student data.

## Deployment and data boundaries

- The research workbench is designed for a **local, single-user** listener. It has no account login or per-user authorization. Do not expose it as a shared public service without adding and testing an access-control boundary.
- In local source mode, agents can read and write within the machine's configured workspace. Avoid placing secrets or identifiable student records in agent-accessible files. A Docker sandbox offers process isolation, but its configuration and host mounts still need review before use with sensitive data.
- Model providers and configured external tools may receive prompts and data. Use only providers and MCP servers approved for the research data involved. The `researchDomains` setting controls which sessions receive a server's tools; it does not make that server trustworthy or erase model knowledge.
- The research workbench generates an **unsent** agent handoff draft from the accepted plan and selected evidence. Research questions and plans are free text and may contain personal information. Review and remove it before sending the draft to a model provider.
- Follow institutional requirements for consent, de-identification, retention, and access to student and participant data. The platform's descriptive analyses and AI answers do not replace that review.

If you find a way to cross an intended boundary, such as reading another session's files or exposing the local research API across origins, please report it privately as above.
