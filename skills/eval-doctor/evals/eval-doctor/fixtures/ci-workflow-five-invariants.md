# Synthetic scenario: Auditing a CI evaluation workflow against all 5 security invariants

## Observations

- Repository: `example-org/agent-skills` (`visibility: PUBLIC`, default branch `main`)
- Proposed `.github/workflows/eval-pr.yml`:
  - Trigger: `on: [pull_request_target, workflow_dispatch]`
  - Top-level `env: { COPILOT_GITHUB_TOKEN: ${{ secrets.COPILOT_GITHUB_TOKEN }} }`
  - No top-level `permissions:` block and no `concurrency:` block.
  - Job `run-evals` has no `timeout-minutes:`, checks out `${{ github.event.pull_request.head.sha }}` using `actions/checkout@v4` (default `persist-credentials: true`), runs `npm ci --prefix .github/tools/vally` (without `--ignore-scripts`), executes `vally eval --runs 20 --max-retries 5`, and uploads the entire `vally-results/` directory (including raw `events.jsonl` transcripts) via `actions/upload-artifact@v4` with default 90-day retention.
  - Verified 40-character action commit SHAs available in repository policy:
    - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`
    - `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`
    - `actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f # v6.0.0`

## Request

Audit `.github/workflows/eval-pr.yml` with `eval-doctor` against all 5 Mandatory CI Security Invariants and produce the exact remediated workflow design. No network or mutations; use only the supplied observations.
