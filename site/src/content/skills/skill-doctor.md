---
title: skill-doctor
tagline: "Learn from session feedback and trim skill bloat with cached audits and one improvement PR."
useWhen: "skill doctor, skill-doctor, improve skills from session feedback, trim skill instructions"
repoPath: skills/skill-doctor
thumb: images/thumb-skill-doctor.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill skill-doctor"
---

## What it does

Review recent session feedback across repositories (default: personal sessions active in the last **7 days**) and independently audit every target skill for instruction bloat.

- **Diagnoses real friction:** connects user corrections, retries, failed tool results, and abandoned approaches to actually invoked target skills and their canonical source instructions.
- **Trims instruction bloat:** deletes duplicate rules, filler, repeated explanations, and redundant examples while preserving safety rules, decision branches, exceptions, and useful examples — reporting real word and nonblank-line reductions without code-golf or moving bloat to references.
- **Skips unchanged work:** persists session revisions and skill-source hashes outside Git so unchanged sessions and skills are skipped while pending fixes resume across runs.
- **Delivers in a dedicated worktree:** applies minimal verified edits in an isolated branch/worktree of the canonical skill-source repository and opens one improvement PR through `pr` (stopping before merge; no justified changes means no worktree or PR).

## Use it

```text
/skill-doctor
/skill-doctor last 14 days, target E:\code\skills
/skill-doctor from October 1 through October 7, 2026, UTC
```
