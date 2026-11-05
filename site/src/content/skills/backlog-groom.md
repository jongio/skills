---
title: backlog-groom
tagline: "Groom GitHub backlogs across issue and source repositories, with or without Projects, using scoped evidence and approved changes."
useWhen: "backlog-groom, groom backlog, triage GitHub issues, reconcile backlog, organize GitHub Project, audit delivery readiness"
repoPath: skills/backlog-groom
thumb: images/thumb-backlog-groom.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill backlog-groom"
---

## What it does

Groom GitHub backlogs across one or many issue and source repositories, with or without a GitHub Project, using scoped evidence and approved changes.

- **Interviews for scope:** establishes authoritative issue and code repositories, branches/tags, subdirectories, many-to-many mappings, and Project/policy boundaries without assuming the current checkout or `main`.
- **Builds an evidence ledger:** separates implementation, executed tests, installed-host qualification, live evaluation, and release approval before proposing state or completion changes.
- **Organizes with or without a Project:** reconciles hierarchy, dependencies, priorities, milestones, and shared Project fields while preserving existing assignees, dates, view identities, and unrelated metadata.
- **Reports every disposition:** summarizes changed (or proposed), preserved, unresolved, deferred, and UI-blocked items with fully qualified `owner/repo#number` references and evidence.

## Modes

| Mode | Behavior |
| --- | --- |
| `/backlog-groom [audit]` | Read-only default: interview, inspect, build the evidence ledger, and propose changes without checkpoint writes or mutations. |
| `/backlog-groom apply` | Preview exact before/desired values and preconditions, obtain explicit approval, reconcile, and verify postconditions. |
| `/backlog-groom unattended --policy <path>` | Validate an explicitly approved bounded operator policy outside the repository, plan each issue, and apply only in-policy effects. |

## Use it

```text
/backlog-groom
/backlog-groom apply
/backlog-groom unattended --policy C:\private\backlog-policy.json
```
