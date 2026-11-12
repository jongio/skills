# Synthetic scenario: Proactive workflow cost, cache, and security optimization

## Observations

- Target repository: `example-org/web-client` (`visibility: PUBLIC`, default branch `main`)
- `ci-doctor-daemon.mjs optimize` telemetry + `.github/workflows/ci.yml` inspection:
  - Job `lint` runs pure ESLint + Prettier on `macos-latest` (avg `6m20s`, 10x runner multiplier), has no npm lockfile cache, and has no `timeout-minutes` or `concurrency` group.
  - Step `Checkout` uses `actions/checkout@v4` without `persist-credentials: false`.
  - Step `Print PR context` runs `echo "Testing ${{ github.event.pull_request.head.ref }}"` directly inside `run:`.
  - Top-level `permissions:` is omitted.

## Request

Produce the `ci-doctor optimize` hardening and cost-reduction plan, validation checks (`actionlint`/`zizmor`), and single-PR delivery route. No network or mutations; use only the supplied observations.
