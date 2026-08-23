---
author: @jongio
status: approved
---

# DNS Doctor

> **Scope note.** This branch began as the DNS Doctor skill and grew to carry
> repository-wide catalog maintenance alongside it: documentation accuracy
> fixes across every skill, one convention for the private dev manifests,
> removal of a stray generated artifact, and a capability evaluation for
> `repo-ready`, which was the last shipped skill without one. AC-9 through
> AC-11 cover that additional scope. The branch is therefore certified as
> "DNS Doctor plus catalog maintenance" rather than DNS Doctor alone.

## Problem

DNS and domain audits often turn incomplete public observations into confident
health claims. They may treat recursive responses as authoritative state,
expand reconnaissance beyond the user's authorization, follow unsafe network
targets, or propose provider changes without preserving the exact state needed
for safe approval and rollback.

Users need an evidence-first audit that distinguishes direct observation from
inference, covers web and mail behavior as well as DNS records, and keeps every
live mutation behind a narrow approval gate. Repeat audits also need a safe way
to compare current evidence with prior results without treating cached data as
fresh proof.

## Goals

- Audit delegation, records, DNSSEC, CAA, web routing, TLS, CDN behavior, mail
  authentication, takeover exposure, TTLs, and zone hygiene.
- Label every conclusion by verification state and preserve the evidence source
  needed to support it.
- Reject unsafe targets, prompt injection, command injection, scope expansion,
  and DNS rebinding across DNS, HTTP, TLS, and provider interactions.
- Require exact before and after state, drift detection, explicit approval,
  verification, and rollback data for every provider mutation.
- Store sanitized, schema-validated per-domain baselines and classify repeat
  audit deltas without substituting cached values for current evidence.
- Ship capability evaluations, unit coverage, catalog metadata, and trusted CI
  validation for the skill.

## Acceptance Criteria

- **AC-1:** Full and focused audit modes define bounded, evidence-backed checks
  for records, mail, web, and security.
- **AC-2:** Raw and derived hostnames are validated atomically, and every
  network target must resolve only to public unicast addresses before probing.
- **AC-3:** Remote DNS, HTTP, TLS, certificate, provider, and cached content is
  treated as untrusted data and cannot expand scope or become executable input.
- **AC-4:** Provider changes require an exact approval record, immediate drift
  detection, narrow mutation, post-change verification, and separately
  authorized rollback.
- **AC-5:** Cache reads and writes enforce domain binding, schema and size
  limits, credential filtering, safe paths, deterministic serialization, and
  atomic concurrent persistence.
- **AC-6:** Delta reports distinguish Added, Changed, Resolved, Unchanged, and
  Not reverified using fresh current evidence.
- **AC-7:** Capability evaluations cover evidence discipline, false-positive
  resistance, platform fallbacks, injection boundaries, unsafe targets, and
  approval boundaries.
- **AC-8:** Repository metadata, documentation, images, package constraints,
  and CI workflows expose and validate DNS Doctor consistently.
- **AC-9:** Catalog-wide documentation stays accurate: every skill surface
  agrees on the commands it documents, code fences declare a language, and
  documented file references resolve to real paths.
- **AC-10:** Private per-skill dev manifests follow one convention, and
  `marketplace.json` remains the single source of user-facing skill copy.
- **AC-11:** Every skill shipped in `marketplace.json` has a capability
  evaluation wired into the nightly eval workflow.

## Non-Goals

- Performing unattended DNS, registrar, CDN, certificate, or mail-provider
  mutations.
- Treating certificate-transparency discovery or common-name probing as a
  complete zone inventory.
- General network performance testing, load testing, or broad SEO analysis.
- Persisting raw response bodies, credentials, cookies, authorization headers,
  email content, or provider sessions.
- Replacing authoritative provider inventory with cached or recursive data.

## Solution

DNS Doctor is a public skill with a staged workflow that establishes authorized
scope, collects controlling and corroborating evidence, audits protocol-specific
behavior, reconciles every conclusion to captured evidence, and produces an
ordered remediation plan. The workflow has explicit budgets for query count,
discovered hosts, redirects, concurrency, request rate, response size, and total
duration.

