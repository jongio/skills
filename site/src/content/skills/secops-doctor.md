---
title: secops-doctor
tagline: "Audit repository and application security across OWASP/STRIDE, secrets, workflows, containers, and Cloudflare with Public Repo Stealth Mode."
useWhen: "secops doctor, secops-doctor, security audit, OWASP STRIDE check, stealth security fixes, container and Cloudflare security audit"
repoPath: skills/secops-doctor
thumb: images/thumb-secops-doctor.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill secops-doctor"
---

## What it does

Audit repository and application security across OWASP/STRIDE, secrets, workflows, containers, and Cloudflare with **Public Repo Stealth Mode** enforced automatically whenever a repository is public.

- **Public Repo Stealth Mode (default when `visibility == "PUBLIC"`):** checks `gh repo view --json visibility,isPrivate` before any output or commit; strips `CWE-*`, `CVE-*`, `GHSA-*`, CVSS scores, exploit payloads, and vulnerability jargon from public commits, branches, PRs, and issues; writes technical details only to untracked private reports and uses neutral hardening framing (`fix(validation): normalize path inputs...`).
- **OWASP Top 10 & STRIDE threat modeling:** audits authentication/session boundaries, webhook HMAC verification, SQL/command injection, SSRF (`169.254.169.254` / RFC 1918), path traversal and symlink escapes, prototype pollution, XSS, and tracked secrets/PII.
- **GitHub Actions & supply-chain security:** detects `pull_request_target` untrusted fork checkouts, `${{ github.event.* }}` script injection in `run:` blocks, unpinned third-party actions, and over-broad `GITHUB_TOKEN` permissions.
- **Cloudflare Workers/Pages & container hardening:** checks `wrangler.toml` / `wrangler.jsonc` plaintext `vars` vs. encrypted secrets, CORS wildcard + credentials misconfigurations, CSP/HSTS/nosniff headers, Turnstile/rate limits, and `Dockerfile` non-root `USER`, pinned base digests, and secret-free build layers.
- **Surgical remediation & regression tests:** applies minimal behavior-preserving fixes backed by deterministic boundary tests without exposing exploit terminology in public test names.

## Use it

```text
/secops-doctor
/secops-doctor audit
/secops-doctor fix
```
