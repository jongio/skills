# Synthetic scenario: Cross-manifest version parity and default-branch CI gate

## Observations

- Repository: `example-org/agent-bundle` (`visibility: PUBLIC`, default branch `main`, latest tag `v1.4.0`, `HEAD` SHA `9f8e7d6c5b4a32109f8e7d6c5b4a32109f8e7d6c`)
- Unreleased shippable commit since `v1.4.0`: `fix(bundle): normalize relative asset paths` -> candidate version `1.4.1`.
- Manifest versions currently on `main`:
  - `package.json`: `"1.4.1"`
  - `package-lock.json` (`version` and `packages[""].version`): `"1.4.0"`
  - `plugin.json` and `.claude-plugin/plugin.json`: `"1.4.1"`
  - `.codex-plugin/plugin.json`: `"1.4.0"`
  - `CHANGELOG.md`: Top heading is still `## [1.4.0] - 2026-10-01` (no `1.4.1` entry).
- Default-branch `HEAD` CI checks on `9f8e7d6c5b4a32109f8e7d6c5b4a32109f8e7d6c`:
  - `Skill Lint`: `completed / success`
  - `Windows Integration`: `completed / failure`
  - `Catalog Build`: `in_progress`

## Request

Run an offline `release-doctor` readiness audit on `example-org/agent-bundle`, enumerate every version-parity drift and CI gate blocker, and specify the required handoff before any tag or release can proceed. No network or mutations; use only the supplied observations.
