---
title: hol-guard
tagline: "Protect supported local AI coding harnesses with HOL Guard before mutation-bearing tool work, with fail-closed runtime checks, approvals, receipts, and evidence."
useWhen: "When you want HOL Guard to protect a supported local coding agent before state-changing tool work, inspect Guard approvals or receipts, or verify that runtime protection is active."
repoPath: skills/hol-guard
thumb: images/thumb-hol-guard.png
order: 8
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill hol-guard -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin marketplace add jongio/skills && copilot plugin install hol-guard@jongio-skills
---

## What it does

`hol-guard` installs and operates the real HOL Guard runtime around supported
local AI coding harnesses before mutation-bearing tool work.

- Detects the exact supported harness with `hol-guard detect --json`.
- Uses Guard-owned bootstrap and install flows instead of editing harness policy
  files by hand.
- Requires a protected dry run plus `doctor` and `status` evidence before
  protection is claimed.
- Stops on deny, review-required, unavailable, or unhealthy Guard states instead
  of suggesting an unprotected fallback.
- Keeps the coding harness's own authentication, permissions, confirmations,
  sandboxing, and provider controls authoritative.
- Keeps Guard Cloud optional; local protection does not require Cloud enrollment.

## Use it

Install the skill for the agent you use, then ask it to protect a supported
local coding harness with HOL Guard. The skill follows the maintained Guard
runtime path and surfaces approvals, receipts, and health evidence when needed.

```text
npx skills add jongio/skills --skill hol-guard
```

The HOL Guard runtime itself remains a separate maintained package; the skill
does not silently bundle or replace it.
