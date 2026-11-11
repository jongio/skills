---
title: git-tidy
tagline: "Audit Git work, remove proven integrated local branches and worktrees, and verify what remains."
useWhen: "When Git work needs cleanup without risking unique changes or relying on age and names as deletion proof."
repoPath: skills/git-tidy
thumb: images/thumb-git-tidy.png
order: 10
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill git-tidy
  - label: Install from the plugin marketplace
    cmd: copilot plugin marketplace add jongio/skills && copilot plugin install git-tidy@jongio-skills
---

## What It Does

`git-tidy` audits the whole repository and shows the evidence for each proposed
removal. One confirmation covers the listed cleanup plan, including stale origin
tracking refs. A verified recovery bundle preserves any history at risk.
The cleanup removes worktrees
first and then rechecks their branches. It also drops duplicate stashes when a
durable copy holds the same changes.

The audit covers remote refs, tags, ignored tracking, artifacts, large blobs,
and maintenance. The final summary lists removals, retained work, and blockers.
Dirty or unmerged work stays in place. Changing live remote branches requires
an explicit request.

Use `--dry-run` for a preview, `--depth metadata` for inventory, or
`--depth review` for a bounded content review. Proof requires Node.js 22 or
newer.

## Use It

```text
git-tidy
git-tidy branches --depth proof
git-tidy worktrees --depth metadata
git-tidy stashes --depth review
git-tidy tags
git-tidy artifacts
git-tidy blobs
git-tidy maintenance
git-tidy --dry-run
```
