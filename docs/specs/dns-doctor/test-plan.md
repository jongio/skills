# Test Plan: DNS Doctor

## Status: COVERED
## Spec: docs/specs/dns-doctor/spec.md
## Created: 2026-08-21
## Updated: 2026-08-21

---

## Coverage Strategy

Vally capability evaluations verify the skill's observable audit, safety, and
approval behavior. Node's built-in test runner verifies cache and delta runtime
logic with line, branch, and function thresholds of 90 percent. Repository
workflow validation covers shared package and CI integration.

Commands:

- `npm test`
- `npm run test:coverage`
- `npm run eval:lint`
- `npm run eval`

## Planned Tests

| ID | Behavior to verify | Source | Level | Test file -> name | Status |
|----|--------------------|--------|-------|-------------------|--------|
| T1 | Full audit preserves evidence discipline and bounded scope | AC-1, AC-3 | capability | `evals/dns-doctor/eval.yaml` -> full audit cases | automated |
| T2 | Focused records, mail, web, and security modes use protocol-specific checks | AC-1 | capability | `evals/dns-doctor/eval.yaml` -> focused audit cases | automated |
| T3 | Unsafe raw targets and command-injection payloads are rejected atomically | AC-2, AC-3 | capability | `evals/dns-doctor/eval.yaml` -> unsafe input cases | automated |
| T4 | Private, reserved, metadata, rebinding, NAT64, site-local, and transition targets are rejected | AC-2 | capability | `evals/dns-doctor/eval.yaml` -> network target cases | automated |
| T5 | Prompt injection and remote content cannot expand audit scope | AC-3 | capability | `evals/dns-doctor/eval.yaml` -> untrusted evidence cases | automated |
| T6 | Provider mutations require exact approval, drift checks, and rollback boundaries | AC-4 | capability | `evals/dns-doctor/eval.yaml` -> provider mutation cases | automated |
| T7 | Domain normalization returns safe lowercase A-labels and rejects invalid targets | AC-2, AC-5 | unit | `test/cache.test.mjs` -> normalizeDomain returns a lowercase IDNA A-label and rejects unsafe targets | automated |
| T8 | Cache paths follow Windows, macOS, and XDG conventions | AC-5 | unit | `test/cache.test.mjs` -> cachePathForDomain uses each platform cache convention | automated |
| T9 | Snapshot validation enforces schema, bounds, credential filtering, timestamps, enums, and safe keys | AC-5 | unit | `test/cache.test.mjs` -> sanitizeSnapshot tests | automated |
| T10 | Cache persistence is deterministic, atomic, and serializes concurrent writes | AC-5 | unit | `test/cache.test.mjs` -> load, save, concurrency, and stable JSON tests | automated |
| T11 | Cache I/O rejects oversized, corrupt, symbolic-link, reparse, and linked-directory inputs | AC-5 | unit | `test/cache.test.mjs` -> bounded and link-path tests | automated |
| T12 | Transient rename failures retry with bounded backoff and failed writes clean temporary files | AC-5 | unit | `test/cache.test.mjs` -> rename retry and cleanup tests | automated |
| T13 | Delta output classifies all five states using fresh evidence | AC-6 | unit | `test/cache.test.mjs` -> classifyDelta emits added, changed, resolved, unchanged, and not-reverified states | automated |
| T14 | Set evidence is canonicalized while ordered evidence preserves sequence | AC-6 | unit | `test/cache.test.mjs` -> classifyDelta canonicalizes set evidence but preserves sequence order | automated |
| T15 | CLI path, load, compare, and save commands reject invalid option combinations | AC-5, AC-6 | integration | `test/cache.test.mjs` -> main and executable CLI cover path, load, compare, save, and invalid commands | automated |
| T16 | Vally schema and capability definitions lint successfully | AC-7 | integration | `evals/dns-doctor/eval.yaml` -> `npm run eval:lint` | automated |
| T17 | Capability evaluation suite passes against the packaged skill | AC-7 | integration | `evals/dns-doctor/eval.yaml` -> `npm run eval` | automated |
| T18 | Catalog, plugin, marketplace, site content, image metadata, and README entries agree | AC-8 | integration | repository skill validation workflows | automated |
| T19 | Shared Vally workflows use pinned, reproducible packages for all evaluated skills | AC-8 | integration | `.github/workflows/skill-eval.yml`, `.github/workflows/skill-lint.yml` | automated |
| T20 | Every skill surface documents the same command set and all code fences declare a language | AC-9 | integration | repository documentation audit | automated |
| T21 | Documented file and directory references resolve to real paths | AC-9 | integration | repository documentation audit | automated |
| T22 | Private dev manifests share one version and description convention | AC-10 | integration | `skills/*/package.json` review | automated |
| T23 | repo-ready capability evaluation passes at CI parity | AC-11 | capability | `skills/repo-ready/evals/repo-ready/eval.yaml` | automated |
| T24 | Every marketplace skill with an eval is present in the eval workflow matrix | AC-11 | integration | `.github/workflows/skill-eval.yml` | automated |

