# Releasing Education Researcher

This fork is currently delivered as source through [Kirihara-Ryouji/Education-Researcher](https://github.com/Kirihara-Ryouji/Education-Researcher). Its education changes have not been published under the upstream `@brainpilot/*` packages, Docker images, or hosted service.

## Source delivery checklist

1. Record the candidate commit and review changes to education defaults, source handling, MCP domain access, and research handoff.
2. Run `npm ci`, `npm run typecheck`, `npm test`, `npm test -w @brainpilot/web`, `npm run docs:check`, and `npm run build`. Record skipped tests and any environment-specific limits.
3. Review [education evaluation cases](EDUCATION-EVALUATION.md). Real-model answer quality needs a configured provider and manual source review; mock responses are insufficient.
4. Check both READMEs, the education guide, docs site, security guidance, and source attribution. Ensure examples use de-identified data and do not imply that upstream npm or Cloud already contains the fork.
5. Publish the reviewed source commit to this repository, verify the remote tree and links, and package the exact tracked source files. Record the archive checksum and the remote commit.

## Upstream BrainPilot publication workflow (reference only)

The sections below describe the inherited npm, image, and Cloud release process. They are not an approved publication plan for this fork. Before using them, establish package ownership, versioning, target registries, support commitments, and a separate review of the candidate.

### Prepare and accept the candidate

1. Freeze the selected changes and merge their reviewed PRs through branch protection.
2. Record the designated main SHA. Run `npm ci`, `npm run typecheck`, `BP_MOCK=1 npm test`,
   `npm test -w @brainpilot/web`, `npm run docs:check`, and `npm run build`.
3. Exercise real critical desktop journeys, authentication boundaries, download cancellation
   and recovery, file/history persistence, and supported provider and CPU/GPU environments.
   A CI job that skips private testbed assets is not full black-box acceptance.
4. Pack the 12 public workspaces and inspect contents. Test an isolated fresh installation
   and an upgrade from the prior release with retained configuration, history and data.
5. Review version/dependency/lockfile changes, README in both languages, CHANGELOG, release
   notes and all current installation/image examples. Preserve historical version records.
   Check `npm run version:check` after the approved version update.

### Documentation is a release artifact

Update both languages under `packages/docs/content/docs/`, navigation metadata, explicit
English routes and the export checks. Update `KnowledgeBase/README.md` when its bundled
workflow changes; `@brainpilot/kb-scripts` stages this manual into its tarball. Check README
links, commands, local versus hosted availability, and any in-app guides maintained downstream.

Build and inspect the static site, including tables, code, links and localized pages. Hosted
Cloud vendors content at an exact OSS commit and builds its own site shell; record that commit
and verify the deployed `/docs` routes. Updating this repository alone does not update the
hosted documentation.

### Publish approved artifacts

Before version metadata PRs, tags, package/image publication, production changes or community
announcements, confirm the concrete action and its targets under the current release plan.
Resolve registry access, capacity, backup and rollback readiness first. Reuse approval for an
unchanged action; obtain a new decision when the candidate or exposure changes.

- Publish public npm workspaces in dependency order using the release scripts and verify each
  exact version and integrity before dependent steps. Keep private workspaces unpublished.
- Build recorded clean source with `scripts/release-build.sh` and the image inventory in
  `scripts/release-images.sh`. It includes main, CPU sandbox and GPU sandbox; the separately
  versioned GPU base is reused unless its dependencies actually change.
- `scripts/release-push.sh` distributes existing images to configured registries. Confirm all
  required registries and `linux/amd64` artifacts, digests and anonymous pull behavior where
  promised. The scripts also update `latest`; coordinate automatic update jobs before pushing.
- Never overwrite a published version tag. Inspect remote state after an ambiguous result
  before retrying. Publish the GitHub tag/release with matching notes and source identity.

### Roll out and close

Cloud is a separate release: update it to the published OSS packages, resolve the real lockfile,
rebuild hosted assets and verify the paired sandbox versions. Use its approved deployment
entrypoint and staged health gates. Preserve user roots, credentials, database/blob compatibility
and unrelated services. Record and restore timer/worker state.

Verify installed CLI and service versions, image digests, critical user flows, docs, persistence
and logs. Observe for the release plan's stated window; stop dependent steps on failure and
follow the approved rollback plan. Record code merged, packages/images published, services
deployed, documentation delivered and release accepted separately. Send only the authorized
announcements, and state any outstanding acceptance or explicitly deferred scope.
