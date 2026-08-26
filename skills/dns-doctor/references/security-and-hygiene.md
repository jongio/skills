# Security and Hygiene

## DNSSEC

Validate the chain, not just the presence of DS:

1. Query DS from the parent side of the delegation.
2. Query DNSKEY and signed RRsets from every authoritative server.
3. Confirm DS digest, algorithm, and key tag match the active key.
4. Validate positive and negative answers with `delv`, a validating resolver,
   DNSViz, or an equivalent validator.
5. Compare at least two independent validating paths.
6. Check signature inception and expiration.

The resolver AD bit is useful corroboration but not a complete diagnosis.
SERVFAIL from a validating resolver can indicate a bogus chain, transport
failure, or resolver policy. Trace parent, child, and signature evidence before
assigning cause.

Do not label every RSA/SHA-256 DNSSEC deployment obsolete. Judge algorithms
against current standards, registry status, provider support, and rollover
capability.

### DS placement and negative-answer encoding

The DS record lives in the parent zone and is published through the registrar,
not through the DNS hosting provider. When those are different companies, a
zone can be fully signed while the delegation stays unsigned, and no change in
the DNS host can complete the chain. State the registrar by name, and treat
registry evidence such as `signedDelegation` as authoritative for acceptance
while the parent's published DS answer remains authoritative for activation.
The two can lag each other, so report a submitted but unpublished DS as in
progress rather than failed.

Enabling DNSSEC can also change how a zone denies names. Providers using
synthesized denial return `NOERROR` with no data instead of `NXDOMAIN` for names
that do not exist. Consequences:

- `NOERROR/NODATA` is not evidence that a deleted name still exists. Compare the
  suspect name against a random nonce label in the same zone. Matching responses
  mean the name is absent.
- A baseline captured before enablement will classify every nonexistent name as
  Changed afterwards. Attribute this to the denial-encoding change rather than
  reporting spurious record deltas.

## CAA

Compute the effective Relevant RRset under RFC 8659:

- follow CNAME processing where applicable
- search the domain tree as required
- distinguish `issue` and `issuewild`
- recognize an empty issuer value as a deny request
- preserve issuer-specific parameters

Before recommending a narrower CAA policy, inventory certificates on all active
hosts and identify every managed certificate provider. A policy that omits a
required issuer can break renewal.

Serve-side inspection alone is not a complete issuer inventory. It shows only
what is presented on the hosts probed, at this moment, and misses issuers used
for hosts outside scope, for backup or failover certificates, and for pending
renewals. Also review Certificate Transparency history for the registrable
domain and its subdomains, and build the proposed issuer set from the union of
CT history and every currently served chain.

Attribute each issuer to the platform that requests it before proposing removal,
and prefer keeping an issuer whose owner cannot be identified. A generic or
recalled CA list is not evidence. Managed platforms change their issuing CA
without notifying the domain owner, so an issuer absent from vendor
documentation may still be the one renewing the live certificate.

`iodef` is optional. Its absence is not a failed control. Some providers
synthesize their own CAA RRset to protect managed issuance, so the published
RRset can contain issuers and parameters the owner did not configure, and may
omit owner-configured tags. Compare the zone-side records with the published
RRset and report the effective published policy as controlling.

## Dangling aliases and takeover

For every CNAME, HTTPS/SVCB alias, NS delegation, and provider-specific custom
domain:

1. Resolve the full target chain.
2. Inspect the application response and provider error signature.
3. Confirm whether the custom hostname is bound to the expected tenant.
4. Check current provider ownership-verification requirements.
5. Attempt no claim or registration.

Classify findings:

- **Critical**: claimability or an unbound provider resource is verified.
- **High**: strong provider-specific evidence indicates likely claimability,
  but safe verification is incomplete.
- **Medium**: target is broken or stale without evidence of takeover.
- **Informational**: unusual aliasing with no demonstrated impact.

An NXDOMAIN target alone is not proof of takeover. A live SaaS target alone is
not proof of ownership.

## Registrar controls

Domain-level controls are the foundation every DNS control rests on. An
attacker who can repoint the delegation does not need to touch the zone, and no
zone-side monitoring will see it.

EPP status codes describe what a registry can enforce, not what a registrar
sells. Before recommending any lock, confirm what the specific registrar
actually exposes for that TLD and account, and at what price:

