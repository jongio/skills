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

## Zone transfer

With authorization, attempt AXFR against every authoritative server using
`dig`, `kdig`, or another client that supports AXFR. Record the exact outcome,
including REFUSED, FORMERR, NOTIMP, timeout, transport failure, or successful
transfer. Any result that returns no zone data is a blocked or unsupported
transfer, but preserve the RCODE for diagnosis. Do not assume managed DNS
blocks transfers if the test was not run.

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
