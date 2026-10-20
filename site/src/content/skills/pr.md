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
command, and verify actual merged state rather than enabling GitHub auto-merge.

## Install with required skills

The single-skill options above do not install dependencies. Use this command
to install `pr` and every required skill, or choose the full collection.

```sh
npx skills add jongio/skills --skill pr --skill test-doctor --skill doc-doctor -g --agent github-copilot
```

## Use it

```text
/pr
/pr --merge=approval
/pr --merge=auto
```

By default, `pr` asks for final merge approval with the PR, repository, full head
OID, and strategy after readiness gates pass. Choose `--merge=auto` (or "auto
merge") to skip only that final prompt; `--merge=approval` (or "ask me before
merging") requires it. A validated `go` handoff preserves the choice, and a later
explicit user choice overrides it. Choices apply only to the current invocation;
standing policies and reviewer approvals do not override the default.
Changed heads or strategies require fresh confirmation in approval mode.
Declined or unavailable confirmation leaves the PR awaiting approval, not merged.
Auto mode preserves all CI, review, feedback, and other approval gates and does
not enable GitHub's `--auto` queue.
Both modes default to squash merging and deleting the PR branch afterward
(`--squash --delete-branch`), unless explicitly overridden. Cleanup is verified
separately; blocked local cleanup is reported rather than forced or claimed done.
