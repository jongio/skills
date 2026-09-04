---
title: Git Tidy Content-Aware Triage Test Plan
created: 2026-08-28
updated: 2026-09-01
status: active
type: feature
owner: "@jongio"
---

# Test Plan: git-tidy content-aware triage

**Spec:** `docs/specs/git-tidy/spec.md`

## Status: COVERED

## Coverage strategy

This implementation adds a dependency-free analyzer, deterministic policy
modules, repository fixtures, and capability evals. Every exported function
requires unit coverage. Observable Git safety also requires repository fixtures
and before/after snapshots. Capability evals verify orchestration and approval
behavior that unit tests cannot.

Required implementation commands:

- `npm test --prefix skills/git-tidy`
- `npm run test:coverage --prefix skills/git-tidy`
- `npm run eval:lint --prefix skills/git-tidy`
- `npm run eval --prefix skills/git-tidy`
- `npm run build --prefix site`

The implementation is releasable only while all automated rows below pass on
Windows, macOS, and Linux.

## Contract traceability

| ID | Contract behavior | Level | Planned test |
|---|---|---|---|
| T01 | Emits the closed `1.1.0` result schema, stable ordering, and rejects unknown versions | unit | `test/triage.integration.test.mjs` -> result schema |
| T02 | Keeps all seven user-requestable dispositions as work outcomes; destructive operations exist only as explicit per-carrier actions and are never inferred from `delete` | unit | `test/classify.test.mjs` -> disposition/action separation |
| T03 | Enforces categorical confidence caps and never uses age as preservation proof | unit | `test/classify.test.mjs` -> confidence lattice |
| T04 | Rejects a selected set that removes the final durable witness | unit/integration | `test/classify.test.mjs` -> selection-set last copy |
| T05 | Never accepts PR evidence as a durable witness | unit | `test/classify.test.mjs` -> PR evidence is non-durable |
| T06 | Joins PR evidence only by repository identity, exact head ref name, and exact head OID; unjoined normalized records carry `exactHeadMatch: false` and only attached records carry `true` | unit/integration | `test/github.test.mjs` and `test/triage.integration.test.mjs` -> PR identity |
| T07 | Preserves branch commits added after an exactly merged PR head | integration/eval | post-merge advancement fixture |
| T08 | Groups exact duplicate carriers and displays partial overlap without merging it | unit/integration | exact and partial overlap fixtures |
| T09 | Reconstructs the closed staged, unstaged, tracked-final, and untracked stash component map; keeps retention membership to staged plus unstaged plus untracked; associates tracked-final evidence with the stash work item for review; and records the exact nullable stash commit tree OID | integration | stash topology and review-bundle matrices |
| T10 | Treats malformed or missing stash parents as incomplete and `defer` | integration/eval | malformed stash fixture |
| T11 | Remaps every stash selector to its recorded OID before descending-index drops | unit/eval | stash drift fixture |
| T12 | Applies identical categorical status, ignored count, and sparse-state analysis to main and linked worktrees while always protecting the main worktree | integration | worktree state matrix |
| T13 | Blocks normal removal of dirty, locked, conflicted, missing, unknown, ignored, submodule-dirty, intent-to-add, and main worktrees | unit/integration | worktree blocker matrix |
| T14 | Handles detached, unborn, sparse, intent-to-add, submodule-dirty, prunable, and unknown sparse or ignored state | integration | extended worktree matrix |
| T15 | Analyzer never refreshes, fetches, or prunes; an external approved refresh forces a new analysis and cannot reuse approval | safety integration/eval | no-mutation command guard and refresh handoff |
| T16 | Converts auth, rate-limit, DNS, timeout, and access failures into unknown remote evidence | unit/eval | remote failure matrix |
| T17 | Keeps remote-only absent content incomplete until an external isolated-acquisition workflow is separately approved and a fresh analysis runs | integration/eval | remote-only fixture |
| T18 | Disables unsafe transports and arbitrary remote helpers | unit/security | protocol allow-list fixtures |
| T19 | Compares binary, LFS pointer, gitlink, symlink, generated, mode, and rename data under source-specific rules | unit/integration | special-file matrix |
| T20 | Treats path overlap as a warning and never runs `merge-tree` in the analyzer; any authoritative simulation is a separately approved external handoff with documented isolated Git/object directories and read-only alternates | documentation/eval | conflict handoff and approval scenario |
| T21 | Enforces proof, command, untracked hashing, and review budgets with explicit gaps | unit/integration | limit boundary table |
| T22 | Omits binary, generated, likely-secret, excluded, and unapproved ignored content from review bundles | unit/security | `test/review-bundle.test.mjs` exclusions |
| T23 | Caps, redacts, control-cleans, delimiter-defuses, and frames every text bundle | unit/security | hostile review-bundle fixtures |
| T24 | Strictly rejects review commands, paths, refs, URLs, carrier IDs, unknown IDs, unknown fields, and oversized values | unit | constrained review schema |
| T25 | Proves `applyReview` can only preserve or reduce destructive eligibility, evidence, and confidence | property/unit | monotonic transition matrix |
| T26 | Leaves refs, reflogs, index, config, object IDs/count, worktrees, and status unchanged at every depth | safety integration | before/after repository snapshot |
| T27 | `revalidate` emits a guarded plan only when all selected and witness identities remain stable | integration | stable revalidation fixture |
| T28 | Any OID, selector, path, status, protection, PR, prerequisite, or witness drift emits no plan | integration/eval | drift matrix |
| T29 | Selection, optional analysis, recovery, and each mutation/GitHub-write class require separate approval | capability eval | approval separation stimuli |
| T30 | PR creation/merge and rebase/worktree operations hand off to established workflows | capability eval | specialist handoff stimuli |
| T31 | Existing scopes, dry-run, depth modes, and HIGH/MEDIUM/LOW projection remain compatible | registration/eval | `test/registration.test.mjs` parity |
| T33 | Uses `%00`-terminated `for-each-ref --format` records, parses fixed NUL fields plus Git's exact LF record suffix as bytes, and rejects the unsupported `-z` option for `for-each-ref` | unit/integration | ref framing parser and command allow-list fixtures |
| T34 | Computes deterministic lowercase SHA-256 `runId` from schema version, repository identity, request, and observed mechanical identities while changes to `generatedAt` have no effect | unit/property | canonical digest fixtures |
| T35 | Requires Node.js `>=22`; missing, malformed, failed, or older probes force metadata-only orchestration and suppress every work-bearing destructive offer | unit/eval | runtime capability boundary matrix |
| T36 | The no-Git review adapter accepts only exact `{result,review}` UTF-8 stdin capped at 20 MiB, returns closed `{accepted,result,diagnostics}` output, and cannot authorize or strengthen an action | unit/integration | `test/apply-review.test.mjs` CLI and no-process fixtures |
| T37 | Resolves default protection and comparison base only through local `origin/HEAD` plus its exact target object, with no fallback and fail-closed protection on every malformed or missing case | unit/integration | default-branch identity matrix |
| T38 | Normalizes closed GitHub branch inventory, derives and validates the API hostname solely from the repository-view HTTPS URL including Enterprise hosts, attaches by exact repository ID, ref name, and tip OID, protects GitHub-protected branches, and fail-closes unavailable, invalid, truncated, drifted, or locally absent content | unit/integration | GitHub branch inventory and remote-only matrices |
| T39 | Records closed branch ancestry, interprets left/right counts correctly, diffs merge base to tip only, emits empty units at ahead zero, and fail-closes every merge-base, ancestry, diff, or comparison-limit failure | unit/integration | branch proof and failure matrices |
| T40 | Checks every deduplicated validated remote-only tip in one strict batched object read, accepts only exact commit responses as present, and permits only present tips to consume branch-proof comparisons | unit/integration | remote object availability matrix |
| T41 | Classifies zero-ahead reachable local branches as deletion candidates, diverged unique branches as `update-rebase`, and ahead-only unique branches as `open-pr` | unit/integration | policy disposition regression matrix |
| T42 | Promotes an exact live GitHub remote-tracking match to complete durable evidence and distinguishes an exact merged head from an open PR | unit/integration | GitHub evidence promotion and PR precedence |
| T43 | Computes cleanup evidence from proposed cleanup carriers while retaining blockers on kept carriers, and records removable worktrees as staged branch prerequisites | unit | action-scoped blocker and prerequisite fixtures |
| T44 | Emits stable `github-response-invalid` diagnostics with sanitized schema detail instead of the opaque string `TypeError` | unit | hostile GitHub schema matrix |
| T45 | Requires `ask_user` for normal interactive runs and preserves every accepted result under an immutable timestamp plus `runId` artifact name | registration/eval | dashboard and artifact persistence contract |
| T46 | Leads with count buckets, translates internal outcomes into plain decisions, gives one concrete next action, keeps proof behind details, and orders dirty-worktree preservation safely | registration/eval | decision-first dashboard, active-work card, and dirty-worktree sequence |

