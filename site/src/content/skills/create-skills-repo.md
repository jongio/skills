---
title: create-skills-repo
tagline: "Create a repository for publishing agent skills, with installation support, automated checks, and a browsable catalog."
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

- A shared `skills/` collection with installation support for multiple agents.
- A working example and a `create-skill` workflow for adding your own skills.
- Automated checks and behavior evaluations, plus Dependabot configuration.
- A GitHub Pages catalog where people can browse and install your skills.
- Upgrade support that identifies files you have customized.

Before applying changes, it shows a preview. Your own files are preserved, and
customized generated files are flagged for review instead of being overwritten.

## Safety

Creating a GitHub repository or changing its metadata, Pages, or environment
settings requires separate approval.

## Use it

```text
/create-skills-repo
/create-skills-repo create
/create-skills-repo upgrade
/create-skills-repo sync
/create-skills-repo check
```

Use `create` for a new collection, `upgrade` for updated tooling and templates,
`sync` to refresh generated listings, and `check` to inspect without applying changes.
