---
title: pr
tagline: "A concise checklist workflow for taking changes from local commit and preflight checks through PR submission, review resolution, CI monitoring, and merge."
useWhen: "PR checklist, prepare a PR, submit a PR, monitor a PR, address PR feedback, merge a PR"
repoPath: skills/pr
thumb: images/thumb-pr.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill pr --skill test-doctor --skill doc-doctor -g --agent github-copilot"
---

## What it does

A concise checklist workflow for taking changes from local commit and preflight checks through PR submission, review resolution, CI monitoring, and merge.

Requires `test-doctor` and `doc-doctor`. PR preflight owns the documentation pass,
including when called by `go`, and reuses matching passing evidence.

Preserves the PR template and records exact validation commands and results.
Expects Copilot review unless an explicitly authorized, verified private-owner
exception applies; posted feedback remains in scope. Every expected review must
complete on the full current head OID, with `COMMENTED` distinct from approval.
Merges require authorization and all gates satisfied, use a literal head-pinned
command, and verify actual merged state rather than enabling auto-merge.

## Install with required skills

The single-skill options above do not install dependencies. Use this command
to install `pr` and every required skill, or choose the full collection.

```sh
npx skills add jongio/skills --skill pr --skill test-doctor --skill doc-doctor -g --agent github-copilot
```

## Use it

```text
/pr
```