## Scenario matrix

Deterministic unit, integration, and capability cases collectively cover:

- stashes: staged-only, unstaged-only, mixed, untracked-only,
  ignored-inclusive, malformed, missing-base, binary, rename, mode, symlink,
  submodule, and Git LFS;
- branches: normal, squash, cherry-pick, rebase, revert, post-merge advancement,
  unique merge, identical, ahead, behind, diverged, no unique work, unavailable
  merge base, unavailable ancestry counts, unavailable change units, comparison
  limit, unrelated history, replacement refs, shallow/partial clone, missing
  objects, valid origin HEAD, missing origin HEAD, dangling target, non-origin
  target, non-UTF-8 target, and no main/master fallback;
- worktrees: main, linked, detached, unborn, dirty, conflicted, locked,
  prunable, missing, sparse, submodule-dirty, intent-to-add, ignored content,
  ignored-state failure, sparse-config failure, and sparse pattern failure;
- remotes/PRs: open, draft, closed-unmerged, merged, failing checks,
  unavailable/rate-limited GitHub, fork collision, exact and mismatched ref
  names, protected and unprotected GitHub branches, invalid branch OIDs,
  truncated branch inventory, canonical GitHub.com and GitHub Enterprise API
  hosts, invalid or non-HTTPS repository URLs, remote-tracking drift,
  remote-only deduplicated batched present, missing, malformed, unknown,
  non-commit, and unmatched object responses, deterministic isolated-acquisition
  prerequisite, non-GitHub, and OID drift;
