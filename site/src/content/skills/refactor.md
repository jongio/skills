---
title: refactor
tagline: "Plan behavior-preserving refactoring with explicit scope, depth and risk choices."
useWhen: "small wins, code cleanup, refactor assessment, local restructuring, cross-module refactoring"
repoPath: skills/refactor
thumb: images/thumb-refactor.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill refactor -g --agent github-copilot"
---

## What it does

Choose small wins, local restructuring, or cross-module restructuring without
changing product behavior. Inspection breadth and risk boundaries are separate
choices; sensitive contracts remain excluded by default at every level.

Start a bounded fresh assessment or resume a cleanup ledger. The skill proposes
one coherent batch, requires preservation evidence, and never escalates on its
own. Approved work hands off to `go` and `pr`; the assessment itself is read-only.

## Use it

```text
/refactor
```

Supply a path and a depth, for example `/refactor src/parser - Level 1`.
Feature removal, bug fixes, changed errors, new defaults and dependency upgrades
are outside this skill at every level.
