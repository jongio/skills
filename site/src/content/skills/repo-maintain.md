---
title: repo-maintain
tagline: "Run an end-to-end repository maintenance pass across governance, dependencies, security, refactoring, coverage, docs, skills, and evals on a single rolling branch."
useWhen: "repo-maintain, maintain repo, repo maintenance pass, automated repository maintenance, health score, repo-maintain/automated"
repoPath: skills/repo-maintain
thumb: images/thumb-repo-maintain.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill repo-maintain"
---

## What it does

Run an end-to-end repository maintenance pass across governance, dependencies, security, refactoring, coverage, docs, skills, and evals on a single rolling branch (`repo-maintain/automated`).

Defaults to **Zero-Touch Auto-Create & Auto-Merge** (`"autoMerge": true` and `"copilotReview": false` in `.github/repo-maintain.json`): when Phases 1-6 produce verified changes and all local tests plus GitHub Actions CI checks pass (`MERGEABLE`/`CLEAN`), `repo-maintain` automatically pushes `repo-maintain/automated`, opens/updates the PR, runs `pr --merge=auto --no-copilot` (`pr-watch-daemon.mjs watch --no-copilot`), and squash-merges (`--match-head-commit`) + deletes the branch without asking for manual approval. It also auto-fixes mechanical companion syncs on open Dependabot/Renovate PRs (such as `RequiredAzdVersion`, Go toolchain floors for `govulncheck`, or lockstep `codeql-action/*` SHA pins) and escalates to `Needs My Attention` only on unresolvable CI failures, semver-major breaking changes, or Level 3 architectural design questions.

- **Phase 0 SHA-receipt skip check & maintainer triage:** skips no-op runs when `HEAD` matches `lastMaintainSha` with green CI and no new advisories; triages external issues and PRs into Quarantine (Tier 1), Maintainer Direction (Tier 2), and Auto-Assist (Tier 3) queues.
- **Phases 1-6 in one isolated worktree (`repo-maintain/automated`):** runs governance & runtime parity (`repo-ready` + `ci-doctor`), vetted dependency updates & license screening (`deps-doctor`), Stealth Public Mode security hardening (`secops-doctor`), Level 1-2 idiomatic refactoring (`refactor`), branch & diff coverage gates (`test-doctor`), and doc/skill/eval validation (`doc-doctor` + `skill-doctor` + `eval-doctor`).
- **0-100 Repo Health Score (Grade `A+` to `F`) & post-merge release check:** computes weighted health evidence across 7 dimensions and invokes `release-doctor` once `repo-maintain/automated` merges cleanly.

## Use it

```text
/repo-maintain
/repo-maintain status
/repo-maintain run
/repo-maintain --stages deps,secops,coverage
/repo-maintain --all --visibility all
```