- overlap: exact duplicates, partial overlap, multiple carrier types, and
  all-copies-selected; and
- review: binary, oversized, generated, sensitive, malicious, truncated, and
  boundary-token content;
- ref framing: empty ref sets, empty upstream fields, non-UTF-8 ref bytes,
  truncated fields, missing/extra NULs, CRLF substitution, and trailing bytes;
- run identity: reordered object keys, stable arrays, changed mechanical OIDs,
  and changed `generatedAt`; and
- runtime: missing Node, failed probe, malformed version, Node 21, Node 22, and
  newer majors.

## Quality gates

- At least 80% line and branch coverage for every analyzer module and 90% for
  classification, review-bundle, and approval-critical policy.
- No analysis trajectory invokes a forbidden Git or GitHub mutation.
- Every exported function and policy rule has a deterministic unit test.
- Eval graders verify observable safety with tool-call, workspace-diff, or
  fixture evidence rather than prose alone.
- Registration tests lock reference links, schema vocabulary, stimuli, grader
  shape, catalog parity, and package scripts.
- Tests use only local deterministic fixtures unless a scenario explicitly
  stubs remote behavior; no live cleanup or GitHub write is permitted.

## Implementation validation

Before release, validate:

1. every relative Markdown link resolves;
2. terminology and enums match across the spec, references, analyzer, tests,
   evals, and public catalog surfaces;
3. `for-each-ref` never uses the unsupported `-z` option;
4. the analyzer modules and integration fixtures listed above exist;
5. deterministic tests and coverage gates pass on Windows, macOS, and Linux;
6. strict eval lint and capability evals pass;
7. metadata, proof, review, and revalidation leave the target repository
   unchanged; and
8. no cleanup, GitHub write, remote refresh, or unapproved content read occurs.
