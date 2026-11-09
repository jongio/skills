# repo-maintain

Run an end-to-end repository maintenance pass across governance, dependencies, security, refactoring, coverage, docs, skills, and evals on a single rolling branch (`repo-maintain/automated`).

## Highlights

- **Zero-Touch Auto-Create & Auto-Merge (`"autoMerge": true`, `"copilotReview": false` by default):** Automatically pushes `repo-maintain/automated`, opens/updates the consolidated PR, watches CI via `pr --merge=auto --no-copilot` (`pr-watch-daemon.mjs watch --no-copilot` with zero Copilot Code Review Actions minutes billed), and executes a head-pinned squash merge (`--match-head-commit`) plus atomic branch cleanup once local tests and GitHub Actions CI pass (`MERGEABLE`/`CLEAN`).
- **Dependabot/Renovate Companion Syncs:** Automatically applies mechanical companion syncs on open dependency PRs (version constants such as `RequiredAzdVersion`, Go toolchain floors for stdlib `govulncheck`, and lockstep GitHub Action SHA pins across `codeql-action/*`) and auto-merges them when CI passes.
- **Escalation-Only (`Needs My Attention`):** Pauses or escalates only when CI fails and cannot be auto-remediated, when a semver-major breaking change is required, or for Level 3 (`[Refactor L3]`) architectural design questions.

## Install

```sh
npx skills add jongio/skills --skill repo-maintain
```

Reload your agent skills, then invoke `/repo-maintain`.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

The deterministic test checks the portable skill shape. The Vally capability eval verifies that
the agent follows the workflow.

## License

MIT. See [LICENSE](LICENSE).

