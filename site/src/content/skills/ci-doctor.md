---
title: ci-doctor
tagline: "Diagnose, check, and optimize GitHub Actions workflows with stateless ETag-cached checkups, main failure root-cause repair in isolated worktrees, and workflow cost/security hardening."
useWhen: "ci-doctor, ci health check, diagnose main CI failures, repair broken GitHub Actions builds, profile slow CI steps, harvest workflow flakes, harden and optimize GitHub Actions workflows"
repoPath: skills/ci-doctor
thumb: images/thumb-ci-doctor.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill ci-doctor"
---

## What it does

Diagnose, check, and optimize GitHub Actions workflows with stateless ETag-cached checkups (`scripts/ci-doctor-daemon.mjs`), repair broken `main` builds in isolated worktrees, and harden workflow performance and security.

- **Stateless ETag-cached checkups (`scripts/ci-doctor-daemon.mjs`):** runs instant `status`, `diagnose`, and `optimize` checkups (plus bounded `watch` chunks when awaiting active runs) reusing `If-None-Match` (`304 Not Modified`) and `updated_at` deltas at zero rate-limit cost.
- **GitHub Actions workflow optimization & hardening:** checks runner cost right-sizing, lockfile-keyed dependency caching, concurrency cancellation groups, 40-char commit SHA pinning, `zizmor`/`actionlint` script-injection hardening, and least-privilege `permissions`.
- **Two-tier telemetry:** Tier 1 checks `main` (`push`, `workflow_dispatch`, `schedule`) for instant job-level failure diagnosis and isolated worktree auto-repair; Tier 2 harvests step/job durations, queue wait times, and recurring flake signatures across all runs including pull requests.
- **Multi-repository portfolio setup (`/ci-doctor setup`):** check the current repository by default, an explicit `--repos` list, or dynamic owner scopes (`--all-my-repos --visibility private`, `--owner <login> --visibility <all|private|public>`).
- **Context-aware delivery routing:** routes new incident repairs and workflow optimizations through `go` (`test-doctor fix` -> `pr`), and routes existing fix worktrees or open in-flight PRs directly through `pr`.
- **Optional Copilot CLI timeline bridge:** subscribe with `/daemon-notifications subscribe ci` and pass `--events-file "<returned-file>"` to log watcher transitions into the session timeline without model calls.

## Use it

```text
/ci-doctor
/ci-doctor status
/ci-doctor diagnose
/ci-doctor optimize
/ci-doctor fix --merge=auto
/ci-doctor setup for all my private repos
/ci-doctor setup --repos owner/repo1,owner/repo2
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
