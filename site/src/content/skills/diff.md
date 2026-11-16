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

Opens a GitHub-style side-by-side or unified diff viewer in the native Copilot App `diff` canvas (or standalone zero-CDN browser viewer in terminal CLIs) with automatic Primer light/dark themes, a collapsible file tree, resizable split panes, `Viewed` tracking, inline line comments, and deterministic `/diff review` triage.

## Use it

```text
/diff
/diff --staged
/diff main..feature
/diff pr 42
/diff review
/diff review list
```
