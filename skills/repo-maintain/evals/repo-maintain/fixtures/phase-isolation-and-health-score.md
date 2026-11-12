# Synthetic scenario: Phase-scoped rollback, deterministic 0-100 Repo Health Score, and release handoff

## Observations

- Repository: `example-org/metrics-agent` (`visibility: PRIVATE`, default branch `main`, no `skills/` or `evals/` directories present).
- Worktree: external worktree on rolling branch `repo-maintain/automated` off `origin/main` (`head-oid-1111111111111111111111111111111111111111`).
- Phase execution results:
  - **Phase 1 (`repo-ready` + `ci-doctor`):** Fixed 1 unpinned GitHub Action (`-4` before -> `0` after) and added missing top-level `permissions: contents: read` (`-4` before -> `0` after). Verified and committed (`chore(repo-maintain): align repo governance, workflows, and runtime parity`).
  - **Phase 2 (`deps-doctor`):** Patched 1 High advisory (`-8` before -> `0` after, release age `14` days, `MIT`). Verified and committed (`chore(deps): apply vetted dependency updates`).
  - **Phase 3 (`secops-doctor`):** Clean (`15/15` before and after).
  - **Phase 4 (`refactor`):** Attempted a Level 2 helper consolidation in `src/aggregator.ts`, but unit tests failed in both bounded repair attempts (`2/2` attempts failed).
  - **Phase 5 (`test-doctor`):** Added branch tests for touched files, raising diff coverage from `68%` (`-8` before) to `88%` (`0` deductions after; overall coverage `85%`, `0` untested entrypoints, `0` branch-vs-line gaps). Verified and committed (`test(repo-maintain): close branch and diff coverage gaps`).
  - **Phase 6 (`doc-doctor`):** Fixed 1 broken README link (`-3` before -> `0` after). Verified and committed (`docs(repo-maintain): sync documentation, skills, and eval suites`).
  - **Backlog SLA (`backlog-groom`):** 1 external issue unresponded `>24h` (`-3` before and after; `7/10`).

## Request

Explain how `repo-maintain` handles the failed Phase 4 refactor without losing Phases 1, 2, 5, and 6; compute the exact **Before** and **After** 0-100 Repo Health Scores and letter grades using the rubric; and describe the consolidated `repo-maintain/automated` PR delivery and post-merge `release-doctor` step. Do not run network commands or modify any files.
