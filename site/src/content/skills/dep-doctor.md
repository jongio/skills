---
title: "Dep Doctor"
tagline: "Scan every package manager, update everything to latest, fix breaking changes instead of rolling back, and never ship an empty PR."
useWhen: "When you say dep-doctor, update dependencies, upgrade packages, apply security patches, or audit outdated packages."
repoPath: skills/dep-doctor
thumb: images/thumb-dep-doctor.png
order: 6
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill dep-doctor -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin install dep-doctor@jongio-skills
---

## What it does

`dep-doctor` keeps every dependency in a project current across every
package manager it finds — npm/pnpm/yarn, pip, go, cargo, bundler, and
composer — and fixes forward instead of rolling back.

- **Scans** the workspace for every package manager present and detects
  unused and phantom dependencies before touching anything.
- **Updates** each ecosystem to latest, prioritizing security and CVE fixes.
- **Fixes breaking changes** in code to match the new API — dependencies are
  never downgraded to make a test pass.
- **No-Op Gate**: if nothing was actually outdated, the run reports "already
  up to date" instead of manufacturing an empty branch, commit, or PR.

## Use it

```text
/dep-doctor
```

The skill scans, updates, runs tests, fixes anything that breaks, and stops
before any git write action unless there is a real change on disk.

