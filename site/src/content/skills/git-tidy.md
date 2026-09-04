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

`git-tidy` shows what each branch, worktree, stash, and remote ref contains,
then recommends one clear outcome: remove, keep, resume, update, open a pull
request, or merge. Tags, recovery artifacts, large blobs, and repository
maintenance use typed, bounded inventories in the same read-only analysis.

Normal runs use the familiar Git Clean report with numbered **Safe to Remove**,
**Needs Review**, **Keep**, and **Skipped** sections. Every visible branch,
stash, remote ref, or full worktree path includes a concrete reason. Safe rows
also name the durable copy that remains. The user can select all visible safe
rows or choose specific row numbers without stepping through redundant cards.
Detailed proof remains available through `Show full evidence`.

Under the hood, the analyzer correlates exact object IDs and complete change
units, records preservation witnesses and blockers, and can add bounded content
review. Selecting an outcome never authorizes cleanup.

## Depths

- `metadata` is an explicit compatibility mode that inventories but can't
  establish deletion safety for work-bearing carriers.
- `proof` adds deterministic content and history proof and is the shipped
  default for work-bearing scopes.
- `review` adds opt-in, bounded semantic review that can only make a result more
  conservative.

The analyzer requires Node.js 22 or newer. Without it, the skill remains
metadata-only and offers no destructive work-bearing action.

## Safety

Analysis and revalidation are read-only. Fetch and prune require a separate
approved external workflow and a fresh analysis. Age and names only prioritize
review; they don't prove deletion safety. Pull requests join by immutable
repository identity, exact head ref name, and exact head OID and never act as
durable copies. GitHub branches attach only by exact repository ID, ref name,
and tip OID.

Default-branch identity comes only from a valid local
`refs/remotes/origin/HEAD` target and its exact inventoried remote object. No
`main` or `master` fallback is guessed, and unresolved identity blocks
destructive local branch actions.

Dirty or uncertain worktrees block removal. Remote access failures remain
unknown rather than becoming dead-remote guesses. Large blobs are report-only.
Reflog expiry, garbage collection, and repack can destroy recovery paths and are
never preselected or described as non-destructive housekeeping.

The main worktree is always protected. Worktree evidence includes categorical
status counts, nullable sparse state, and an ignored-path count. Ignored names
and payloads are never retained or read.

Protected GitHub branches block deletion. Remote-only missing content remains
partial and deferred until a separately approved isolated acquisition satisfies
its deterministic prerequisite.

Every refresh, optional read, save, checkout, rebase, merge, push, GitHub write,
and cleanup class gets its own exact approval and fresh revalidation or an
established specialist handoff.

Normal interactive runs always end at the decision dashboard rather than a
prose-only report. Decision cards contain one call, one reason, and one concrete
next action. Dry-run and explicit report-only requests remain non-interactive.
Each accepted result is also preserved under an immutable timestamp plus
`runId` artifact name, so a later run can't replace the evidence behind an
earlier recommendation.

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
