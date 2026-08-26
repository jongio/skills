# Evidence and Record Discovery

## Evidence order

Prefer evidence in this order:

1. Parent-zone delegation for NS, DS, and glue.
2. Direct query to each authoritative nameserver.
3. Read-only provider inventory and settings.
4. Independent validating recursive resolvers.
5. Public discovery sources such as certificate transparency.

Recursive agreement proves current resolver behavior, not zone contents.
Provider inventory proves configuration, not necessarily effective public
behavior. Use both when possible.

Check registrar RDAP data for delegation, expiration, and status locks. Treat
RDAP as registrar evidence, not proof that billing or auto-renew is healthy.

## Required queries

Query each type separately:

```text
NS SOA A AAAA CNAME MX TXT CAA DS DNSKEY HTTPS SVCB SRV TLSA
```

Only query types applicable at each name. `ANY` responses are commonly
minimized or refused and must not be used for inventory.

Useful commands:

```sh
server_address="<validated-authoritative-server-ip>"
dig +noall +answer example.com NS
dig +noall +answer "@${server_address}" example.com SOA
dig +trace example.com NS
dig +dnssec example.com A
```

```powershell
$serverAddress = "<validated-authoritative-server-ip>"
Resolve-DnsName example.com -Type NS
Resolve-DnsName example.com -Type SOA -Server $serverAddress
```

When using DNS over HTTPS, inspect the DNS response code and flags. An HTTP 200
does not mean the DNS lookup succeeded.

Client error text can hide DNS response semantics. Record the wire or DoH RCODE,
answer count, authority section, DNSSEC data, and authenticated-denial records
before mapping a result to NXDOMAIN or NODATA. Some signed providers synthesize
authenticated negative responses that client libraries describe imprecisely.

## Delegation checks

- Parent NS set matches the intended delegation.
- Every delegated nameserver answers authoritatively.
- Authoritative servers agree on SOA serial and material RRsets.
- Required in-bailiwick glue exists and matches authoritative address records.
- No nameserver is lame, timed out, or serving a different zone.
- DS exists only when the child zone is correctly signed.
- Delegation TTLs and negative caching behavior are recorded, not judged
  against one universal value.

SOA serial format is operator-defined. Do not require `YYYYMMDDnn`. Compare
serials across authorities and, during a change, confirm they advance according
to the provider's model.

## Name and record discovery

Start with user-supplied and architecture-derived names. Add names found in MX,
SRV, HTTPS, SVCB, TLSA, redirects, certificates, and provider inventory.
Common-name and certificate-transparency discovery can expand the list, but
neither proves completeness.

For every name:

- distinguish NXDOMAIN, NOERROR with no requested data, SERVFAIL, REFUSED, and
  timeout
- trace each CNAME or provider alias to its terminal answer
- preserve TTL at every chain hop
- record DNSSEC status and response source
- test intended protocols instead of assuming every address is a website

For flattened, proxied, or geosteered names, recursive answers can legitimately
vary by resolver location, cache age, or edge policy. Re-query, record timing
and resolver, compare with effective authoritative behavior, and report
unexplained divergence instead of declaring drift from one sample.

Test wildcard behavior with multiple random labels. One random answer can be a
provider synthesis rule. Compare record type, value, TTL, and HTTP behavior
before classifying a wildcard.

## Protocol correctness

- A CNAME owner cannot have other ordinary record data.
- MX and NS targets must not be aliases.
- Multiple SPF policies at one owner produce SPF permerror.
- TXT character strings must be joined in record order before parsing.
- HTTPS and SVCB alias mode must be traced like other aliases.
- An apex may use provider-specific flattening or synthesized answers. Public
  DNS cannot reveal the hidden configured target, so use provider inventory.

## Origin identity

Two hostnames that return identical responses are not necessarily the same
origin. Identical ETag, content length, digest, status, and headers prove that
the bytes match, which is the expected result whenever content is copied,
replicated, mirrored, or migrated between origins.

Never claim that hostnames share an origin, that one is a duplicate of another,
or that one is redundant, on response equality alone. Establish origin identity
from the controlling binding: the provider's mapping of hostname to bucket,
service, distribution, or application. Enumerate those bindings per hostname.

This matters most immediately before recommending removal. A hostname that looks
redundant may be bound to a distinct backing store holding data nothing else
references, so the correct finding is a separate stale resource rather than a
duplicate alias. Where the binding cannot be read, mark the relationship
Inferred and say which provider object would settle it.

## TTL and resilience

Judge TTLs against change frequency, failover design, negative caching, and
provider control. Do not penalize:

- short TTLs intentionally used by managed edges
- terminal TTLs controlled by a SaaS provider
- two anycast nameservers solely because there are fewer than three names

Assess nameserver independence by provider architecture and network path, not
only IP subnet or geolocation. Anycast servers can share names while remaining
globally redundant.

When resolvers disagree on a provider-owned target, query that target's
authoritative servers and compare RCODEs. Classify unresolved NXDOMAIN,
SERVFAIL, REFUSED, and NOTIMP disagreements as not verified until the
controlling authority explains the result.