- Consumer registrars commonly expose one toggle, mapping to
  `clientTransferProhibited` only. `clientDeleteProhibited` and
  `clientUpdateProhibited` are frequently unavailable, bundled into a paid
  protection product, or offered only on some TLDs.
- Registry lock (the `server*Prohibited` statuses) is a separate, usually
  expensive, out-of-band service. It is not a checkbox.
- The observed status set in RDAP tells you what is applied, not what is
  available. Absence may mean unavailable, not unconfigured.

Never present an unavailable control as a quick configuration change. Doing so
misstates the achievable posture and sends the owner looking for a setting that
does not exist. State what the registrar offers, the cost, and the alternative:

- Where the control is paid, give the price and let the owner weigh it against
  the domain's value. Judge proportionality honestly. Registry lock protects
  against registrar-account compromise, and account two-factor authentication
  addresses much of the same path for free.
- Where the owner declines a control, record it as accepted risk with the
  compensating controls, rather than leaving an open finding against something
  they cannot or will not buy.

Renewal is part of this. Expiry causes immediate, total loss of web and mail,
not a grace-period warning, and recovery gets expensive quickly. Confirm both
auto-renewal state and a valid payment method; RDAP shows the expiry date but
proves nothing about billing. Where an owner prefers manual renewal, the
proportionate substitute is an early multi-year renewal plus a monitored
registrant contact, not repeated advice to enable auto-renewal.

## Zone transfer

With authorization, attempt AXFR against every authoritative server using
`dig`, `kdig`, or another client that supports AXFR. Record the exact outcome,
including REFUSED, FORMERR, NOTIMP, timeout, transport failure, or successful
transfer. Preserve the RCODE for diagnosis. Do not assume managed DNS
blocks transfers if the test was not run.

An absence of zone data is not by itself proof of a blocked transfer, because a
malformed or misdirected query returns no zone data either. This matters most
for FORMERR and for hand-built queries, where the server is reporting that it
could not parse the request rather than that it declined to serve it.

Before recording the transfer as blocked, validate the probe as described in
[evidence and record discovery](evidence-and-records.md): issue an ordinary
query such as SOA to the same server over the same client and transport. A
control that succeeds while AXFR returns no zone data demonstrates refusal. A
control that also fails means the tool or path is at fault, so mark the check
Not verified and name the blocker.

A successful public AXFR is high severity by default. Raise it to critical only
when the exposed zone data creates immediate material impact.

## Hygiene

Use complete provider inventory when available to identify:

- obsolete verification records
- stale service records
- forgotten delegated subzones
- conflicting or duplicate data
- overly broad wildcard records
- split-horizon names unintentionally exposed publicly

Do not infer staleness from failed ping. Test the protocol each record is
intended to serve and confirm service ownership before recommending deletion.

### Attributing a record whose owner is unknown

Verification tokens are the common case: an opaque string with no protocol to
probe and no consumer that still advertises it. Platforms routinely stop
returning a validation token once the domain reaches a validated state, so
querying the consuming platform's current state is a dead end by construction,
not evidence of absence.

Read the DNS provider's own record metadata before concluding anything. Most
providers expose a creation and last-modified timestamp per record
(Cloudflare returns `created_on` and `modified_on`). Correlate those against
creation timestamps of resources in the consuming platform. A token created
within minutes of a custom domain, certificate, or tenant binding is almost
certainly that binding's validation record, and the ordering distinguishes
records that predate a resource from records created to satisfy it.

This is cheap, read-only, and frequently decisive. It can attribute a token in a
single call after repository history, resource enumeration, and the platform's
own domain API have all failed. The same timestamps also expose a documented
purpose that cannot be true, such as a token that predates the resource it
supposedly verifies.

Order of attribution evidence:

1. Provider record timestamps correlated with consuming-resource events.
2. Configuration history: infrastructure repositories, change logs, provider
   audit logs.
3. Token format compared against formats the platform is known to issue.
4. Platform support, where the value can be looked up directly.

Only after these record the value as unattributed, and say which were tried.
An unattributed record is kept and monitored, never deleted on suspicion: the
payoff for removal is a few bytes and the failure mode is an outage on whatever
still depends on it. When correlation does identify the owner, write the
evidence down, including the timestamps, so the question is not reopened.
