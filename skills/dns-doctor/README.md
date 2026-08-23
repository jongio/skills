# dns-doctor

`dns-doctor` is an evidence-first DNS and domain health skill for AI coding
agents. It audits delegation, public records, DNSSEC, CAA, website routing,
TLS, CDN behavior, email authentication, dangling aliases, TTLs, and zone
hygiene. It can apply an exact provider change after the user explicitly
approves that mutation.

## Why it is different

DNS audit tools often turn incomplete public observations into a confident
grade. `dns-doctor` keeps evidence coverage separate from health and identifies
each conclusion as verified, corroborated, inferred, not verified, or not
applicable.

It also avoids several common diagnostic errors:

- using `ANY` responses as a zone inventory
- treating recursive answers as authoritative configuration
- counting SPF MX address lookups as separate terms
- guessing DKIM selectors and declaring DKIM absent
- treating any SaaS CNAME as a takeover
- calling CDN or origin failures DNS failures
- assigning universal TTL and nameserver-count grades

## Install

```sh
npx skills add jongio/skills --skill dns-doctor -g --agent github-copilot
```

Reload skills or start a new agent session, then invoke `/dns-doctor`.

From the Copilot plugin marketplace:

```sh
copilot plugin marketplace add jongio/skills
copilot plugin install dns-doctor@jongio-skills
```

## Use it

```text
dns-doctor example.com
dns-doctor example.com records
dns-doctor example.com mail
dns-doctor example.com web
dns-doctor example.com security
dns-doctor example.com fix
dns-doctor example.com fresh
dns-doctor example.com no-cache
```

Use `fresh` to ignore the previous baseline while saving the completed scan as
the next baseline. Use `no-cache` when the scan must neither read nor write a
baseline.

The skill produces a coverage summary, evidence-backed findings, and a
dependency-ordered remediation plan. Audits remain read-only. Live changes use
official provider SDKs or APIs only after an exact before-and-after preview and
explicit user approval.

By default, each successful scan stores a sanitized per-domain baseline in the
operating system's user cache. `no-cache` scans and scans whose cache write
fails do not save a baseline. Later scans revalidate current state, highlight
added, changed, and resolved findings, and summarize freshly verified
unchanged controls. Reports end with ordered next steps and ask whether to stop
at the report or work through fixes one at a time. The dependency-free
`scripts/cache.mjs` tool owns cache paths, schema validation, safe bounded
reads, deterministic delta classification, and atomic writes so agents do not
reimplement lifecycle behavior. Running the cache tool requires Node.js 24.
Development commands declared in `package.json` require npm 11.11.1 or newer.

## Evaluate it

The [capability eval](evals/README.md) tests full-audit evidence discipline,
takeover false-positive resistance, Windows query fallbacks, command-injection
handling, DNS rebinding, prompt injection, private-target blocking, and exact
approval boundaries for provider changes. Unit tests exercise cache
persistence, schema validation, safe file handling, concurrent writes, and
delta classification.

```sh
cd skills/dns-doctor
npm ci --ignore-scripts
npm test
npm run test:coverage
npm run eval:lint
npm run eval
```
