# Synthetic scenario: Phase 0 SHA-receipt fast no-op vs invalidation

## Observations

- Repository A: `example-org/payments-api` (`visibility: PRIVATE`, default branch `main`, current `HEAD` `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2`).
  - Cached receipt `~/.copilot/repo-maintain/example-org__payments-api.json`:
    - `lastMaintainSha`: `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2`
    - `healthScore`: `96` (`Grade A`)
    - `timestamp`: `T1`
  - Since `T1`: `0` new security advisories, `0` failing workflow runs on `main`, `0` untriaged external issues or PRs, no `--force` or `--stages` flags.
- Repository B: `example-org/billing-worker` (`visibility: PUBLIC`, default branch `main`, current `HEAD` `f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5`).
  - Cached receipt `~/.copilot/repo-maintain/example-org__billing-worker.json`:
    - `lastMaintainSha`: `f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5`
    - `healthScore`: `92` (`Grade A`)
    - `timestamp`: `T1`
  - Since `T1`: `HEAD` is unchanged, `0` failing CI runs, `1` new high-severity Dependabot advisory (`GHSA-xxxx-yyyy-zzzz`), and `1` untriaged external PR `example-org/billing-worker#88` ("Add custom webhook header").

## Request

Evaluate Phase 0 for both synthetic repositories without performing any network calls or file mutations. State which repository exits early with `fast no-op: HEAD unchanged and healthy`, which repository invalidates its receipt and why, and how `example-org/billing-worker#88` and the advisory are handled across Phases 0-3.
