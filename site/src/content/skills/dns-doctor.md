---
title: dns-doctor
tagline: "Audit DNS, web routing, TLS, mail authentication, and takeover exposure, then apply exact provider changes only after explicit approval."
useWhen: "When a domain does not resolve, redirects incorrectly, has mail-authentication gaps, needs DNSSEC or CAA review, requires a full health audit, or needs an approved DNS fix."
repoPath: skills/dns-doctor
thumb: images/thumb-dns-doctor.png
order: 7
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill dns-doctor -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin marketplace add jongio/skills && copilot plugin install dns-doctor@jongio-skills
---

## What it does

`dns-doctor` traces a domain from parent delegation through authoritative and
recursive DNS, website routing, TLS, CDN behavior, and mail authentication. It
keeps observed facts separate from inference and shows which checks could not
be verified.

- Checks delegation, glue, SOA agreement, aliases, wildcards, TTL intent, and
  provider inventory.
- Validates DNSSEC, effective CAA policy, and authorized zone-transfer behavior.
- Audits HTTP redirects, canonical content, TLS certificates, and CDN routing.
- Evaluates SPF, DKIM, DMARC, MTA-STS, TLS reporting, and DANE where applicable.
- Requires provider binding or claimability evidence before calling an alias a
  critical takeover.
- Produces dependency-ordered remediation and exact post-change checks.
- Caches a sanitized per-domain baseline and highlights added, changed, and
  resolved findings on later scans through a deterministic, atomic local cache
  engine.
- Ends each report with ordered next steps and asks whether to stop or begin
  approval-gated remediation.
- Applies provider changes through official SDKs or APIs only after showing the
  exact mutation and receiving explicit user approval.

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
