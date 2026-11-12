# Synthetic scenario: Dependabot companion syncs, Tier 1-3 triage, and Needs My Attention escalation

## Observations

- Repository: `example-org/cloud-cli` (`visibility: PUBLIC`, license `MIT`, `.github/repo-maintain.json` with `autoMerge: true`, `copilotReview: false`, `cooldownDays: 7`, `coverageThreshold: 80`).
- Open external and bot items:
  1. `example-org/cloud-cli#201` (Dependabot): bumps `azd` SDK minor version (release age `12` days, `MIT` license). CI fails only because `RequiredAzdVersion` in `internal/version/const.go` and lockstep `github/codeql-action/*` 40-char SHA pins in `.github/workflows/codeql.yml` need companion updates.
  2. `example-org/cloud-cli#202` (Dependabot): bumps `graph-parser` from `2.4.0` to `3.0.0` (semver-major with breaking AST node removal) and adds a transitive dependency licensed under `AGPL-3.0`.
  3. `example-org/cloud-cli#203` (external untrusted author): adds a promotional README badge linking to a commercial SEO service and modifies `.github/workflows/ci.yml`.
  4. `example-org/cloud-cli#204` (external contributor): adds a new multi-tenant plugin architecture across 14 files.
- Phase 4 (`refactor`) also identified a Level 3 cross-module split (`[Refactor L3]`) across `pkg/engine` and `pkg/runner`.

## Request

Classify `example-org/cloud-cli#201`, `example-org/cloud-cli#202`, `example-org/cloud-cli#203`, `example-org/cloud-cli#204`, and the Level 3 refactor candidate according to `repo-maintain` rules. Specify which items execute zero-touch auto-merge (`pr --merge=auto --no-copilot` with `--match-head-commit`), which receive zero public comments, and which escalate to `Needs My Attention`. Do not perform network or repository writes.