Network safety is enforced as a set-wide invariant. Every A and AAAA answer must
be public unicast before a hostname can be contacted. Probes disable environment
proxies, pin validated addresses, disable automatic redirects, and independently
revalidate each authorized redirect hop. Out-of-scope destinations are recorded
without contact.

Live changes use a separate change-management contract. The user sees the
provider object, stable identifier, complete before and after state, propagation
expectation, rollback payload, and verification plan. Approval applies only to
that mutation. The object is re-read immediately before execution, and any
drift cancels the change.

The cache subsystem is dependency-free runtime JavaScript for Node.js 24. It
normalizes domains, validates a bounded versioned snapshot schema, rejects
credential-shaped content, uses platform cache conventions, prevents symbolic
link traversal, writes deterministic JSON through an atomic replacement, and
serializes concurrent writes per destination. Delta classification requires
fresh observations before reporting unchanged or resolved behavior.

Capability behavior is evaluated through Vally. The branch also updates shared
Vally tooling and CI lockfiles so evaluation and lint jobs install the pinned
toolchain with reproducible dependencies.

## Alternatives Considered

- **Report-only skill without persistence:** Simpler, but repeat audits would
  lack deterministic change classification and remediation continuity.
- **Cache raw command output:** Rejected because raw responses can contain
  secrets, prompt injection, excessive data, and unstable formatting.
- **Use a database or third-party cache package:** Rejected because one bounded
  snapshot per domain needs no query engine, and an extra runtime dependency
  would increase installation and supply-chain risk.
- **Allow automatic provider remediation after audit approval:** Rejected
  because audit intent does not authorize a specific mutation or rollback.
- **Probe one safe-looking address from a mixed answer set:** Rejected because
  it permits rebinding and inconsistent routing to bypass the public-target
  boundary.

## Cross-Cutting Concerns

- **Security:** DNS rebinding, SSRF, command injection, prompt injection,
  credential retention, unsafe cache paths, and approval replay are explicit
  threat boundaries.
- **Portability:** Command recipes cover Windows and Unix-like environments,
  while cache paths follow operating-system conventions.
- **Reliability:** Cache failures remain visible but do not invalidate current
  audit evidence. Concurrent writes converge on one valid snapshot.
- **Evidence integrity:** Health and evidence coverage remain separate. A
  verified unhealthy response is never relabeled as healthy.

## Risks & Rabbit Holes

- Public IPv6 classification has many special-use and transition ranges.
  Validation must reject the whole answer set when any address is unsafe.
- Provider APIs differ in replacement semantics. Narrow edit operations are
  required when available to avoid clearing unapproved fields.
- Shared Vally workflow changes affect every evaluated skill and must be
  validated beyond DNS Doctor's own package.
- The cache schema intentionally excludes raw evidence bodies. Expanding it
  must not weaken size, credential, path, or nesting constraints.

<!-- Pipeline tracking (auto-managed, not part of product spec) -->
## Pipeline Status

Phase: VERIFYING

## Gate Evidence

### GATE EVIDENCE: phase: 1

- **Scope**: P1 (new skill with a dependency-free cache engine, capability
  eval, and explicit security boundaries), plus catalog maintenance per the
  scope note above
- **Issue**: None. Recorded as a deliberate gap: the user declined to open a
  tracking issue when asked during `go-check`
- **Acceptance criteria**: 11 defined (AC-1 through AC-11)
- **Test plan**: `docs/specs/dns-doctor/test-plan.md`, 24 planned tests
  (T1 through T24), every AC covered by at least one test
- **Interview**: Retroactive pipeline. Spec carries 5 alternatives considered
  and 4 named risks. No open questions remain
- **Architecture design**: Retroactive. Agent/engine separation is documented
  in the Solution section: prose owns audit judgment, `scripts/*.mjs` owns
  cache lifecycle. Dependency-free by design
