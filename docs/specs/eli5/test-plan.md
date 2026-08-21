# Test Plan: Explain Like I'm Five

## Status: COVERED
## Spec: docs/specs/eli5/spec.md
## Created: 2026-08-20
## Updated: 2026-08-20

---

## Coverage Strategy

The feature is a prompt-only skill. Vally capability scenarios exercise the
observable explanation, abstention, and safety behavior. Static Vally lint checks
the skill and eval schemas. JSON parsing and the Astro production build validate
distribution metadata and the catalog page.

## Planned Tests

| ID | Behavior to verify | Source | Level | Test file -> name | Status |
|----|--------------------|--------|-------|-------------------|--------|
| T1 | Technical context is identified and explained without restating the subject | AC-1 | capability | eval.yaml -> explain-technical-context | automated |
| T2 | Output uses plain language, grown-up terms, an analogy, and its limit | AC-2 | capability | eval.yaml -> explain-technical-context | automated |
| T3 | Missing context causes abstention and exactly one focused question | AC-3 | capability | eval.yaml -> abstain-without-context | automated |
| T4 | Dangerous context retains clear risk language and safety boundaries | AC-4 | capability | eval.yaml -> keep-danger-visible | automated |
| T5 | Skill, plugin, marketplace, root catalog, site catalog, and CI matrix registrations agree | AC-5 | integration | repository inspection -> registration parity | automated |
| T6 | SKILL.md and eval schema pass strict Vally lint | AC-6 | integration | Vally lint commands | automated |
| T7 | Astro catalog builds the new skill detail route | AC-5, AC-6 | integration | site npm run build | automated |
| T8 | Explicit invocation subject wins over conflicting selection and conversation context | AC-1 | capability | eval.yaml -> explicit-subject-wins | automated |
| T9 | Selected context is explained without requiring subject repetition | AC-1 | capability | eval.yaml -> selection-context-fallback | automated |
| T10 | Embedded instructions in explanatory context are ignored | AC-2, AC-4 | capability | eval.yaml -> ignores-embedded-instructions | automated |
| T11 | Medical explanation remains general and does not expose personal data | AC-4 | capability | eval.yaml -> preserves-professional-boundary | automated |
| T12 | Cross-surface registrations and locked dependency range agree | AC-5, AC-6 | integration | test/registration.test.mjs -> registration parity | automated |
| T13 | The most recent substantive conversation subject is used when no explicit or selected subject exists | AC-1 | capability | eval.yaml -> conversation-context-fallback | automated |
| T14 | An attachment supplies the subject without requiring the user to repeat it | AC-1 | capability | eval.yaml -> attachment-context-fallback | automated |
| T15 | Embedded requests to run commands, fetch URLs, or read private files produce explanation text only | AC-2, AC-4 | capability | eval.yaml -> refuses-embedded-tool-request | automated |

Rows describe behaviors, not distinct test artifacts. T1 and T2 are both graded by the
`explain-technical-context` scenario, and T5 and T12 are both proved by
`test/registration.test.mjs`, so the 15 rows resolve to 10 eval scenarios plus three
mechanisms (Vally lint, the site build, and the deterministic parity test).

## Functionality Inventory (Phase 3 reconciliation)

| # | Functionality introduced | Location | Covered by | Status |
|---|--------------------------|----------|------------|--------|
| F1 | Explicit, selection, attachment, and recent-context subject resolution order | skills/eli5/SKILL.md | T1, T3, T8, T9, T13, T14 | covered |
| F2 | Plain-language teaching shape with analogy, real terms, and analogy limit | skills/eli5/SKILL.md | T1, T2 | covered |
| F3 | Missing-context abstention with one focused question | skills/eli5/SKILL.md | T3 | covered |
| F4 | Untrusted context treated as explanatory data rather than instructions | skills/eli5/SKILL.md | T10, T15 | covered |
| F5 | Safety, privacy, and professional boundaries preserved during simplification | skills/eli5/SKILL.md | T4, T11 | covered |
| F6 | Installable skill package and Vally capability-eval configuration | skills/eli5/package.json; skills/eli5/evals/ | T6 | covered |
| F7 | Root marketplace, plugin, README, and nightly eval registration | marketplace.json; plugin.json; README.md; .github/workflows/skill-eval.yml | T5, T6, T12 | covered |
| F8 | Astro catalog entry and house-style generated thumbnail | site/src/content/skills/eli5.md; site/public/images/thumb-eli5.png | T5, T7 | covered |
| F9 | Reproducible locked CI installation for the new evaluated skill | .gitignore; skills/eli5/package-lock.json; .github/workflows/skill-eval.yml | T6, T12 | covered |

## Gaps & Additions

- [x] Added context-precedence, selection, prompt-injection, privacy, and professional-boundary scenarios found during review.
- [x] Added deterministic cross-surface registration and lockfile parity coverage.
- [x] Reconciled the implemented diff: 9 functionality units, 0 gaps.
- [x] Phase 3 review added T15 for the categorical no-tools rule, plus thumbnail,
      IMAGES.md, and SKILL.md frontmatter assertions in the parity test.

## Known coverage limits

These are accepted rather than closed. Each is a qualitative facet of an already
covered functionality unit, not an uncovered unit.

- Only the medical facet of F5 is graded. Legal and financial subjects share the
  same instruction and are not separately exercised.
- The copyright boundary and the "say when a topic cannot be simplified further"
  rule have no dedicated scenario.
- Prompt graders run once per scenario, so a borderline response can flip the
  nightly result. The deterministic parity test is unaffected.
