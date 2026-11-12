# Phase Playbooks, Worktree Lifecycle & Failure Isolation

## 1. Phase 0 SHA-Receipt Schema & Invalidation Rules

Store per-repository maintenance receipts outside Git at `~/.copilot/repo-maintain/<owner>__<repo>.json` (or `--state-dir <dir>`):

```json
{
  "repo": "example-org/service-api",
  "defaultBranch": "main",
  "lastMaintainSha": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "healthScore": 94,
  "grade": "A",
  "dimensions": {
    "ci": 20,
    "coverage": 18,
    "deps": 15,
    "secops": 15,
    "docs": 10,
    "skillsEvals": 10,
    "backlog": 6
  },
  "timestamp": "2026-11-09T20:00:00.000Z",
  "phasesRun": ["governance", "deps", "secops", "refactor", "coverage", "docs", "skills", "evals"],
  "prNumber": 142,
  "mergedSha": "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5"
}
```

### Fast No-Op Gate vs. Invalidation

Exit early with `fast no-op: HEAD unchanged and healthy` **only** when all five conditions hold:
1. `receipt.lastMaintainSha == <defaultBranch HEAD SHA>`.
2. `0` new Dependabot/GitHub security advisories since `receipt.timestamp`.
3. `0` failing workflow runs on `<defaultBranch>` for `HEAD`.
4. `0` untriaged external issues or PRs updated since `receipt.timestamp`.
5. Neither `--force` nor an explicit `--stages <csv>` override was requested.

If any condition fails, record the invalidation reason and proceed with the maintenance pass.

## 2. Worktree & Rolling Branch Lifecycle (`repo-maintain/automated`)

- **Never mutate the active checkout:** Resolve the external worktree root from `.github/repo-maintain.json#worktreeRoot` or the host's configured external worktree directory (`<worktree-root>/<repo>/repo-maintain-automated`).
- **Base synchronization:** Fetch `origin/<defaultBranch>` and check whether an open PR already exists for `head: repo-maintain/automated`:
  - **No open PR:** Create or reset `repo-maintain/automated` directly to `origin/<defaultBranch>`.
  - **Open `repo-maintain/automated` PR:** Inspect unmerged commits on `origin/repo-maintain/automated`. If all commits carry automated maintenance prefixes (`chore(repo-maintain):`, `chore(deps):`, `fix(repo-maintain):`, `refactor(repo-maintain):`, `test(repo-maintain):`, `docs(repo-maintain):`), rebase onto `origin/<defaultBranch>` and reuse the existing PR number. If unknown manual commits exist on the branch, do not force-overwrite; pause and escalate to `Needs My Attention`.

## 3. Phases 1–6 Execution, Skip Gates & Phase-Scoped Rollback

Each phase runs against the isolated worktree, verifies its changes with the repository's native test/lint commands, and creates at most **one** atomic commit when files change:

| Phase | Specialist Skills | Skip Gate | Required Verification | Atomic Commit Message |
| --- | --- | --- | --- | --- |
| **1. Governance & Runtime Parity** | `repo-ready` + `ci-doctor` | Only when excluded by `--stages` | `actionlint` / workflow YAML check + runtime version parity across manifests | `chore(repo-maintain): align repo governance, workflows, and runtime parity` |
| **2. Dependencies & Companion Syncs** | `deps-doctor` | No dependency manifests or workflows present | Lockfile integrity + full build & test suite + license compatibility check | `chore(deps): apply vetted dependency updates` |
| **3. Security & Stealth Audit** | `secops-doctor` | Only when excluded by `--stages` | Build + security regression tests + Stealth Mode redaction check on public repos | `fix(repo-maintain): harden input validation and configuration defaults` |
| **4. Idiomatic Refactoring** | `refactor` | Only Level 3 candidates found (file `[Refactor L3]` issue instead) | Full unit/integration test suite with zero behavior drift | `refactor(repo-maintain): apply verified level 1-2 cleanups` |
| **5. Coverage & Runtime Quality** | `test-doctor` | No executable code/test runner | Coverage runner (`>= coverageThreshold%` on touched files) + optional Playwright console gate | `test(repo-maintain): close branch and diff coverage gaps` |
| **6. Docs, Skills & Evals** | `doc-doctor` + `skill-doctor` + `eval-doctor` | Skip `skill-doctor` if no `skills/`; skip `eval-doctor` if no `evals/` or `.vally.yaml` | Link check + `vally skill lint` + `vally lint --strict` + deterministic skill tests | `docs(repo-maintain): sync documentation, skills, and eval suites` |

### Phase-Scoped Failure Rollback (2-Attempt Cap)

If a phase's verification command fails after at most **2 bounded repair attempts**:
1. Reset **only** that phase's staged and unstaged working-tree changes (`git reset --hard <pre-phase-sha> && git clean -fd`) back to the previous phase's verified commit SHA.
2. Record the failed phase (`failedPhases`), command output summary, and root cause under `Needs My Attention` so an incomplete run is never cached as a clean fast no-op.
3. Continue executing subsequent independent phases so one broken refactor or doc step never blocks vetted security fixes, dependency updates, or coverage additions.

## 4. Dependabot / Renovate Companion Sync Matrix

Inspect open dependency bot PRs during Phase 2:

| Dependency PR Condition | Action |
| --- | --- |
| Fails only on mechanical companion sync (`RequiredAzdVersion` constant, Go toolchain floor in `go.mod`/workflows for `govulncheck`, or lockstep `github/codeql-action/*` 40-char SHA pins) | Apply companion sync commit on the PR branch (or fold into `repo-maintain/automated`), verify local tests + GitHub Actions CI pass (`MERGEABLE`/`CLEAN`), and auto-merge via `pr --merge=auto --no-copilot` (`--match-head-commit`). |
| Introduces a `GPL`/`AGPL`/`SSPL` copyleft transitive license in an `MIT`/`Apache-2.0`/`BSD` repository | Do **not** merge. Block and escalate under `Needs My Attention`. |
| Semver-major upgrade with breaking public API or config changes that cannot be fixed forward mechanically | Do **not** auto-merge. Escalate under `Needs My Attention` with migration impact summary. |
| Release age is younger than `cooldownDays` (`7` days default) and is **not** a CISA KEV active-exploitation patch without an older safe version | Hold / defer until the release age window passes. |
