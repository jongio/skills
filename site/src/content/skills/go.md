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
/go --merge=approval <context>
/go --merge=auto <context>
```

By default, `go` works in a linked worktree and reuses an existing worktree
without prompting. In the main checkout, it asks **Create worktree (default)**
or **Stay here** before tests or edits, even in merge auto mode. Staying applies
only to this invocation; existing edits remain protected.

By default, `go` asks for final merge approval through `pr`. Choose
`--merge=auto` (or "auto merge") to merge after all checks and reviews pass
without another merge prompt; `--merge=approval` (or "ask me before merging")
requires confirmation. The choice is passed to `pr` for this invocation only.
Standing policies and reviewer approvals do not override the default.
Auto mode does not enable GitHub's `--auto` queue or bypass other approval
boundaries. Missing confirmation pauses delivery as awaiting approval, not merged.
Both modes default to squash merging and deleting the PR branch afterward.
Explicit requests for another strategy or keeping the branch are passed to `pr`.
