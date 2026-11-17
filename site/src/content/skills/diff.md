---
title: diff
tagline: "Open a GitHub-style side-by-side diff viewer in a Copilot App canvas or local browser with inline review comments and structured review triage."
useWhen: "diff, /diff, diff review, visual diff, side-by-side diff, browse diff, review changes in canvas, compare branches, staged diff, unstaged diff, pr diff"
repoPath: skills/diff
thumb: images/thumb-diff.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill diff"
---

## What it does

Opens a GitHub-style side-by-side or unified diff viewer in the native Copilot App `diff` canvas (`canvasId: "diff"`) or in a local browser across Copilot CLI, Claude Code, Cursor, Codex, and Windsurf (`scripts/cli.mjs`) for local Git branches/working trees or GitHub pull requests (`gh pr diff`), with automatic Primer light and dark themes, a collapsible file tree, resizable split panes, `Viewed` tracking, inline line comments, and one-click **Submit Review** handoff back to the agent.

## Use it

```text
/diff
/diff --staged
/diff main..feature
/diff pr 42
/diff review
```
