# Pipeline Evidence: Explain Like I'm Five

## Phase 1

GATE EVIDENCE:
  phase: 1
  gate: scope-and-plan
  command: devx-product-requirements; devx-board-review; devx-interview; devx-architecture-design; devx-plan; devx-gut-check
  exit_code: 0
  scope: P1 user-facing installable skill; issue creation deferred to Phase 5 human gate
  output: 6 acceptance criteria, 0 open questions, 7 planned tests, approved product and architecture documents

## Phase 2

GATE EVIDENCE:
  phase: 2
  gate: build
  command: npm run eval:lint; npx vally lint .; npm run build
  exit_code: 0
  scope: skill contract, capability evals, distribution manifests, Astro catalog, CI matrix
  output: strict eval schema valid; skill lint 2/2; 8 Astro pages built; 7/7 planned tests automated

## Phase 3

GATE EVIDENCE:
  phase: 3
  gate: verify
  status: BLOCKED (pinned upstream reviewers unavailable)
  command: node test/registration.test.mjs (x5 skills); vally lint . --strict; vally lint --eval-spec --strict (x3); npm run build (site); npm ci --dry-run (x5); npm audit (x4)
  exit_code: 0
  scope: new skill contract, capability evals, deterministic parity test, distribution manifests, Astro catalog, CI workflows, skill dependency lockfiles
  output: 5/5 skill test suites pass; skill lint 2/2; 3/3 eval specs valid under strict lint; site builds 8 pages including the new catalog route; npm ci validates for all 4 skills plus site; 0 vulnerabilities across all 4 skills (was 4 moderate in 3 of them)
  devx_reviews: devx-code-review, devx-secops, devx-refactoring, devx-smells, devx-idiomatic-audit, devx-dependencies, devx-test-health
  findings_fixed: 8 (categorical no-tools contract rule, new injection eval scenario, 6 parity-test hardening assertions, base.sha env routing, duplicated trigger paths collapsed, OTel advisories cleared, engine floor corrected, test-plan reconciliation corrected)
  findings_rejected: 3 (allowScripts "inert lavamoat schema" disproved; "injection contract adequate" rested on a fabricated SKILL.md quote; "new eval keys may fail strict lint" disproved by running the lint)
  findings_deferred: 1 (IDIO-001 GitHub Actions SHA pinning, owner-accepted as a repo-wide policy change; all five refs are first-party actions/*)
  ci_hygiene_added: job timeout-minutes on all three jobs; npm caching enabled by the committed lockfiles
  upstream_blocker: source-lock.mjs --entry code-review exits 1 (gh HTTP 404 on the pinned private source wbreza/skills@349f8c31). Neither authenticated account can read it, so devx-wbreza-code-review, devx-wbreza-security-review, and devx-wbreza-ux-verification cannot run and no proof receipt can be recorded. The protocol forbids running a partial or unverified upstream workflow, so this is recorded as blocked rather than satisfied or waived. Root cause is environmental access to a third-party private repository, independent of this change set. Repository owner elected on 2026-08-21 to skip the pinned upstream review for now and proceed. This gate remains OPEN and must be satisfied before the P1 claim is complete.
  upstream_blocker_triage: N/A (blocked)
  upstream_approval_equivalent: N/A (blocked)
  upstream_source: N/A (blocked)
  upstream_scope_check: N/A (blocked)
  upstream_base_sha: N/A (blocked)
  upstream_proof: N/A (blocked)
  review_convergence_rounds: N/A (blocked)
  reviewer_provenance: N/A (blocked)

## Phase 4

GATE EVIDENCE:
  phase: 4
  gate: certify
  status: COMPLETE
  command: devx-doc-check; devx-anti-slop; devx-accessibility-audit; devx-design-review; npm test (x5 skills); npm run build (site); vally lint
  exit_code: 0
  scope: user-facing documentation, catalog copy, the new catalog route, and the new thumbnail
  acceptance_criteria: 6 of 6 satisfied (AC-1 through AC-6 mapped to T1 through T15 and to executed commands)
  functional_requirements: 7 of 7 satisfied. FR-7 ("produce explanation text only, do not execute tools") was unimplemented in the skill contract until Phase 3 and is now covered by the contract rule and eval T15.
  constraints: no Reddit branding or affiliation claim appears in any shipped artifact
  doc_check: 0 critical, 0 high, 1 medium fixed (eval README undercounted scenarios), 4 low fixed (no-side-effects rule now stated in skill README and catalog copy, thumbnail copies made byte-identical and guarded by a test assertion, spec phase field updated, npm test documented)
  anti_slop: grade A, zero em or en dashes, zero buzzwords, 1 low fixed (spaced-hyphen title separator in product-reqs.md)
  accessibility: axe-core executed in Chromium on the catalog and the new detail route in both themes. One serious violation was found and fixed: dark-mode solid buttons rendered white on #2f81f7 at 3.75 against a 4.5 requirement. Fixed by adding a dedicated --accent-solid token for filled controls (#1f6feb in dark, 4.63) while leaving --accent unchanged for link text. The simpler fix of darkening --accent globally was rejected because it drops dark-mode link contrast to 4.08. Re-verified after the fix: 0 violations on /catalog/ and /catalog/eli5/ in both light and dark themes.
  design_review: order value 5 unique, useWhen phrasing consistent, palette consistent. The reported thumbnail aspect-ratio mismatch was initially rejected because the hand-authored 640x400 SVG matched the card's own 16/10 box, but the thumbnail was later regenerated with gpt-image-2 as a 1024x1024 PNG in the shared house style, which resolves the finding at its root: the asset now matches its four siblings in format, dimensions, and art direction.
  thumbnail: generated with gpt-image-2 (deployment on jong-image-westus3) at 1024x1024 quality high, from the prompt now recorded verbatim in docs/thumbnail-prompts.md. Replaces the earlier hand-authored SVG. The parity test asserts the catalog copy is byte-identical to the installed one and that the file is a 1024x1024 PNG.
  final_verification: 5 of 5 skill test suites pass; site builds 8 pages; skill and eval specs pass strict lint
  post_certify_rename: The skill id changed from explain-like-im-five to eli5 at owner request so it is invoked as /eli5. The rename covered the skill directory, eval directory, spec folder, catalog entry, thumbnail asset, and every registration surface. The spec's naming decision was rewritten rather than left contradicting itself, and a duplicate plugin.json keyword introduced by the bulk rename was removed. Re-verified after the rename: 5 of 5 suites pass, strict lint passes, the catalog route is now /catalog/eli5/, and npm ci still validates.

## Phase 5

Status: NOT STARTED (awaiting human approval to commit and open a pull request)
