---
title: naming-is-hard
tagline: "Explore project and product names, refine your favorites, and check domains, packages, and existing uses."
useWhen: "When you need to name a project, product, CLI tool, company, or package — or want to check whether a name is available across domains, GitHub, npm, and other channels."
repoPath: skills/naming-is-hard
thumb: images/thumb-naming-is-hard.png
order: 6
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill naming-is-hard -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin install naming-is-hard@jongio-skills
---

## What it does

`naming-is-hard` is an interactive naming assistant that walks you from a blank page
to a shortlist with availability checks. It combines creative suggestions with
research into where each name is already in use.

1. **Profiles the thing.** Reads your context (a description, a repo path, or a URL)
   and writes a Naming Brief: what it is, who it's for, the tone, the constraints.
2. **Generates a deck.** Produces a diverse, on-brief pool of candidate names across
   many naming strategies (compound, coined, metaphor, suffix play, and more).
3. **Learns your preferences.** You react to one card at a time (Like / Pass /
   Super-like). Later suggestions reflect your choices while keeping a mix of styles.
4. **Checks real availability.** For your finalists it scans domains (DNS
   and registration checks), GitHub, package registries, and social handles, then
   searches for trademark and existing-business conflicts.
5. **Gives a verdict.** Every finalist rolls up to one of three tiers:
   - 🚫 **Deal Breaker**: a famous trademark or company owns it. Walk away.
   - 💛 **It's Complicated**: a key channel is taken or a potential conflict needs review.
   - 💚 **Perfect Match**: no conflict was found in the checked sources, and the requested channels appear available.

Availability can change. These checks are a shortlist aid, not trademark clearance
or a guarantee that a name is safe to use.

## Use it

Just describe what you need:

- "Help me name my new task runner."
- "Come up with names for a calm, privacy-first note app, then check what's free."
- "Is `Brightloom` taken? Domains, GitHub, npm, socials, trademark."

The skill drives the conversation from there: brief, candidate cards, then your
matches with full availability scorecards and verdict tiers.