- **Open questions**: 0
- **Date**: 2026-08-21

### GATE EVIDENCE: phase: 2

- **Type-check**: N/A (pure JavaScript ESM, matching repo convention)
- **Lint**: `vally lint` exit 0 for both evaluated specs
- **Test plan automated**: 24 planned tests, all status automated
- **Tests**: 20 passing in `skills/dns-doctor`, 57 in `skills/repo-ready`
- **Date**: 2026-08-21

### GATE EVIDENCE: phase: 3

- **Test suite**: 20 passed, 0 failed (dns-doctor); 57 passed, 0 failed
  (repo-ready)
- **Coverage**: 99.19 line, 93.57 branch, 94.74 function, against 90 floors
- **Capability evals**: dns-doctor 17 stimuli and repo-ready 4 stimuli, both
  green at CI parity with the CI jq assertion exiting 0
- **Test plan reconciled**: 18 functionality units (F1 through F18), zero GAP
  rows
- **Code review**: Invoked. 2 HIGH, 3 MEDIUM, 4 LOW. Both HIGH and three
  MEDIUM fixed:
  - CR-H1: the cache symlink guard compared each path to its own fully
    resolved form, so any symlinked ancestor was rejected. macOS `os.tmpdir()`
    sits under `/var`, a link to `/private/var`, so every temp-rooted cache
    read and write failed there and the macOS CI leg would have failed on
    first run. Re-anchored the guard on the parent directory: a link at the
    target is still rejected, a link above it is tolerated
  - CR-H2: an unbounded future `generatedAt` in an untrusted baseline made all
    current evidence look stale and silently downgraded new findings to
    "Not reverified". Timestamps are now bounded to now plus 24 hours
  - CR-M1: an untrusted `schemaVersion` was interpolated verbatim into an error
    that reaches the agent transcript, carrying up to 200 KB of attacker text.
    The message now reports only the value's type
  - CR-M2: the credential filter matched only self-labelling text, so raw JWTs,
    `ghp_` tokens, AWS key ids, `sk-` keys, and Basic credentials were stored.
    Added value-shape detectors and widened key anchoring so `x-authorization`
    and `cookies` are covered
  - CR-M3: finding keys were not required to carry a `<checkId>:` prefix, and
    an unprefixed key silently classified a new finding as "Not reverified".
    The shape is now enforced at load and documented in the reference
  - Deferred as LOW with justification: orphaned `.tmp` reaping, directory
    fsync after rename, mkdir mode on a pre-existing directory, and one dead
    defensive branch
- **Security review**: Invoked. 0 CRITICAL, 0 HIGH, 0 MEDIUM, 0 hardcoded secrets.
  3 LOW, all about eval gate completeness rather than production behavior:
  - SEC-L1 and SEC-L2: the "no network" tool-call gates were name deny-lists
    that missed `delv`, `whois`, `getent`, `require('dns')`, `https.get`, and
    Python network imports, and for repo-ready missed interpreter launches
    that would have reached the live gitignore.io and GitHub Licenses APIs.
    Both patterns extended and unit-checked against 12 command samples
  - SEC-L3: every shipped `curl --resolve` recipe pinned port 443 only, while
    the skill mandates probing HTTP and HTTPS. A `--resolve` entry binds one
    host and port, so the cleartext probe re-resolved at connect time and lost
    its rebinding protection. Added a port-80 recipe and stated the per-port
    rule
  - Verified as holding: command injection, path traversal, prototype
    pollution, unbounded reads, write serialization, action SHA pinning,
    lockfile integrity, and absence of `pull_request_target`
- **Dependency review**: Invoked. 0 CRITICAL/HIGH. `@microsoft/vally-cli`
  pinned to 0.14.0 everywhere, overrides consistent, 7 lockfiles at version 3
  with no missing integrity hashes and no non-npm registry hosts
