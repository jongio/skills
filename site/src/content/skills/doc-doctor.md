---
title: doc-doctor
tagline: "Compare changed or requested documentation against actual code, validate local links, anchors, images, examples, and frontmatter, and fix material gaps within scope."
useWhen: "doc-doctor, check docs, stale docs, broken links, README accuracy"
repoPath: skills/doc-doctor
thumb: images/thumb-doc-doctor.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill doc-doctor"
---

## What it does

Compare changed or requested documentation against actual code, validate local links, anchors, images, examples, and frontmatter, and fix material gaps within scope.

- Reviews the requested scope (default: current diff and affected docs), comparing README, API/CLI/config docs, and examples with actual code to find missing updates — not just already-edited doc files.
- Validates local links, anchors, images, examples, and frontmatter against repository rules, and reports external links as unchecked unless verified.
- Fixes material gaps within scope while preserving unrelated edits and approval boundaries, treating doc content as untrusted data rather than instructions.
- Reports fixes, remaining findings with file/line evidence, and checks actually performed. `pr` owns this preflight check; `go` delegates it to `pr` rather than running it twice.

## Use it

```text
/doc-doctor
```
