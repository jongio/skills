# Reporting

Lead with failures that can cause an outage, mail rejection, certificate
issuance failure, or verified takeover.

## Summary table

```text
| Area | Status | Coverage | Highest severity |
|---|---|---:|---|
| Registration, delegation, and records | Healthy | 13/13 verified | None |
| Website routing and TLS | Degraded | 5/6 verified | High |
| Mail authentication | Needs work | 7/9 verified | High |
| DNS security | Partially verified | 4/5 verified | Medium |
```

Coverage is:

```text
verified applicable checks / all applicable checks
```

Do not include not-applicable checks in the denominator. Keep corroborated,
inferred, and not-verified checks visible.

When a previous baseline exists, add this table before the area summary:

```text
| Delta | Count | Highest severity |
|---|---:|---|
| Added | 1 | Medium |
| Changed | 2 | High |
| Resolved | 1 | Medium |
| Unchanged | 18 | None |
| Not reverified | 2 | Medium |
```

Lead with Added, Changed, and Resolved details. Only call an item Unchanged
when current evidence was collected and normalized values match the baseline.

Use the IDs in [the audit checklist](audit-checklist.md). List every applicable
ID and state before calculating coverage so two auditors produce the same
denominator.

## Finding format

For every finding include:

```text
### [Severity] Short title

- Area:
- Verification: Verified | Corroborated | Inferred | Not verified
- Check ID:
- Evidence source:
- Observed: literal excerpt from the matching command result
- Expected:
- Impact:
- Owner: DNS | registrar | CDN | hosting | mail | application
- Fix:
- Dependencies:
- Rollback:
- Propagation expectation:
- Verify:
```

Include exact commands with secrets removed. Distinguish the command used to
observe the problem from the command that verifies the proposed fix.

Every status code, RCODE, record value, address, and certificate property in the
report must appear literally in a matching `Observed` excerpt. Never paraphrase
or substitute an expected value. If exact evidence is unavailable or conflicts,
mark the check Not verified and show the conflict.

## Severity

- **Critical**: active exploitation, verified claimability, broad credential
  exposure, or a current outage with no viable path.
- **High**: likely outage, mail rejection, broken DNSSEC validation, renewal
  failure, or strong takeover evidence.
- **Medium**: material hardening gap, stale configuration, or partial service
  degradation.
- **Low**: limited operational risk or maintainability issue.
- **Informational**: observed context with no required change.

Severity follows impact and evidence, not the record type.

## Remediation order

Order changes by dependency and blast radius. Common sequences include:

1. Restore a broken service path before hardening it.
2. Lower owner-controlled TTL before a planned migration, then wait for the old
   TTL to expire.
3. Publish child DNSSEC keys before adding parent DS.
4. Remove parent DS before disabling child signing.
5. Validate legitimate mail alignment before strengthening DMARC.
6. Preserve current certificate issuers before tightening CAA.

For each live change, show the exact provider object, before state, after state,
rollback payload, impact, and verification plan. Require explicit approval for
that mutation through
[approved change management](change-management.md). Re-run parent,
authoritative, recursive, HTTP, TLS, and provider checks after the applicable
propagation window.

## Recommended next steps

Every report ends with ordered actions. Include the owner, required access,
prerequisite evidence, why the order matters, what DNS Doctor can do, and the
verification and rollback expectation.

Then ask one focused question using `ask_user` when available:

```text
Would you like me to work through the prioritized fixes one at a time, or stop
with this report?
```

Offer:

1. `Work through fixes one at a time (Recommended)`
2. `Stop with report only`

Choosing the first option authorizes remediation planning, not a live change.
Use [approved change management](change-management.md) before every mutation.
