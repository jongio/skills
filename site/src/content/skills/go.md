---
title: go
tagline: "Plan, test, and implement the current context, then hand verified changes to pr for delivery and merge."
useWhen: "/go, implement this context end to end, take this issue from plan to merge"
repoPath: skills/go
thumb: images/thumb-go.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill go --skill test-doctor --skill pr --skill doc-doctor -g --agent github-copilot"
---

## What it does

Plan, test, and implement the current context, then hand verified changes to pr for delivery and merge.

Requires `test-doctor` and `pr`, plus `doc-doctor` for PR preflight; install those skills too, or choose the full collection above.
Only `pr` runs the documentation pass; `go` does not duplicate it.

## Install with required skills

The single-skill options above do not install dependencies. Use this command
to install `go` and every required skill, or choose the full collection.

```sh
npx skills add jongio/skills --skill go --skill test-doctor --skill pr --skill doc-doctor -g --agent github-copilot
```

## Use it

```text
/go
```
