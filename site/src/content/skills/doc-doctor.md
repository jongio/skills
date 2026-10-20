---
title: doc-doctor
tagline: "Check changed documentation against code and fix material gaps."
useWhen: "doc-doctor, check docs, stale docs, broken links, README accuracy"
repoPath: skills/doc-doctor
thumb: images/thumb-doc-doctor.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill doc-doctor -g --agent github-copilot"
---

## What it does

Check changed documentation against code and fix material gaps.

Checks the current diff and affected docs, including missing updates, local links,
examples, and repository frontmatter rules. Keeps the instructions to ten lines.
`pr` owns this preflight check; `go` delegates it rather than running it twice.

## Use it

```text
/doc-doctor
```
