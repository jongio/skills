---
title: ci-hound
tagline: "Continuously monitor GitHub Actions workflows with a zero-token ETag-cached background daemon, alert on main failures, repair broken builds in isolated worktrees, and optimize slow or flaky workflows."
useWhen: "ci-hound, monitor main CI, watch GitHub Actions workflows, auto-repair broken main builds, profile slow CI steps, harvest workflow flakes, optimize GitHub Actions"
repoPath: skills/ci-hound
thumb: images/thumb-ci-hound.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill ci-hound -g --agent github-copilot"
---

## What it does

Continuously monitor GitHub Actions workflows with a zero-token ETag-cached background daemon, alert on `main` failures, repair broken builds in isolated worktrees, and optimize slow or flaky workflows.

## Use it

```text
/ci-hound
/ci-hound --merge=auto
/ci-hound status
/ci-hound optimize
/ci-hound stop
```
