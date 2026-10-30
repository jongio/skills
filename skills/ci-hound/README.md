# ci-hound

Continuously monitor GitHub Actions workflows with a zero-token ETag-cached background daemon, alert on `main` failures, repair broken builds in isolated worktrees, and optimize slow or flaky workflows.

## Features

- **Zero-Token Background Daemon (`scripts/ci-hound-daemon.mjs`)**: Runs in an async background shell, streams live job-progress `PHASE_CHANGED` updates (`N/M jobs passed; active: ...`) on step transitions and 60s heartbeats, and wakes the agent session when an actionable event occurs (`JOB_FAILED`, `WORKFLOW_FAILED`, `NEW_MAIN_COMMIT`, `WATCHED_RUNS_GREEN`, `ALL_GREEN` deduplicated by latest run per workflow).
- **ETag (`If-None-Match`) + `updated_at` Delta Caching**: Reuses `304 Not Modified` responses at zero GitHub API rate-limit cost, projects cached payloads to consumed fields only, skips `/jobs` queries for in-progress unwatched PR runs, normalizes dynamic Dependabot workflow telemetry, and bounds persisted state atomically.
- **Adaptive Polling**: Polls every `15s` while `main` runs are active and backs off to `60s` when idle.
- **Two-Tier Monitoring**:
  1. **Tier 1 (`main` branch — `push`, `workflow_dispatch`, `schedule`)**: Instant job-level failure detection, cross-platform desktop + audio alert, and isolated worktree auto-repair.
  2. **Tier 2 (All runs including `pull_request`)**: Harvests step/job durations, queue wait times, and recurring flake signatures even when nothing merges to `main`.
- **Multi-Repo & Portfolio Setup (`/ci-hound setup`)**:
  - Watch the current repository by default, or configure a persistent watchlist across any set of repositories (`--repos owner/repo1,owner/repo2`, `--add-repo`, `--remove-repo`) or dynamic account scopes (`--all-my-repos --visibility private`, `--owner <login> --visibility <all|private|public>`).
- **Context-Aware `go` & `pr` Delivery**:
  - Routes **new incident repairs and new optimizations** through **`go`** (`/jongio-skills:go` -> `test-doctor fix` -> `pr`) so every fix ships with deterministic regression tests and full PR monitoring/merge.
  - Routes **existing fix worktrees and open in-flight PRs** directly through **`pr`** (`/jongio-skills:pr`) for CI/review monitoring, thread resolution, and head-pinned squash merge (`--merge=approval` default or `--merge=auto`).

## Install

```sh
npx skills add jongio/skills --skill ci-hound
```

Reload your agent skills, then invoke `/ci-hound`, `/ci-hound status`, `/ci-hound optimize`, or `/ci-hound stop`.

## CLI Usage

```sh
# Configure ci-hound to watch all of your private repositories
node skills/ci-hound/scripts/ci-hound-daemon.mjs setup --all-my-repos --visibility private

# Configure ci-hound for specific repositories
node skills/ci-hound/scripts/ci-hound-daemon.mjs setup --repos owner/repo1,owner/repo2

# Watch configured repositories (or current repo) and wake when any job fails
node skills/ci-hound/scripts/ci-hound-daemon.mjs watch --no-wake-on-green

# Watch a single specific repository
node skills/ci-hound/scripts/ci-hound-daemon.mjs watch --repo owner/repo --no-wake-on-green

# Watch a specific dispatched release run to completion
node skills/ci-hound/scripts/ci-hound-daemon.mjs watch --repo owner/repo --watch-run 123456789

# Print live status & telemetry summary
node skills/ci-hound/scripts/ci-hound-daemon.mjs status

# Print ranked bottleneck & flake optimization report
node skills/ci-hound/scripts/ci-hound-daemon.mjs optimize
```

## Bounded watch chunks

`watch` budgets API requests and sleeps to 540 seconds by default, leaving
60 seconds below the default 600-second host wait. A shorter positive
`COPILOT_TASK_WAIT_TIMEOUT_SECONDS` reduces the budget: subtract 60 seconds
above 60, otherwise use half the host wait. Override it with
`--max-wait-sec <non-negative integer>`; `0` disables chunking. `setup`, `status`,
`optimize` and `once` do not chunk. Local startup/state writes add overhead;
explicit overrides must leave room below the host deadline.

On `WATCH_CHUNK_TIMEOUT`, report the last status and immediately re-arm the
same command, retaining the full repository watchlist and options. API requests,
discovery and fallback are bounded by the remaining budget. Saved discovery
pagination, next-repository cursor, phases, caches and shared rate-limit
cooldowns continue across restarts. An incomplete poll never reports green.
The normal interval or remaining cooldown is still respected, so re-arming
does not become tight polling. Rotation does not change delivery or merge policy.

Owner discovery inventory is retained until its logical repository sweep finishes,
then refreshed for the next sweep. Completed repositories are not repeatedly
polled ahead of an interrupted target. Multi-repository `ALL_GREEN` requires a
completed green result for every target in that same logical sweep; changed
watch scope or superseding saved head/poll identities invalidate carried results.
`once`, `status` and `optimize` still poll fresh rather than reusing a partial
watch sweep. Cooldown chunks report saved status snapshots without API calls.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

## License

MIT. See [LICENSE](LICENSE).
