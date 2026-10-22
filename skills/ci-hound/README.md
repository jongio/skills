# ci-hound

Continuously monitor GitHub Actions workflows with a zero-token ETag-cached background daemon, alert on `main` failures, repair broken builds in isolated worktrees, and optimize slow or flaky workflows.

## Features

- **Zero-Token Background Daemon (`scripts/ci-hound-daemon.mjs`)**: Runs in an async background shell and wakes the agent session only when an actionable event occurs (`JOB_FAILED`, `WORKFLOW_FAILED`, `NEW_MAIN_COMMIT`, `WATCHED_RUNS_GREEN`, `ALL_GREEN`).
- **ETag (`If-None-Match`) + `updated_at` Delta Caching**: Reuses `304 Not Modified` responses at zero GitHub API rate-limit cost and never re-fetches completed jobs.
- **Adaptive Polling**: Polls every `15s` while `main` runs are active and backs off to `60s` when idle.
- **Two-Tier Monitoring**:
  1. **Tier 1 (`main` branch — `push`, `workflow_dispatch`, `schedule`)**: Instant job-level failure detection, cross-platform desktop + audio alert, and isolated worktree auto-repair.
  2. **Tier 2 (All runs including `pull_request`)**: Harvests step/job durations, queue wait times, and recurring flake signatures even when nothing merges to `main`.

## Install

```sh
npx skills add jongio/skills --skill ci-hound
```

Reload your agent skills, then invoke `/ci-hound`, `/ci-hound status`, `/ci-hound optimize`, or `/ci-hound stop`.

## CLI Usage

```sh
# Watch main and wake when all current runs finish green or any job fails
node skills/ci-hound/scripts/ci-hound-daemon.mjs watch --repo owner/repo

# Watch main continuously (wake only on failure)
node skills/ci-hound/scripts/ci-hound-daemon.mjs watch --repo owner/repo --no-wake-on-green

# Watch a specific dispatched release run to completion
node skills/ci-hound/scripts/ci-hound-daemon.mjs watch --repo owner/repo --watch-run 123456789

# Print live status & telemetry summary
node skills/ci-hound/scripts/ci-hound-daemon.mjs status --repo owner/repo

# Print ranked bottleneck & flake optimization report
node skills/ci-hound/scripts/ci-hound-daemon.mjs optimize --repo owner/repo
```

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

## License

MIT. See [LICENSE](LICENSE).
