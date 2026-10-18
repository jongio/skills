---
title: git-tidy
tagline: "Review Git work by content, then safely decide what to remove, keep, resume, update, or merge."
useWhen: "When Git work needs cleanup without risking unique changes or relying on age and names as deletion proof."
repoPath: skills/git-tidy
thumb: images/thumb-git-tidy.png
order: 10
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill git-tidy -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin marketplace add jongio/skills && copilot plugin install git-tidy@jongio-skills
---

## What It Does

`git-tidy` inspects branches, worktrees, stashes, and remote references so you can
decide what to remove, keep, resume, update, or turn into a pull request.

The report groups items into **Safe to Remove**, **Needs Review**, **Keep**, and
**Skipped**. Each item has a reason; removal recommendations also identify the
copy of your work that will remain. Choose numbered items and open
`Show full evidence` when you want the supporting details.

## Before cleanup

Analysis does not delete anything. You review exact actions before they run, and
the skill checks again that the evidence still holds.

- Unique changes, dirty worktrees, and uncertain results block removal.
- Old names or old dates are not enough to prove work is safe to delete.
- The main worktree and protected GitHub branches are protected.
- Missing remote access is reported as unknown, not treated as proof a remote is gone.
- Large files are reported, not deleted. Recovery-destroying maintenance is never preselected.

The analyzer requires Node.js 22 or newer. Without it, the skill can list items
but does not offer destructive cleanup of items that may contain work.

## Choose the level of detail

The default `proof` mode checks content and history before recommending removal.
Use `metadata` for an inventory only, or `review` for additional content review.
When the default branch cannot be verified from local remote references,
destructive local-branch actions are blocked rather than assuming `main` or `master`.

Remote refreshes and changes such as checkout, rebase, merge, push, or cleanup
require their own approval. Use `--dry-run` when you only want a report.

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
