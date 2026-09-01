---
title: git-tidy
tagline: "Comprehensive git repo hygiene in one pass: branches, worktrees, stashes, tags, remotes, artifacts, and history bloat, each rated safe, review, or keep, with nothing deleted without approval."
useWhen: "When merged branches pile up, worktrees and stashes go stale, tags or remotes are dead, merge artifacts linger, the repo has grown large, or you want a confidence-rated cleanup audit before deleting anything."
repoPath: skills/git-tidy
thumb: images/thumb-git-tidy.png
order: 10
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill git-tidy -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin marketplace add jongio/skills && copilot plugin install git-tidy@jongio-skills
---

## What it does

`git-tidy` scans a repository for everything that accumulates over time and
rates each finding by how safe it is to remove.

- Local and remote branches, classified by merge and PR status plus age.
- Worktrees, including orphaned entries and ones with unsaved work.
- Stashes, tags, and remotes, aged and cross-checked against GitHub.
- Merge and rebase artifacts (`.orig` files, interrupted operations).
- Ignored-but-tracked files that slipped in before the ignore rule.
- Large history blobs and overall git maintenance health.

Findings are grouped 🟢 safe, 🟡 review, and 🔴 keep, so the cleanup list is
obvious at a glance.

## Safety

Analysis is read-only. Cleanup runs only after you choose the items and confirm
the exact commands. The skill prefers safe branch deletion over force deletion,
warns before every remote deletion, keeps the default, checked-out, and
protected branches off the list, and never rewrites history. Large-blob findings
are report-only: it points you at Git LFS or `git filter-repo` rather than
running them.

## Use it

```text
git-tidy
git-tidy branches
git-tidy worktrees
git-tidy stashes
git-tidy tags
git-tidy maintenance
git-tidy --dry-run
```

Use `--dry-run` to get the full audit without the approval and cleanup phase.
