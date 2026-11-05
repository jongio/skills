---
title: ci-hound
tagline: "Continuously monitor GitHub Actions workflows with a zero-token ETag-cached background daemon, alert on main failures, repair broken builds in isolated worktrees, and optimize slow or flaky workflows."
useWhen: "ci-hound, monitor main CI, watch GitHub Actions workflows, auto-repair broken main builds, profile slow CI steps, harvest workflow flakes, optimize GitHub Actions"
repoPath: skills/ci-hound
thumb: images/thumb-ci-hound.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill ci-hound"
---

## What it does

Continuously monitor GitHub Actions workflows with a zero-token ETag-cached background daemon, alert on `main` failures, repair broken builds in isolated worktrees, and optimize slow or flaky workflows.

- **Zero-token background daemon (`scripts/ci-hound-daemon.mjs`):** polls every `15s` while `main` runs are active and `60s` when idle, reusing `If-None-Match` (`304 Not Modified`) and `updated_at` deltas at zero rate-limit cost, and wakes the agent on `JOB_FAILED`, `WORKFLOW_FAILED`, `NEW_MAIN_COMMIT`, `WATCHED_RUNS_GREEN`, or deduplicated `ALL_GREEN`.
- **Two-tier monitoring:** Tier 1 watches `main` (`push`, `workflow_dispatch`, `schedule`) for instant job-level failure alerts and isolated worktree auto-repair; Tier 2 harvests step/job durations, queue wait times, and recurring flake signatures across all runs including pull requests.
- **Multi-repository portfolio setup (`/ci-hound setup`):** watch the current repository by default, an explicit `--repos` list, or dynamic owner scopes (`--all-my-repos --visibility private`, `--owner <login> --visibility <all|private|public>`).
- **Context-aware delivery routing:** routes new incident repairs and workflow optimizations through `go` (`test-doctor fix` -> `pr`), and routes existing fix worktrees or open in-flight PRs directly through `pr`.
- **Optional Copilot CLI timeline bridge:** subscribe with `/daemon-notifications subscribe ci` and pass `--events-file "<returned-file>"` to log watcher transitions into the session timeline without model calls.

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
Owner inventory and completed repository results survive until the logical
sweep finishes. Aggregate green requires every target in that sweep; changed
scope or superseding saved head/poll identities invalidate carried results.
Cooldown rotations retain the last completed status snapshots without API calls.
