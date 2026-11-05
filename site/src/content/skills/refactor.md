---
title: refactor
tagline: "Plan behavior-preserving refactoring with explicit scope, depth and risk choices."
useWhen: "small wins, code cleanup, refactor assessment, local restructuring, cross-module refactoring"
repoPath: skills/refactor
thumb: images/thumb-refactor.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill refactor"
---

## What it does

Choose small wins, local restructuring, or cross-module restructuring without
changing product behavior. Inspection breadth and risk boundaries are separate
choices; sensitive contracts remain excluded by default at every level.

| Level | What it proposes | Evidence and approval |
| --- | --- | --- |
| **1. Small wins (default)** | Local mechanical cleanup | Approve a coherent batch with independent equivalence checks |
| **2. Local restructuring** | Reorganize internals within one module | Approve the transformation and module; characterize behavior and check callers |
| **3. Cross-module restructuring** | Reorganize internal boundaries across a named subsystem | Approve the design, compatibility evidence, staged plan, and rollback |

Start a bounded fresh assessment or resume a cleanup ledger. The skill proposes
one coherent batch, requires preservation evidence, and never escalates on its
own. Approved work hands off to `go` and `pr`; the assessment itself is read-only.

## Use it

```text
/refactor
/refactor src/parser - Level 1, exclude sensitive contracts
/refactor src/reporting - Level 2, propose only
```

Feature removal, bug fixes, changed errors, new defaults, and dependency upgrades
are outside this skill at every level.
