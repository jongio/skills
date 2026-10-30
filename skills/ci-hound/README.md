# ci-hound

Continuously monitor GitHub Actions workflows with a zero-token ETag-cached background daemon, alert on `main` failures, repair broken builds in isolated worktrees, and optimize slow or flaky workflows.

## Features

- **Zero-Token Background Daemon (`scripts/ci-hound-daemon.mjs`)**: Runs in an async background shell, streams live job-progress `PHASE_CHANGED` updates (`N/M jobs passed; active: ...`) on step transitions and 60s heartbeats, and wakes the agent session when an actionable event occurs (`JOB_FAILED`, `WORKFLOW_FAILED`, `NEW_MAIN_COMMIT`, `WATCHED_RUNS_GREEN`, `ALL_GREEN` deduplicated by latest run per workflow).
- **ETag (`If-None-Match`) + `updated_at` Delta Caching**: Reuses authenticated `304 Not Modified` responses at zero GitHub API rate-limit cost, projects cached payloads to consumed fields only, skips `/jobs` queries for in-progress unwatched PR runs, normalizes dynamic Dependabot workflow telemetry, and persists state atomically with orphaned job ETag eviction. Credential changes invalidate cached observations.
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
discovery, SDK retries and credential resolution are bounded by the remaining budget. Saved discovery
pagination, next-repository cursor, phases, caches and shared rate-limit
cooldowns continue across restarts. An incomplete poll never reports green.
The normal interval or remaining cooldown is still respected, so re-arming
does not become tight polling. Rotation does not change delivery or merge policy.

Owner discovery inventory is retained until its logical repository sweep finishes,
then refreshed for the next sweep. Completed repositories are not repeatedly
polled ahead of an interrupted target. Multi-repository `ALL_GREEN` requires a
completed green result for every target in that same logical sweep; changed
watch scope or superseding saved head/poll/credential identities invalidate carried results.
`once`, `status` and `optimize` still poll fresh rather than reusing a partial
watch sweep. Cooldown chunks report saved status snapshots without API calls.

Discovery pages are bound to their observed SDK credential identity. A refresh
during discovery restarts every owner collection at page one; completed or
partial saved pages without a verified scope are discarded. Quota backoffs and
genuine API errors remain distinct from clean chunk expiry, including when a
deadline interrupts paginated job inspection.
Explicit `once`, `status` and `optimize` owner queries discard partial watch
discovery state before fetching a fresh inventory; normal watch chunk
continuations still retain their scoped progress.
CI observations and backoff are host-scoped, including an explicit state file:
switching its validated host discards the previous host's observations before
applying cooldown. Shared-backoff output reports the current requested targets,
not an unrelated earlier watchlist.
State saves serialize read/merge/rename within the caller's remaining budget,
preserving validated same-host unexpired cooldowns, never another identity's
cached payload. Only a genuinely missing state file initializes fresh state;
other read or JSON errors stop polling without replacing the file. Resolve the
reported read/parse problem before re-arming rather than discarding saved quota.
Current SDK identity is verified before cached status is
returned, including during quota; verification does not make an API poll.
Cached snapshots also must match the requested host, repository and branch,
including inherited cooldowns when an explicit state file is reused.
Ordinary next-poll times also survive re-arming, scoped to the same host,
repository, branch and credential identity. Waiting never replays green events;
diagnostic `once`, `status` and `optimize` calls remain fresh.
An idle peer's ordinary interval does not suppress another target once its own
poll is due. An observed credential change also discards old snapshots, phases
and ordinary timing alongside the credential-scoped response cache.
If identity changes during a response, error/quota fallbacks cannot reuse the
previous identity's cached body. A sweep also discards previously collected
peer statuses and reports; recovery observes those peers under the new identity.
Outstanding sweep members precede optional due-peer refreshes; a completed
passing sweep is evaluated before those refreshes can consume the next chunk.
A hard poll error discards held completion/green proof, not the repository
inventory or continuation cursor. Previously passing peers must be observed
again before recovery can release aggregate green.
If one target consumes a whole fresh chunk without completing, held completion
proof is discarded before rotating to its peers. A stalled target therefore
cannot freeze their observations or later promote their old green snapshots.

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
