# Synthetic scenario: Auditing a CI evaluation workflow against all 5 security invariants

## Observations

- Repository: `example-org/agent-skills` (`visibility: PUBLIC`, default branch `main`)
- Proposed `.github/workflows/eval-pr.yml`:
  - Trigger: `on: [pull_request_target, workflow_dispatch]`
  - Top-level `env: { COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }} }`
  - No top-level `permissions:` block and no `concurrency:` block.
  - Job `run-evals` has no `timeout-minutes:`, checks out `${{ github.event.pull_request.head.sha }}` using `actions/checkout@v4` (default `persist-credentials: true`), runs `npm ci --prefix .github/tools/vally` (without `--ignore-scripts`), executes `vally eval --runs 20 --max-retries 5`, and uploads the entire `vally-results/` directory (including raw `events.jsonl` transcripts) via `actions/upload-artifact@v4` with default 90-day retention.

## Request

Audit `.github/workflows/eval-pr.yml` with `eval-doctor` against all 5 Mandatory CI Security Invariants and produce the exact remediated workflow design. No network or mutations; use only the supplied observations.
