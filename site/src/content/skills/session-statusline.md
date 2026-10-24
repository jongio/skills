---
title: session-statusline
tagline: "Manage only the current session's active statusline pills and clear entries without deleting work or changing enabled components."
useWhen: "clear statusline, clear footer pills, remove a PR pill, remove an issue pill, clear agent pills, track active session work, refresh session statusline"
repoPath: skills/session-statusline
thumb: images/thumb-session-statusline.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill session-statusline -g --agent github-copilot"
---

## What it does

Manage only the current session's active statusline pills and clear entries without deleting work or changing enabled components.

Included in the full `jongio-skills` plugin. Requires the statusline extensions
to execute session-bound controls. All PR and issue enrollment is explicit;
shell commands, GitHub writes/results, references, and lookups never add pills.
Actual session agent launches remain automatic. Upgrades drop unowned legacy
entries; explicitly re-add any work this session still owns.

## Use it

```text
clear the footer pills
/session-statusline clear
/session-prs remove owner/repo#123
/session-issues clear
/session-subagents clear
```

Clearing dismisses tracking, not work: issues/PRs stay open, agents keep running,
transcripts and worktrees remain, and enabled components do not change.
