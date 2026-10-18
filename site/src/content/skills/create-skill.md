---
title: create-skill
tagline: "Turn a skill idea into reusable agent instructions, documentation, tests, and a registered catalog entry."
useWhen: "When you want to add a skill to an existing collection and include the files needed to document, test, and distribute it."
repoPath: skills/create-skill
thumb: images/thumb-create-skill.png
order: 3
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill create-skill -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin marketplace add jongio/skills && copilot plugin install create-skill@jongio-skills
---

## What it does

`create-skill` turns a skill idea into a complete, registered repository entry:

- `SKILL.md` instructions that tell the agent when and how to use the skill.
- A README, license, tests, and evaluation cases for checking its behavior.
- Registration in the repository's marketplace, plugin listings, CI, and catalog.
- Optional thumbnail art, or a local placeholder when you do not want generated art.

It checks how your repository distributes skills before making changes. If that
setup is unclear, it stops for clarification rather than guessing where to register.

## Safety

You review proposed changes before they are applied. Paid image generation needs
separate approval; the skill does not retry a billed request or switch providers
without asking.

## Use it

```text
/create-skill release-notes-helper
/create-skill art release-notes-helper
/create-skill check release-notes-helper
```

The first command creates the skill, `art` adds or replaces its thumbnail, and
`check` checks its files and registration.
