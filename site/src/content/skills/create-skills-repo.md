---
title: create-skills-repo
tagline: "Create a repository for publishing agent skills, with installation support, automated checks, and a browsable catalog."
useWhen: "When you want a new repository for publishing agent skills, or need to bring an existing skills repository up to the same marketplace, CI, eval, and catalog standards."
repoPath: skills/create-skills-repo
thumb: images/thumb-create-skills-repo.png
order: 4
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill create-skills-repo
  - label: Install from the plugin marketplace
    cmd: copilot plugin marketplace add jongio/skills && copilot plugin install create-skills-repo@jongio-skills
---

## What it does

`create-skills-repo` scaffolds or upgrades a complete skills marketplace:

- A shared `skills/` collection with installation manifests for GitHub Copilot, Claude Code, Codex, Cursor, and Gemini CLI.
- A working example skill and a bundled `create-skill` workflow for adding your own skills.
- Automated checks, Vally `0.20.0` behavior evaluations, `scripts/version-skills.mjs` release management (`check`, `sync`, `bump`), and Dependabot configuration with 7-day release-age gates.
- A GitHub Pages catalog (composed via `create-gh-pages-site`) where people can browse and install your skills.
- Transactional upgrade support that verifies managed file hashes and preserves files you have customized.

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
