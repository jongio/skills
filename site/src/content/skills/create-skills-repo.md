---
title: create-skills-repo
tagline: "Create or safely upgrade a complete cross-agent skills marketplace repository with manifests, Vally, secure CI, Dependabot, and a GitHub Pages catalog."
useWhen: "When you want a new repository for publishing agent skills, or need to bring an existing skills repository up to the same marketplace, CI, eval, and catalog standards."
repoPath: skills/create-skills-repo
thumb: images/thumb-create-skills-repo.png
order: 4
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill create-skills-repo -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin marketplace add jongio/skills && copilot plugin install create-skills-repo@jongio-skills
---

## What it does

`create-skills-repo` scaffolds or upgrades a complete skills marketplace:

- Canonical `skills/` content wrapped by every supported host manifest.
- A reusable `create-skill` workflow plus a functional `example-skill`.
- Vally tooling, deterministic validation, secure lint and eval workflows, and Dependabot.
- A default-on Astro catalog generated through `create-gh-pages-site`.
- Committed configuration and managed-file hashes for reproducible, conflict-safe upgrades.

Create, sync, and upgrade render into staging first. Unmanaged files are preserved, and
user-modified managed files become explicit conflicts instead of being overwritten.

## Safety

Local files are previewed before application. GitHub repository creation, metadata,
Pages, and environment settings are shown as exact operations and require separate
approval before execution.

## Use it

```text
/create-skills-repo
/create-skills-repo create
/create-skills-repo upgrade
/create-skills-repo sync
/create-skills-repo check
```
