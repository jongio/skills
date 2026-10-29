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
/ci-hound setup for all my private repos
/ci-hound setup --repos owner/repo1,owner/repo2
/ci-hound status
/ci-hound optimize
/ci-hound stop
```

`watch` runs in bounded chunks (540 seconds by default, reduced for shorter
`COPILOT_TASK_WAIT_TIMEOUT_SECONDS`). `--max-wait-sec <non-negative integer>`
overrides the API/sleep budget; `0` disables chunking. On `WATCH_CHUNK_TIMEOUT`,
report status and re-arm the same full watchlist and options. Requests and
fallback share the remaining deadline; discovery progress, next-repository
cursor, phases and cooldowns persist. Incomplete polls cannot report green,
and rotation neither changes delivery policy nor authorizes a merge.