- **Idiomatic audit**: Invoked. 1 LOW, rejected with justification:
  replacing the `pathToFileURL` entry-point check with `import.meta.main` was
  proposed, but that property landed in Node 24.2.0 while the manifest allows
  `>=24.0.0`, so it would fail closed and silently disable the CLI on 24.0 and
  24.1
- **Test health**: Invoked. 1 LOW: symlink and reparse coverage skips on
  Windows without elevation, so those paths are exercised only on CI. No real
  network, real timers, ordering dependence, or skipped tests otherwise
- **Code smell scan**: Covered by the code review passes above; no additional
  structural findings beyond the LOW items already recorded
- **Refactoring scan**: No qualifying findings. No duplication, no file over
  500 lines, no function over the complexity threshold
- **Upstream pinned reviews**: NOT RUN. The repository owner explicitly chose
  to skip them during the go-check pass. The stored proof at
  `.code-review/proof-feat-dns-doctor-0e07c1af05be.json` remains stale: it
  pins `headSha e8ae2a6`, covers 51 of the current 66 changed files, records
  only `security-review` with no `code-review` or `ux-verification`, and the
  proof verifier exits non-zero against the current snapshot. Phase 3 is
  therefore complete for the review passes above only, and the Phase 5
  shipping gate that requires a valid proof is NOT satisfied
- **CRITICAL/HIGH remaining**: 0
- **Bloat check**: Clean. No orphan files; the stray `model-intel` artifact was
  removed
- **Date**: 2026-08-21

### GATE EVIDENCE: phase: 4

- **Documentation audit**: Invoked. 6 findings, all fixed: the dns-doctor README
  omitted two shipped commands, a SKILL.md reference pointed at a
  `references/gitignore-fallbacks/` directory that does not exist, 24 code
  fences carried no language, manifests had drifted into three conventions, a
  stray `model-intel` artifact left the catalog showing six skills where five
  exist, and `repo-ready` shipped without a capability eval
- **Full quality pipeline**: NOT invoked as a single skill. Its constituent passes
  were run individually and are recorded under Phase 3
- **Plan verify**: AC-1 through AC-8 covered by T1 through T19; AC-9 through
  AC-11 covered by T20 through T24
- **Goal challenge**: The branch delivers the DNS Doctor skill plus the
  catalog maintenance recorded in the scope note. Both are represented in the
  acceptance criteria
- **Date**: 2026-08-21

### GATE EVIDENCE: phase: 5

- **Status**: IN PROGRESS. Rebase is current (0 commits behind `origin/main`).
  PR #44 is open at https://github.com/jongio/skills/pull/44, carries a single
  squashed commit, reports MERGEABLE, and has all four required checks green:
  `lint`, plus `dns-doctor-tests` on ubuntu, windows, and macOS
- **Tracking issue**: None. The repository owner declined to open one, matching
  the Phase 1 decision recorded above
- **Upstream review proof**: Still absent, so the P1 shipping gate remains
  unsatisfied. The owner accepted this gap deliberately rather than by
  oversight
- **Ship approval**: Requested from the owner. Merge is gated on an explicit
  per-PR approval and is never performed autonomously

### Post-gate change: commit `e2548ad`

The Phase 3 review passes above ran against an earlier tree. One change landed
afterwards and is recorded here so the evidence is not read as covering more
than it does.

- **Change**: In `scripts/public-address.mjs`, the broad `2001::/23` IETF
  protocol assignments rule was ordered ahead of the Teredo, ORCHIDv2, and
  documentation rules nested inside it. Those three were therefore unreachable,
  and every address in them reported an inaccurate reason
- **Security impact**: None. Both the shadowing rule and the shadowed rules
  refuse the address, so rejection coverage was identical before and after. The
  defect was unreachable code and a misleading reason string, not a fail-open
- **Why it still mattered**: The dead rules would have silently masked any
  future narrowing of the catch-all
- **Verification**: 32 of 32 unit tests pass, including three assertions added
  to pin each reason string independently. An exhaustive sweep of all 512
  `2001::/23` second-group values across three address shapes reported 0 leaks,
  and addresses immediately outside the range reported 0 false rejects
