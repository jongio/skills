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

## Use it

```text
/repo-maintain
```
