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

`iodef` is optional. Its absence is not a failed control.

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
