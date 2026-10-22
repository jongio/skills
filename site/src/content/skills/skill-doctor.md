---
title: skill-doctor
tagline: "Learn from session feedback and trim skill bloat with cached audits and one improvement PR."
useWhen: "skill doctor, skill-doctor, improve skills from session feedback, trim skill instructions"
repoPath: skills/skill-doctor
thumb: images/thumb-skill-doctor.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill skill-doctor -g --agent github-copilot"
---

## What it does

Review recent session feedback and independently trim redundant skill instructions.
Skip unchanged sessions and source files, preserve useful rules, and deliver
focused improvements in a dedicated worktree and PR.

## Use it

```text
/skill-doctor
```
