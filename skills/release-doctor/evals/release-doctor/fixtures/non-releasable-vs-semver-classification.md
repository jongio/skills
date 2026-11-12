# Synthetic scenario: Non-releasable commits vs SemVer bump classification

## Observations

- Three repositories evaluated on default branch `main` against their latest release tag:
  1. `example-org/cli-core` (latest tag `v2.4.0`, `ahead_by: 3`):
     - `ci: pin actions/setup-node SHA in lint.yml` (`.github/workflows/lint.yml`)
     - `docs: clarify install table in README` (`README.md`)
     - `test: add edge-case parser unit tests` (`test/parser.test.mjs`)
  2. `example-org/plugin-pack` (latest tag `v1.3.2`, `ahead_by: 2`):
     - `fix(runtime): preserve ETag header on retry` (`runtime/client.mjs`)
     - `feat(skills): add release-doctor workflow skill` (`skills/release-doctor/SKILL.md`, `marketplace.json`)
  3. `sample-team/data-exporter` (latest tag `v3.1.0`, `ahead_by: 1`):
     - `feat!: remove deprecated --legacy-xml CLI flag` (`src/cli.ts`)

## Request

Using `release-doctor`, classify the shippable commit impact and exact next SemVer recommendation (`none`, `patch`, `minor`, or `major` + target version) for all three repositories. No network or mutations; use only the supplied observations.
