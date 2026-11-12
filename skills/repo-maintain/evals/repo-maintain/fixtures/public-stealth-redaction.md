# Synthetic scenario: Public Repo Stealth Mode and fleet context partitioning

## Observations

- Local fleet invocation: `repo-maintain --all --visibility all` across two repositories:
  1. `sample-team/internal-ledger` (`visibility: PRIVATE`, default branch `main`)
     - Phase 3 (`secops-doctor`) found an internal staging token in `.env.example` and fixed it.
  2. `example-org/public-gateway` (`visibility: PUBLIC`, default branch `main`)
     - Phase 3 (`secops-doctor`) identified an input normalization flaw in `src/archive.ts` (mapped internally to path traversal `CWE-22`, `CVSS 8.6`) where `../` segments were not stripped before resolving archive entries.
     - A regression test and path normalization fix are ready in the isolated worktree on `repo-maintain/automated`.

## Request

Produce the exact commit message, test name, PR summary snippet, and report routing plan for `example-org/public-gateway` under Public Repo Stealth Mode, plus the fleet isolation rule governing `sample-team/internal-ledger`. Do not run network commands or modify any files.
