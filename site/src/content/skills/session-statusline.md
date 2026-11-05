---
title: session-statusline
tagline: "Manage only the current session's active statusline pills, custom session name, and refresh/clear controls without deleting work or changing enabled components."
useWhen: "name this session, custom statusline name, label this terminal session, rename session label, clear session name, clear statusline, clear footer pills, remove a PR pill, remove an issue pill, clear agent pills, track active session work, refresh session statusline"
repoPath: skills/session-statusline
thumb: images/thumb-session-statusline.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill session-statusline"
---

## What it does

Manage only the current session's active statusline pills and custom footer name in Copilot CLI without deleting work or changing enabled components.

- **Custom session names:** set, inspect, or clear a single-line session label (`name`, `clear-name`) that appears first in that session's enabled footer and persists on resume.
- **Session-bound pill controls:** list, add, remove, or clear tracked PRs (`session_prs`) and issues (`session_issues`), list, remove, or clear tracked subagents (`session_subagents`), or clear/refresh the entire session footer at once (`session_statusline`).
- **Explicit enrollment only:** all PR and issue enrollment is explicit; shell commands, GitHub writes/results, references, and lookups never add pills. Actual session agent launches remain automatic.
- **Copilot CLI–only:** included in the full `jongio-skills` plugin and backed by the statusline SDK extensions in Copilot CLI (automatically disabled when hosted in the GitHub Copilot app).

## Use it

```text
name this session API migration
clear the footer pills
/session-statusline name API migration
/session-statusline clear-name
/session-statusline refresh
/session-statusline clear
/session-statusline setup
/session-prs remove owner/repo#123
/session-issues clear
/session-subagents clear
```

Clearing dismisses tracking, not work: issues/PRs stay open, agents keep running,
transcripts and worktrees remain, custom session names are preserved, and enabled components do not change.
