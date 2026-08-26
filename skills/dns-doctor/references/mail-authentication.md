# Mail Authentication

First determine whether the domain sends mail, receives mail, does both, or is
intentionally non-mailing. Recommendations depend on that intent.

## SPF

Join split TXT strings and select records beginning exactly with `v=spf1`.
Check syntax, ordering, recursion, loops, and terminal behavior.

RFC 7208 limits the total number of DNS-querying terms to 10 across recursive
evaluation. The counted terms are `include`, `a`, `mx`, `ptr`, `exists`, and
`redirect`. Count each evaluated term once. Do not count one extra term for
every MX host.

Also check the independent limits:

- each `mx` mechanism may query at most 10 address records
- `ptr` has its own address-query limit and should not be used
- implementations should limit void lookups to two
- recursive include and redirect failures can produce permerror or temperror

Do not recommend static SPF flattening by default. Vendor address ranges
change. Prefer removing unused senders, reducing include depth, splitting mail
streams by subdomain, or using a provider-supported dynamic solution.

Treat `-all`, `~all`, and DMARC policy in context. `~all` can be intentional
during migration. A domain that never sends mail should normally publish a
deny-all SPF policy and a rejecting DMARC policy.

## DKIM

Selector guessing can find keys but cannot prove that DKIM is absent. Prefer:

1. selectors from recent message `DKIM-Signature` and
   `Authentication-Results` headers
2. read-only mail-provider configuration
3. documented provider defaults
4. a bounded common-selector probe labeled incomplete

For each selector:

- resolve CNAME chains and retrieve the terminal TXT record
- join TXT strings and parse tag-value syntax
- confirm `p=` is present and decodes
- parse the key algorithm and actual public key
- verify the selector is currently used when message evidence exists

For RSA, report modulus size from the decoded key. Do not estimate it from TXT
length. RSA 2048-bit keys are the normal target when the provider supports
them. Report RSA 1024-bit keys as legacy risk, not automatic proof that mail is
forgeable. Recognize Ed25519 keys where supported.

Do not invent provider rotation waiting periods. Use the provider's current
status and documented schedule, then verify each selector independently after
rotation.

### Publishing selector records

Selector discovery is inference. Publishing a selector record is a change, and
its target must be copied verbatim from the provider's own output: the mail
console, its API, or the exact value quoted in its activation error.

Never derive a selector target from an MX hostname token, a tenant or account
name, an organizational domain, or a documented legacy pattern. Providers
migrate validation endpoints and keep older documentation reachable, so a
pattern that matches one tenant can be wrong for another on the same platform.

If the provider value is not yet available, say so and stop. Publishing a
plausible guess is worse than publishing nothing: the provider's validator
queries the name, caches the wrong answer for the record's TTL, and blocks
retries until that cache expires. Publish selector records at a low TTL until
the provider confirms signing, then raise it.

### Verifying that signing is live

DNS evidence proves that a key is published, not that messages are signed.
Many providers publish selector keys at their endpoint before the tenant
enables signing, so a resolvable key is not proof.

Confirm signing from message evidence, in this order:

1. DMARC aggregate reports, when a `rua` destination is already collecting
2. `Authentication-Results` headers on a message delivered to a mailbox the
   user controls
3. read-only provider status

Do not direct the user to send mail to a third-party authentication verifier.
Those submissions disclose internal mail hostnames, hop addresses, tenant
identifiers, and message identifiers to an operator outside the user's trust
boundary, and abandoned verifier domains can outlive the service that ran them.
The options above answer the same question without disclosure.

## DMARC

Query `_dmarc.<from-domain>`, applying organizational-domain discovery when
needed. Validate:

- one syntactically valid DMARC policy record
- policy and subdomain-policy intent
- `pct` rollout scope
- aggregate report destinations
- external report-destination authorization
- alignment against real senders

Relaxed alignment is the standards default and is not inherently weak. Strict
alignment is appropriate only when the organization's mail architecture can
support it.

Treat `p=none`, `quarantine`, and `reject` as deployment states, not points.
Recommend enforcement only after aggregate reports show that legitimate flows
align. Failure reports can contain sensitive message data and are not required
for a sound deployment.

## Transport policy

When the domain receives mail, check:

- MX reachability and priority
- STARTTLS and certificate behavior where authorized
- `_mta-sts` TXT policy ID and the HTTPS policy file
- `_smtp._tls` TLS-RPT record and report destination authorization
- TLSA records for DANE SMTP when DNSSEC is deployed

MTA-STS requires both DNS signaling and a valid policy fetched over HTTPS.
DNS alone cannot prove it works.

For SMTP probes, resolve and validate the MX target through a trusted resolver,
then connect to the validated public IP while using the MX hostname for SNI and
certificate validation. Do not let the SMTP client resolve the hostname again.
