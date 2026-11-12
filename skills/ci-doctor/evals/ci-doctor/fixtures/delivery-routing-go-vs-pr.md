# Synthetic scenario: Delivery skill routing (go vs pr) and worktree isolation

## Observations

- Watchlist checkup across two repositories with default `--merge=approval` (user has not passed `--merge=auto`):
  1. `example-org/search-service`: New `JOB_FAILED` on `main` (`unit-tests` failed with `EPIPE` on unused child `stdin`); no existing fix worktree or open PR exists.
  2. `example-org/docs-site`: Failing workflow check on an already-open fix PR `#142` (`ci/pin-actions`) that already has a local worktree at `<worktree-root>/docs-site/ci-pin-actions`.

## Request

Using `ci-doctor`, specify the exact worktree isolation, flake/root-cause remediation, `deliverySkill` (`go` vs `pr`) routing, and merge-approval behavior for both repositories. No network or mutations; use only the supplied observations.
