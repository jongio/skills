# Portable Command Recipes

Validate the complete raw target before deriving `$name`, `$domain`, or
`$server`. Reject invalid input rather than extracting a valid-looking
substring.

## Hostname validation and IDNA

Do not reimplement this. The skill ships the same validation the cache engine
enforces, so a second implementation would drift from the one that actually
gates persistence. It applies UTS 46 with STD3 rules, validates the raw value
as one atom before encoding, and returns the A-label:

```powershell
$result = node <skill-directory>/scripts/cache.mjs normalize --domain $RawName |
  ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Invalid hostname" }
$name = $result.domain
```

Pass the raw value through the process argument array. Never interpolate it
into PowerShell or shell source. Use the returned A-label for DNS and
connection operations, and keep the original clean form only for display.

This needs only Node.js 24, which the skill already requires. Windows does not
ship Python, so a Python-based validator would make an audit impossible on a
default Windows host.

## The query must be about the name you think it is

Stub resolvers apply the host's DNS search list to any name that is not fully
qualified. On a domain-joined or corporate-managed machine, a query for
`example.com` can be silently rewritten to `example.com.corp.internal`,
resolved successfully, and returned as a normal `NOERROR` answer. Nothing in
the response is malformed and no error is raised. The result is well-formed,
confident evidence about a completely different zone.

A parent-delegation query rewritten this way returns a clean nameserver set
belonging to the search-suffix domain rather than the target, which is
indistinguishable from a correct answer unless the question section is read.

So:

- Query fully qualified names with a trailing dot (`example.com.`) whenever the
  client accepts one.
- Read back the question section and confirm it matches the intended name
  before using any answer. `nslookup` needs `set debug` to show it; a raw client
  should surface it directly.
- Treat any answer whose question does not match the intended name as void.
  Discard it, do not "correct" it by re-reading the answer section.
- Prefer clients that do not consult the search list at all. Windows
  `Resolve-DnsName` does apply it; passing an absolute name avoids that.

Apply this to every hostname the audit derives, not just the audit target. MX
targets, CNAME targets, and nameserver names are all vulnerable to the same
rewrite.

## Minimum client capability

Some checks cannot be satisfied by every DNS client, and substituting a weaker
source silently breaks the evidence model.

| Requirement | Needs |
|---|---|
| Direct query to an authoritative server | A client that targets a server and can disable recursion |
| DNSSEC chain and denial inspection | Wire flags (`AA`, `AD`, `TC`) plus authority-section records |
| CAA, HTTPS, SVCB, TLSA | A client that can request those types |
| Zone transfer outcome | AXFR support with the wire RCODE preserved |

Public DoH resolvers are recursive. They cannot query a chosen authoritative
server, so they satisfy the recursive evidence tier only. Windows
`Resolve-DnsName` cannot request CAA, HTTPS, SVCB, or TLSA, and does not expose
wire flags or the authority section.

On a host with no capable client, `dig`, `kdig`, `delv`, or `drill` is the
normal answer. Where none can be installed, report the affected checks
(`DEL-02`, `DEL-03`, `SEC-01`, `SEC-04` and any type-specific check) as **Not
verified** and say which capability was missing.

Never present a recursive answer as authoritative evidence, and never infer
`AA` or `AD` from a resolver that did not report it. Conflating the two defeats
the entire evidence ordering.

Capability and correctness are separate questions. A client that *can* make the
query may still fail for reasons that have nothing to do with the target, so
pair this section with the control-query rule in
[evidence and record discovery](evidence-and-records.md) before attributing any
failed probe to the server.

## DNS over HTTPS

On Windows, `Resolve-DnsName` has no enum value for **CAA, HTTPS, SVCB, or
TLSA**, so requesting those types fails on parameter binding rather than
returning a DNS error. Go straight to DoH for them. `DS`, `DNSKEY`, `RRSIG`,
`NSEC`, and `NSEC3` are supported natively and need no fallback.

Use DoH for any other type the local client cannot query. Preserve `Status`,
`AD`, `Answer`, `Authority`, and `Comment`. Apply the same address validation,
proxy bypass, and connection pinning used for every other HTTPS target:

