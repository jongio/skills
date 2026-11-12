# Synthetic scenario: Stateless ETag delta checkup and degraded telemetry handling

## Observations

- Configured watchlist in `~/.copilot/ci-doctor/config.json`: `["example-org/core-sdk", "example-org/billing-cli"]`.
- `ci-doctor-daemon.mjs status` observations:
  1. `example-org/core-sdk`: HTTP `304 Not Modified` (ETag hit, `0` rate-limit cost); cached `main` state is green, no runs updated since cursor.
  2. `example-org/billing-cli`: Emitted `POLL_ERROR` (`HTTP 401 Bad credentials` on secondary host token refresh); last cached run from 2 days ago was green.

## Request

Interpret this `ci-doctor` checkup, explain how state files and ETag caching behave across multiple repositories, and state the exact status verdict for both repositories. No network or mutations; use only the supplied observations.
