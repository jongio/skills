# Canonical Audit Checklist

Mark each check applicable or not applicable before collecting evidence. For
applicable checks, record one of: Verified, Corroborated, Inferred, or Not
verified.

## Registration and delegation

| ID | Check |
|---|---|
| REG-01 | RDAP registrar, expiration, and status locks |
| DEL-01 | Parent NS delegation and required glue |
| DEL-02 | Every delegated server answers authoritatively |
| DEL-03 | Authorities agree on SOA and material RRsets |
| DEL-04 | No lame, unreachable, or unintended delegation |

## Resolution and records

| ID | Check |
|---|---|
| REC-01 | Two independent recursive resolvers checked |
| REC-02 | RCODE and negative-answer semantics preserved |
| REC-03 | Resolver or geosteering divergence explained |
| ZONE-01 | Complete provider inventory obtained |
| ZONE-02 | CNAME, HTTPS, SVCB, MX, NS, SRV, and TLSA chains valid |
| ZONE-03 | Wildcard behavior tested with multiple random names |
| ZONE-04 | TTLs and negative caching fit operational intent |
| ZONE-05 | SOA and nameserver resilience fit provider architecture |

## Website and TLS

| ID | Check |
|---|---|
| WEB-01 | Canonical host resolves and serves intended content |
| WEB-02 | HTTP, HTTPS, deep-path, and query redirects behave as intended |
| WEB-03 | Certificate chain, SAN, validity, and SNI are valid |
| WEB-04 | CDN or proxy behavior is identified without assuming hidden settings |
| WEB-05 | Origin behavior is checked only when known and authorized |
| WEB-06 | Web-hardening observations are separated from DNS defects |

## Mail

| ID | Check |
|---|---|
| MAIL-01 | Sending and receiving intent is established |
| MAIL-02 | MX targets and priorities are valid |
| MAIL-03 | SPF syntax, recursive terms, void lookups, and intent are valid |
| MAIL-04 | DKIM selectors and key properties are evidence-backed |
| MAIL-05 | DMARC syntax, alignment, reporting, and policy fit real flows |
| MAIL-06 | SMTP STARTTLS and certificates are checked when applicable |
| MAIL-07 | MTA-STS DNS signal and HTTPS policy are valid |
| MAIL-08 | TLS-RPT syntax and destination authorization are valid |
| MAIL-09 | DANE TLSA is valid when deployed |

## Security and hygiene

| ID | Check |
|---|---|
| SEC-01 | DNSSEC parent, child, signatures, and denial validate end to end |
| SEC-02 | Effective CAA policy preserves every required issuer |
| SEC-03 | Alias takeover severity is based on binding or claimability evidence |
| SEC-04 | Authorized AXFR outcome recorded for every authority |
| SEC-05 | Stale, duplicate, wildcard, and split-horizon records assessed |

## Coverage rules

- Exclude not-applicable IDs from the denominator.
- Count only Verified IDs in the verified-coverage numerator.
- Show Corroborated, Inferred, and Not verified counts separately.
- If ZONE-01 is Not verified, never claim complete stale-record or takeover
  coverage.
- If MAIL-01 is Not verified, qualify all SPF, DKIM, and DMARC recommendations.