```powershell
$name = "example.com"
$type = "CAA"

function Get-PublicAddresses([string] $hostName) {
  # @( ) is required. A host with exactly one address collapses to a String,
  # and splatting a String passes it one character at a time, so the check
  # would reject a perfectly good single-homed host.
  $addresses = @(
    @(
      Resolve-DnsName $hostName -Type A -Server 1.1.1.1 -DnsOnly -ErrorAction SilentlyContinue
      Resolve-DnsName $hostName -Type AAAA -Server 1.1.1.1 -DnsOnly -ErrorAction SilentlyContinue
    ).IPAddress | Where-Object { $_ }
  )
  # Rejects the entire set when any answer is non-global, which is the rule
  # that stops a safe-looking sibling from being selected.
  node <skill-directory>/scripts/public-address.mjs @addresses | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "$hostName returned no addresses or a non-global address"
  }
  return $addresses
}

$googleAddress = (Get-PublicAddresses "dns.google")[0]
$googlePin = if ($googleAddress.Contains(":")) { "[$googleAddress]" } else { $googleAddress }
$google = curl.exe --silent --show-error --max-time 15 `
  --noproxy "*" --resolve "dns.google:443:$googlePin" `
  "https://dns.google/resolve?name=$name&type=$type&do=1" |
  ConvertFrom-Json

$cloudflareAddress = (Get-PublicAddresses "cloudflare-dns.com")[0]
$cloudflarePin = if ($cloudflareAddress.Contains(":")) { "[$cloudflareAddress]" } else { $cloudflareAddress }
$cloudflare = curl.exe --silent --show-error --max-time 15 `
  --noproxy "*" --resolve "cloudflare-dns.com:443:$cloudflarePin" `
  --header "accept: application/dns-json" `
  "https://cloudflare-dns.com/dns-query?name=$name&type=$type&do=true" |
  ConvertFrom-Json
```

Validate the complete address set before selecting a connection address.
Repeat the pinned request for additional published addresses when the audit
budget permits.

Common RCODE values:

| Status | Meaning |
|---:|---|
| 0 | NOERROR |
| 1 | FORMERR |
| 2 | SERVFAIL |
| 3 | NXDOMAIN |
| 4 | NOTIMP |
| 5 | REFUSED |

An empty `Answer` with status 0 is not NXDOMAIN. Inspect authority and DNSSEC
denial records before calling it NODATA.

## Authoritative queries

```powershell
$domain = $name # The validated A-label from the hostname recipe.
$nameservers = (Resolve-DnsName $domain -Type NS -Server 1.1.1.1 -DnsOnly).NameHost
foreach ($nameserver in $nameservers) {
  # @( ) around the whole expression matters: a single-address nameserver
  # collapses to a String, and splatting a String passes one character per
  # argument.
  $serverAddresses = @(
    @(
      Resolve-DnsName $nameserver -Type A -Server 1.1.1.1 -DnsOnly `
        -ErrorAction SilentlyContinue
      Resolve-DnsName $nameserver -Type AAAA -Server 1.1.1.1 -DnsOnly `
        -ErrorAction SilentlyContinue
    ).IPAddress | Where-Object { $_ }
  )

  if ($serverAddresses.Count -eq 0) {
    throw "No address records returned for authoritative server"
  }

  node <skill-directory>/scripts/public-address.mjs @serverAddresses | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Authoritative server returned a non-public-unicast address"
  }

  foreach ($serverAddress in $serverAddresses) {
    Resolve-DnsName $domain -Type SOA -Server $serverAddress -DnsOnly
    Resolve-DnsName $domain -Type A -Server $serverAddress -DnsOnly
  }
}
```

For unsupported types, discover the target zone's authoritative server and use
a DNS client that can direct the query to that server. Public DoH is recursive
and cannot replace a direct authoritative query. Use the shipped
`scripts/public-address.mjs` for the address boundary rather than a hand-written
check. Do not replace the executable check with a comment or an
incomplete private-range list. It parses addresses canonically so IPv4-mapped IPv6,
NAT64 translation prefixes, deprecated 6to4 and Teredo transition ranges,
multicast, IPv6 site-local space, and other alternate forms cannot bypass
classification.

## AXFR on Windows

If `dig` or `kdig` is unavailable, Windows `nslookup` supports an interactive
zone-list command:

```powershell
$domain = $name # The validated A-label from the hostname recipe.
$server = $serverAddress # A previously validated, globally routable IP literal.
@(
  "server $server"
  "ls -d $domain"
  "exit"
) | nslookup.exe
```

Capture output and exit status. Windows may summarize FORMERR or NOTIMP as a
generic refusal, so corroborate material results with a client that exposes the
wire RCODE when available.

`nslookup` applies the system search list, so pass the zone fully qualified and
confirm the question it actually asked before trusting the outcome. See "The
query must be about the name you think it is". A transfer that appears refused
may have been attempted against a suffixed name that is not the target zone.

## HTTP and TLS

Resolve and validate all A and AAAA answers first. Reject the hostname if any
answer is not globally routable. Pin one validated address for each connection
so DNS cannot change between validation and use:

```powershell
$address = "<validated-public-ip>"

curl.exe --silent --show-error --head --max-time 15 --max-redirs 0 `
  --noproxy "*" --resolve "${name}:443:${address}" `
  "https://$name/dns-doctor/probe?source=audit"

curl.exe --silent --show-error --verbose --max-time 15 `
  --noproxy "*" --resolve "${name}:443:${address}" `
  --max-filesize 65536 --range 0-65535 `
  --output NUL "https://$name/"
```

Record the resolved address, certificate name, issuer, validity, negotiated
protocol, status, and redirect target. Do not use automatic redirect following.
For each `Location`, validate the URL and scheme, resolve and reject unsafe
addresses, then create a new pinned request for that hop. Stop after 10 hops.