## Functionality Inventory (Phase 3 reconciliation)

| # | Functionality introduced | Location | Covered by | Status |
|---|--------------------------|----------|------------|--------|
| F1 | Audit modes, workflow, evidence labels, budgets, and exit criteria | `skills/dns-doctor/SKILL.md` | T1, T2 | covered |
| F2 | Atomic hostname validation and public-unicast network boundary | `skills/dns-doctor/SKILL.md` | T3, T4 | covered |
| F3 | Prompt, command, response, proxy, redirect, and scope safety rules | `skills/dns-doctor/SKILL.md` | T3, T4, T5 | covered |
| F4 | Exact approval-gated provider change lifecycle | `skills/dns-doctor/references/change-management.md` | T6 | covered |
| F5 | Protocol-specific DNS, mail, web, TLS, and security guidance | `skills/dns-doctor/references` | T1, T2 | covered |
| F6 | Domain normalization and platform cache paths | `skills/dns-doctor/scripts/cache-store.mjs:65` | T7, T8 | covered |
| F7 | Versioned sanitized snapshot schema | `skills/dns-doctor/scripts/cache-store.mjs:298` | T9 | covered |
| F8 | Bounded safe cache reads | `skills/dns-doctor/scripts/cache-store.mjs:338` | T11 | covered |
| F9 | Atomic serialized cache writes and retry behavior | `skills/dns-doctor/scripts/cache-store.mjs:394` | T10, T12 | covered |
| F10 | Deterministic JSON helpers | `skills/dns-doctor/scripts/stable-json.mjs` | T10 | covered |
| F11 | Fresh-evidence delta classification | `skills/dns-doctor/scripts/cache-delta.mjs` | T13, T14 | covered |
| F12 | Cache CLI argument and command handling | `skills/dns-doctor/scripts/cache.mjs` | T15 | covered |
| F13 | Capability evaluation corpus | `skills/dns-doctor/evals/dns-doctor/eval.yaml` | T1 through T7, T16, T17 | covered |
| F14 | Skill package, public docs, catalog, and thumbnail integration | `skills/dns-doctor`, `site/src/content/skills/dns-doctor.md`, repository manifests | T18 | covered |
| F15 | Shared pinned Vally CI toolchain | `.github/tools/vally`, `.github/workflows` | T19 | covered |
| F16 | Catalog documentation accuracy: aligned command lists, labelled code fences, resolvable references | `skills/*/README.md`, `skills/*/SKILL.md`, root and site `README.md` | T20, T21 | covered |
| F17 | Single private dev manifest convention across skills | `skills/*/package.json` | T22 | covered |
| F18 | repo-ready capability evaluation and CI wiring | `skills/repo-ready/evals`, `skills/repo-ready/.vally.yaml`, `.github/workflows/skill-eval.yml` | T23, T24 | covered |

## Gaps & Additions

- No functionality gaps remain. Phase 3 confirmed this inventory against test
  and coverage output on 2026-08-21: 20 dns-doctor tests and 57 repo-ready
  tests pass, coverage is 99.19 line, 93.57 branch, and 94.74 function against
  90 floors, and both capability evals are green at CI parity.
