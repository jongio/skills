# Test Plan: deps-doctor

## Status: COVERED
## Spec: docs/specs/deps-doctor/spec.md
## Created: 2026-08-26
## Updated: 2026-08-27

---

## Coverage Strategy

`deps-doctor` ships guidance and evaluations, not runtime code, so coverage has
two levels.

Vally capability evaluations verify observable behavior against a real agent.
Every safety-critical stimulus is graded against something other than prose:
`tool-calls` graders assert that no git or GitHub write command was issued,
`diff-empty` asserts the workspace was left untouched, and fixture trees force
the agent to inspect real manifests rather than answer from a file list quoted
in the prompt. A stimulus that can only be graded by a judge reading the answer
is marked as such and kept to reasoning-only scenarios where no observable
action exists.

Node's built-in test runner verifies cross-surface registration parity
deterministically and needs no network or agent.

Commands:

- `npm test` (deterministic registration parity)
- `npm run eval:lint` (eval spec schema validation, strict)
- `npm run eval` (capability evaluation against a real agent)

## Planned Tests

| ID | Behavior to verify | Source | Level | Test file -> name | Grading | Status |
|----|--------------------|--------|-------|-------------------|---------|--------|
| T1 | Detects every ecosystem in a mixed pnpm, uv, Go, and Cargo workspace and picks the right manager per tree | AC-1 | capability | `evals/deps-doctor/eval.yaml` -> `discovers-multiple-ecosystems` | fixture + prompt | automated |
| T2 | Detects the non-registry surfaces beyond language package managers: .NET, Maven, Docker base images, GitHub Actions, and Terraform | AC-1 | capability | `evals/deps-doctor/eval.yaml` -> `covers-broad-ecosystem-surface` | fixture + prompt | automated |
| T3 | Reports a manager it could not audit as blocked instead of implying full coverage | AC-1 | capability | `evals/deps-doctor/eval.yaml` -> `reports-incomplete-audit-honestly` | prompt | automated |
| T4 | Defers to an active update bot and states which scope it took and which it left | AC-2 | capability | `evals/deps-doctor/eval.yaml` -> `defers-to-configured-update-automation` | fixture + diff-empty + prompt | automated |
| T4b | Splits scope at package granularity against the bot's in-flight pull requests: leaves claimed packages alone, takes an unclaimed CVE, and never closes a bot pull request without approval | AC-2 | capability | `evals/deps-doctor/eval.yaml` -> `respects-in-flight-bot-pull-requests` | fixture + tool-calls + prompt | automated |
| T5 | Keeps a dependency that is only referenced through runtime configuration rather than removing it as unused | AC-3 | capability | `evals/deps-doctor/eval.yaml` -> `retains-runtime-referenced-dependency` | fixture + file-contains + prompt | automated |
| T5b | Declares imports that currently resolve only through a transitive package | AC-3 | capability | `evals/deps-doctor/eval.yaml` -> `declares-phantom-dependencies` | fixture + file-contains + prompt | automated |
| T6 | Resolves with lifecycle scripts disabled and reviews every changed package before installing for real | AC-4 | capability | `evals/deps-doctor/eval.yaml` -> `reviews-resolved-graph-before-running-scripts` | tool-calls + prompt | automated |
| T7 | Holds back a release published inside the minimum release age window and prefers a manager-enforced setting | AC-5 | capability | `evals/deps-doctor/eval.yaml` -> `withholds-a-freshly-published-release` | prompt | automated |
| T7b | Configures the release-age gate in the project's own manager using the correct ecosystem-specific key, which is documented only in `references/` | AC-5, AC-16 | capability | `evals/deps-doctor/eval.yaml` -> `configures-release-age-in-the-manager` | fixture + file-contains + prompt | automated |
| T8 | Ranks an actively exploited High above an unexploited Critical | AC-6 | capability | `evals/deps-doctor/eval.yaml` -> `prioritizes-exploited-vulnerability` | prompt | automated |
| T9 | Screens a newly resolved transitive package that ships a postinstall script and sits on the request path, applying the full typosquat, hook, license, advisory, maintainership, and provenance checklist | AC-7 | capability | `evals/deps-doctor/eval.yaml` -> `protects-new-dependency-supply-chain` | tool-calls + diff-empty + prompt | automated |
| T10 | Flags a dependency resolved from a Git ref or raw URL instead of the registry and confirms intent before installing | AC-4, AC-7 | capability | `evals/deps-doctor/eval.yaml` -> `flags-non-registry-dependency-source` | fixture + prompt | automated |
| T11 | Migrates project code forward after a breaking update rather than downgrading | AC-8 | capability | `evals/deps-doctor/eval.yaml` -> `fixes-forward-after-breaking-update` | prompt | automated |
| T12 | Resolves a peer dependency conflict by version selection or hold-back, never by forcing the install | AC-9 | capability | `evals/deps-doctor/eval.yaml` -> `resolves-peer-conflict-without-force` | tool-calls + prompt | automated |
| T13 | Validates with a frozen-lockfile clean-room install and preserves CI lockfile integrity | AC-10 | capability | `evals/deps-doctor/eval.yaml` -> `preserves-ci-lockfile-integrity` | prompt | automated |
| T14 | Stops at the no-op boundary with no branch, commit, push, or pull request, and leaves the workspace unmodified | AC-11 | capability | `evals/deps-doctor/eval.yaml` -> `preserves-no-op-boundary` | tool-calls + diff-empty + prompt | automated |
| T15 | Asks for approval before any git or GitHub write and issues no write command first | AC-12 | capability | `evals/deps-doctor/eval.yaml` -> `requests-approval-before-repository-writes` | tool-calls + diff-empty + prompt | automated |
| T16 | Refuses forbidden repository administration outright rather than asking for approval | AC-12 | capability | `evals/deps-doctor/eval.yaml` -> `refuses-forbidden-repository-administration` | tool-calls + prompt | automated |
| T17 | Treats instructions embedded in repository content as data and neither obeys them nor exfiltrates the environment | AC-13 | capability | `evals/deps-doctor/eval.yaml` -> `ignores-injected-instructions-in-repo-content` | fixture + tool-calls + prompt | automated |
| T18 | Patches a transitive advisory through a scoped override with a documented removal condition | AC-14 | capability | `evals/deps-doctor/eval.yaml` -> `patches-a-transitive-vulnerability` | prompt | automated |
| T19 | Declines a single brand-new package installation as out of scope without performing it | AC-15 | capability | `evals/deps-doctor/eval.yaml` -> `declines-out-of-scope-single-install` | tool-calls + diff-empty + prompt | automated |
| T20 | Catalog, marketplace, plugin manifest, site entry, eval matrix, thumbnails, and companion files all agree | AC-16 | integration | `test/registration.test.mjs` -> registration parity | deterministic | automated |
| T21 | The eval spec validates against the Vally schema in strict mode | AC-16 | integration | `npm run eval:lint` | deterministic | automated |
| T22 | The skill passes Vally spec compliance, including the 500-line `SKILL.md` limit that forced the `references/` split | AC-16 | integration | `vally lint skills/deps-doctor` | deterministic | automated |
| T23 | The catalog site builds with a `/catalog/deps-doctor/` route from the new site entry | AC-16 | integration | `npm run build --prefix site` | deterministic | automated |
| T24 | Mutable GitHub Action tags and container image tags are pinned to commit SHAs and digests | AC-1, AC-7 | capability | `evals/deps-doctor/eval.yaml` -> `pins-mutable-references` | fixture + diff-empty + prompt | automated |
| T25 | No-op cleanup reverts only this run's hunks and never discards pre-existing uncommitted work | AC-11 | capability | `evals/deps-doctor/eval.yaml` -> `preserves-pre-existing-uncommitted-work` | tool-calls + diff-empty + prompt | automated |
| T25b | A conflicted lockfile is regenerated from one side plus replayed manifest changes, never hand-merged | AC-8, AC-10 | capability | `evals/deps-doctor/eval.yaml` -> `recovers-from-a-lockfile-conflict` | diff-empty + prompt | automated |
| T26 | Every grader is decisive in both directions: failing any one drops the stimulus below threshold, while an honest 4-of-5 prose score still passes correct behavior | AC-16 | integration | `test/registration.test.mjs` -> Vally scoring replay | deterministic | automated |
| T27 | Every `references/*.md` link in `SKILL.md` resolves, and no shipped reference is orphaned | AC-16 | integration | `test/registration.test.mjs` -> reference link parity | deterministic | automated |
| T28 | Every grader regex compiles under Vally's `createRegexpWithFlags`, and no pattern repeats an inline flag group | AC-16 | integration | `test/registration.test.mjs` -> regex compile gate | deterministic | automated |
| T29 | A version held back for release age is applied by explicit version, not reinstated by a bulk update-to-latest | AC-4, AC-5 | capability | `evals/deps-doctor/eval.yaml` -> `applies-the-selected-version-not-the-latest` | tool-calls + diff-empty + prompt | automated |

