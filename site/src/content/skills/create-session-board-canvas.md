---
title: create-session-board-canvas
tagline: "Show a live session progress board with canonical tasks, blockers, and primary/subagent updates."
useWhen: "create a canvas that shows session progress, session progress board, session kanban, show session tasks and agents, go progress board"
repoPath: skills/create-session-board-canvas
thumb: images/thumb-create-session-board-canvas.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill create-session-board-canvas -g --agent github-copilot"
---

## What it does

Show a live session progress board with canonical tasks, blockers, and primary/subagent updates.

Includes read-only kanban, actual agent team, completion percentage, dependency
waits, ready-next tasks, goal history, plan details, and approval/delivery state.
Uses one shared runtime/assets bundle with isolated, resumable session data.
Primary verifies completion; subagent results alone do not mark tasks done.
No coordinator agent or background model loop.

Active work lists the session's explicitly owned PRs and issues, with safe
links and head-pinned CI status/check summaries. It mirrors existing tracking
controls and uses the existing PR workflow for CI; no extra poller is created.
Unknown tracking remains explicit. Wrong-head and out-of-order CI updates cannot
overwrite verified snapshots.

`go` opens/reuses the board by default and carries reporting through `pr`.
Missing canvas support uses text progress without weakening execution gates.
Plain skill-only installs need the approved thin-loader setup described in
the skill README; plugin installs discover the extension automatically.

## Use it

```text
/create-session-board-canvas
```
