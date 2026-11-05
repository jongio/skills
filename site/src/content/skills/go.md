---
title: go
tagline: "Plan, test, and implement the current context, then hand verified changes to pr for delivery and merge."
useWhen: "/go, implement this context end to end, take this issue from plan to merge"
repoPath: skills/go
thumb: images/thumb-go.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill go --skill test-doctor --skill pr --skill doc-doctor --skill create-session-board-canvas"
---

## What it does

Plan, test, and implement the current context, then hand verified changes to pr for delivery and merge.

Requires `test-doctor` and `pr`, plus `doc-doctor` for PR preflight; install those skills too, or choose the full collection above.
Before handing off to `pr`, `go` audits the final diff for scope minimality (stripping superseded scaffolding and dead flags/helpers from abandoned approaches), cross-file CLI/function call contracts, lifecycle/state-machine symmetry, and fail-closed mutations, and invokes the repository's local `code-review` skill in local/branch mode when present or runs one bounded, read-only cross-model `rubber-duck` sub-agent review using a different model family than the active model when available (supplying the diff/test summary and contract checklist and forbidding sub-agent test/lint/build execution).
Only `pr` runs the documentation pass; `go` does not duplicate it.
At every workflow stage transition (`Worktree`, `test-doctor`, `Implementation`, `rubber-duck`, `PR` handoff), before launching any synchronous `task`/`research`/`rubber-duck` sub-agent or blocking `read_powershell` wait, and when acknowledging mid-run user messages, `go` requires a 1-line user-visible status update in `assistant.message.content` outside `<thought>` alongside the tool call (and outputs the Step 1 plan in visible `assistant.message.content` before invoking `test-doctor`).

When explicitly requested by the user, `go` opens/reuses a session progress
canvas with live kanban, primary/subagent reports, task percentage, blockers,
and delivery status; it is not created by default when not requested.
Install `create-session-board-canvas` for the board. Its runtime/assets are
shared, but each session's data and goal history stay isolated. Missing canvas
support uses a disclosed text fallback; all execution and merge gates remain.

Scope follows affected user journeys and their shared behavior owner, not just
edited files. Test Doctor checks equivalent entry points against one intended
contract; `pr` receives that evidence and justified differences. This does not
authorize broader edits or a whole-repository audit.
Identify trust boundaries and host/native fixture prerequisites before coding.
Missing host evidence stays an explicit gap; a local smoke test cannot establish
cross-host success.

## Install with required skills

The single-skill options above do not install dependencies. Use this command
to install `go` and every required skill, or choose the full collection.

```sh
npx skills add jongio/skills --skill go --skill test-doctor --skill pr --skill doc-doctor --skill create-session-board-canvas
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