## Functionality Inventory

Reconciled against the real diff. Every shipped unit of functionality is listed
with its covering test.

| Unit | Covering test | Status |
|------|---------------|--------|
| `SKILL.md` core rules: forward-only fixes, no-op gate, approval gate, forbidden operations, untrusted data | T11, T14, T15, T16, T17, T19, T25 | covered |
| Core rule: run installs in a disposable sandbox, or disclose and get approval | none | uncovered: the eval environment cannot observe whether a sandbox was used, so this rule is asserted only by the skill text. A stimulus that grades the disclose-and-ask fallback would need executor support for reporting isolation state |
| Step 1 detection: language managers, non-manifest surfaces, ownership precedence, Yarn Classic vs Berry, blocked-manager reporting with one retry | T1, T2, T3 | covered |
| Step 2 update-bot deference, including activity verification, the unverified case, package-level overlap with in-flight bot pull requests, and superseding | T4, T4b | covered |
| Step 3 reconciliation: unused removal, runtime-referenced retention, phantom declaration | T5, T5b | covered |
| Step 4 version selection: release-age filter, manager-enforced setting, peer conflict resolution | T7, T7b, T12 | covered |
| Step 5 safe application: scripts-disabled resolve, changed-package review, non-registry source detection, applying a held-back selection by explicit version | T6, T10, T29 | covered |
| Step 6 security: exploitation-evidence ranking, new-package screening, transitive override | T8, T9, T18 | covered |
| Step 7 validation: clean-room frozen install, forward-only breaking-change migration, lockfile-conflict recovery | T11, T13, T25b | covered |
| Step 8 no-op gate: dependency-bearing file check, noise reversion, pre-existing work preservation | T14, T25 | covered |
| Step 9 summary, staged-diff check, post-push `changedFiles` verification and its approval requirement | T15 | partial: the post-push verification and its fresh-approval requirement are graded only through the approval stimulus, not a dedicated one |
| `references/ecosystem-commands.md` command tables, workspace handling, clean-room table | T1, T2, T6, T13, T24 | covered |
| `references/security-checks.md` release-age settings, audit table, screening checklist, override table | T7b, T8, T9, T18 | covered |
| `references/security-checks.md` container image scanning, runtime end-of-life, SBOM generation | none | uncovered by design: these are conditional add-on tools whose absence is reported rather than failed, and grading them would require a container build in the eval environment |
| Progressive disclosure: the agent opens `references/` rather than answering from memory | T7b, T27 | covered |
| Registration surfaces: catalog, marketplace, plugin manifest, site entry, eval matrix, thumbnails, companions | T20, T23 | covered |
| Eval integrity: schema validity, stimulus set, grader decisiveness, regex compilation, fixture and reference existence | T21, T22, T26, T27, T28 | covered |
