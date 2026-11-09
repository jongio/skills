---
title: release-doctor
tagline: "Verify post-merge release readiness, unreleased commits, semver recommendations, and cross-manifest version parity before cutting a release."
useWhen: "release doctor, release-doctor, needs release, release readiness check, version parity audit, semver recommendation"
repoPath: skills/release-doctor
thumb: images/thumb-release-doctor.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill release-doctor"
---

## What it does

Verify post-merge release readiness, unreleased commits, semver recommendations, and cross-manifest version parity before cutting a release.

- **Unreleased commit classification (`<latestTag>...<defaultBranch>`):** compares the default branch against the latest GitHub Release or semver tag and separates non-releasable commits (`.github/` CI plumbing, docs, tests) from shippable `patch`, `minor`, and `major` changes.
- **Cross-manifest version parity audit:** verifies synchronized versions across `package.json`, `package-lock.json`, `plugin.json`, `marketplace.json`, `.claude-plugin/*`, `.codex-plugin/*`, `.cursor-plugin/*`, `gemini-extension.json`, `skills/*/SKILL.md`, `extension.yaml`, `Cargo.toml`, `pyproject.toml`, `Directory.Build.props`, `version.go`, and `CHANGELOG.md`.
- **Default-branch CI quality gate:** confirms `HEAD` workflow runs and check-runs on `main`/`master` are green before recommending or executing a release, routing any failing checks to `ci-doctor`.
- **Native release mechanism detection:** discovers and dispatches `.github/workflows/release.yml` (`workflow_dispatch`), repository release scripts (`npm run release`, `goreleaser`, `changeset publish`), or `gh release create` with dry-run reporting and Stealth Public Mode release notes.

## Use it

```text
/release-doctor
/release-doctor audit
/release-doctor --dry-run
```
