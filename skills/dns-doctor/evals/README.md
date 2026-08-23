# dns-doctor eval

This Vally capability evaluation checks whether an agent using `dns-doctor`
performs an evidence-first audit rather than producing a generic DNS grade.

The stimuli cover:

- reconciliation of a supplied full-audit evidence set whose reported values
  must match the raw results exactly
- an unresolved SaaS alias that must not be called a verified takeover
- a provider-verified claimable alias that must be escalated without claiming it
- protocol traps involving ANY, recursive divergence, SPF, DKIM, CDN errors,
  and context-dependent TTLs
- Windows DNS-client gaps plus hostile input that must not reach the shell or a
  private endpoint
- UTS 46 and IDNA boundary handling for valid Unicode and invalid raw inputs
- successful DNSSEC, CAA, SPF, DKIM, DMARC, MTA-STS, TLS-RPT, and TLS analysis
- DNS rebinding resistance through address validation and connection pinning
- authoritative-query and AXFR pinning for mixed safe and unsafe address sets
- refusal to attempt AXFR without explicit owner authorization
- prompt-injection resistance for DNS, HTTP, and provider evidence
- refusal to mutate provider state from a broad or unapproved request
- exact approval scope, drift detection, minimal provider edits, verification,
  failure handling, and approval-gated rollback
- sanitized baseline reuse without treating cached values as current evidence
- added, changed, resolved, unchanged, and not-reverified delta classification
- ordered next steps and an explicit report-only or remediation-planning choice

The dependency-free unit suite separately verifies the executable cache
lifecycle, including platform paths, IDNA binding, strict sanitation, bounded
reads, symbolic-link refusal, deterministic JSON, concurrent atomic writes,
and all delta states.

The eval uses supplied evidence, deterministic safety graders, and prompt
graders so it never depends on changing live DNS or provider state. Pull
requests and local runs use one trial for fast feedback. Nightly and manual CI
runs use five trials to measure judge variance. Live query and mutation
execution are intentionally outside this deterministic suite.

Every scenario requires the `dns-doctor` skill to be invoked. Two of them,
hostile-input and unauthorized-AXFR, previously omitted that requirement
because the base agent could refuse the unsafe request before loading a skill.
Both prompts now ask for a fact that cannot be answered without the skill, such
as the audit budget or the authorized-transfer caps, so the requirement holds
without weakening the refusal itself.

## Cache isolation

Stimuli must never write into the user's real cache. The skill's step 10 tells
the agent to persist a baseline, so a prompt that lets an audit run to
completion will write to the operating-system cache location, which sits
outside the workspace and is therefore invisible to the `diff-empty` grader.

Two rules keep runs hermetic:

- Any stimulus that is not exercising cache persistence states `no-cache` mode
  explicitly, which is the documented way to run without reading or writing a
  baseline.
- Anything that does need a cache passes `--cache-root <directory>` to
  `scripts/cache.mjs`, which replaces the platform location for that
  invocation. `test/cache.test.mjs` asserts that all four commands honour it
  and that the platform location is never created.

## Run

From `skills/dns-doctor`:

```sh
npm ci --ignore-scripts
npm test
npm run test:coverage
npm run eval:lint
npm run eval
```

The full eval drives a Copilot agent and requires Copilot authentication.
