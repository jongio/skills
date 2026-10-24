# ci-hound

Continuously monitor GitHub Actions workflows with a zero-token ETag-cached background daemon, alert on `main` failures, repair broken builds in isolated worktrees, and optimize slow or flaky workflows.

## Features

- **Zero-Token Background Daemon (`scripts/ci-hound-daemon.mjs`)**: Runs in an async background shell, streams live job-progress `PHASE_CHANGED` updates (`N/M jobs passed; active: ...`), and wakes the agent session when an actionable event occurs (`JOB_FAILED`, `WORKFLOW_FAILED`, `NEW_MAIN_COMMIT`, `WATCHED_RUNS_GREEN`, `ALL_GREEN`).
- **ETag (`If-None-Match`) + `updated_at` Delta Caching**: Reuses authenticated `304 Not Modified` responses at zero GitHub API rate-limit cost, skips unchanged retained completed runs, and persists state atomically with orphaned job ETag eviction. Credential changes invalidate cached observations.
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

## GitHub transport and degraded state

The daemon ships a locked, self-contained Octokit runtime. End users do not need
to install npm dependencies. Normal polling uses asynchronous GitHub REST/GraphQL
requests, not a `gh api` subprocess for every request. `gh` remains necessary for
credential discovery when no suitable environment token is configured.

Requests have an overall deadline, safe reads have a bounded retry, and rejected
gh-derived credentials are re-resolved once. Explicit environment credentials are
never silently replaced with another account. `GH_HOST` and enterprise tokens
select the corresponding API host; HTTP proxies and `NO_PROXY` are supported.
Cached responses are scoped to the host and credentials. Authentication, network,
JSON, or incomplete inventory failures cannot establish `ALL_GREEN` or
`WATCHED_RUNS_GREEN`; last-known history remains diagnostic evidence only.

For optional Copilot timeline notifications, subscribe with
`/daemon-notifications subscribe ci`, then pass the returned file:

```powershell
node skills\ci-hound\scripts\ci-hound-daemon.mjs watch --events-file "<returned-file>"
```

This opt-in channel does not start watchers, prompt a model, trigger repairs, or
change merge consent. Normal stdout and host completion wake-ups still work
without it. Disable with `/daemon-notifications unsubscribe ci`.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

## License

MIT. See [LICENSE](LICENSE).
