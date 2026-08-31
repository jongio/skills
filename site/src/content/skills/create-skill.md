---
title: create-skill
tagline: "Create and register a complete portable agent skill with tests, Vally evals, catalog metadata, and optional validated thumbnail art."
useWhen: "When you want to add a production-ready skill to a managed skills marketplace repository or an existing skills collection without missing registration, tests, evals, or catalog assets."
repoPath: skills/create-skill
thumb: images/thumb-create-skill.png
order: 8
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill create-skill -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin marketplace add jongio/skills && copilot plugin install create-skill@jongio-skills
---

## What it does

`create-skill` turns a skill idea into a complete, registered repository entry:

- Portable `SKILL.md` instructions with focused routing metadata.
- Human documentation, license, deterministic tests, and Vally capability evals.
- Registration across every marketplace, plugin, CI, Dependabot, and catalog surface the repository uses.
- Optional 1024 by 1024 thumbnail art from Azure OpenAI, OpenAI, a custom provider workflow you describe, or a deterministic local placeholder.

Managed repositories use their configuration and sync contract. Existing repositories
are discovered first, and creation stops before writes when registration surfaces are
ambiguous.

## Safety

Every mutation is previewed first. Billed image generation and custom provider actions
require single-use approval, never retry or change providers automatically, and must
produce a fully validated PNG before either thumbnail copy is written.

## Use it

```text
/create-skill release-notes-helper
/create-skill art release-notes-helper
/create-skill check release-notes-helper
```
