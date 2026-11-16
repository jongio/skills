---
title: diff
tagline: "Open a GitHub-style side-by-side diff viewer in a browser or canvas with inline review comments and structured review triage."
useWhen: "diff, /diff, diff review, visual diff, side-by-side diff, browse diff, review changes in browser, compare branches, staged diff, unstaged diff, pr diff"
repoPath: skills/diff
thumb: images/thumb-diff.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill diff"
---

## What it does

Opens a local GitHub-style side-by-side or unified diff viewer in your browser or Copilot App `browser` canvas with a collapsible file tree, resizable split panes, syntax highlighting, inline line comments, and deterministic `/diff review` triage.

## Use it

```text
/diff
/diff --staged
/diff main..feature
/diff pr 42
/diff review
/diff review list
```
