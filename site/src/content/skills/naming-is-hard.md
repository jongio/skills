---
title: naming-is-hard
tagline: "Interactive naming assistant for projects, CLIs, and products — generates diverse candidate names, learns your preferences, validates availability across domains, GitHub, package registries, and social handles, and screens for trademark and existing-business collisions."
useWhen: "When you need to name a project, product, CLI tool, company, or package — or want to check whether a name is available across domains, GitHub, npm, and other channels."
repoPath: skills/naming-is-hard
thumb: images/thumb-naming-is-hard.png
order: 4
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill naming-is-hard -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin install naming-is-hard@jongio-skills
---

## What it does

`naming-is-hard` is an interactive naming assistant that walks you from a blank page
to a validated, available name. It combines creative generation with real-world
validation so you don't fall in love with a name you can't use.

1. **Profiles the thing.** Reads your context (a description, a repo path, or a URL)
   and writes a Naming Brief: what it is, who it's for, the tone, the constraints.
2. **Generates a deck.** Produces a diverse, on-brief pool of candidate names across
   many naming strategies (compound, coined, metaphor, suffix play, and more).
3. **Learns your preferences.** You react to one card at a time (Like / Pass /
   Super-like). A transparent preference model learns your type and surfaces more of
   what you like, with enough variety that it never tunnels. It can tell you your
   type in words.
4. **Checks real availability.** For your finalists it scans domains (DNS
   NS-delegation, confirmed by RDAP), GitHub, npm / PyPI / crates.io / RubyGems /
   NuGet, and social handles, then screens for trademark and existing-business
   collisions using a bundled famous-marks list plus live searches.
5. **Gives a verdict.** Every finalist rolls up to one of three tiers:
   - 🚫 **Deal Breaker**: a famous trademark or company owns it. Walk away.
   - 💛 **It's Complicated**: no legal blocker, but a key channel is taken. Usable with a compromise.
   - 💚 **Perfect Match**: trademark-clear and the channels that matter are free. Grab it.

## Use it

Just describe what you need:

- "Help me name my new task runner."
- "Come up with names for a calm, privacy-first note app, then check what's free."
- "Is `Brightloom` taken? Domains, GitHub, npm, socials, trademark."

The skill drives the conversation from there: brief, candidate cards, then your
matches with full availability scorecards and verdict tiers.
