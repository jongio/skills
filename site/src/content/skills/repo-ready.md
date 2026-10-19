---
title: repo-ready
tagline: "Add the license, contribution guide, issue forms, CI, and other setup files your repository is missing."
useWhen: "When you're starting a new repo and need all the standard files, or when you want to audit an existing repo for missing community health files and GitHub settings."
repoPath: skills/repo-ready
thumb: images/thumb-repo-ready.png
order: 5
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill repo-ready -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin install repo-ready@jongio-skills
---

## What it does

`repo-ready` checks your repository's setup and proposes files suited to its
stack. It asks about decisions it cannot infer, such as the license and intended
audience, then generates the agreed files.

- **Stack detection** across ecosystems including Node.js, Python, Go, Rust, .NET,
  Java, Ruby, Docker, and Terraform, using lockfiles and manifests.
- **Guided license selection** with recommendations
  based on your project type and audience.
- **YAML issue forms** (not legacy Markdown templates) with structured fields
  for bug reports and feature requests.
- **Dependabot config** with auto-detected package ecosystems and schedules.
- **CI workflow** tailored to your detected stack and package manager.
- **Repo metadata** audit: description, topics, and homepage URL, applied
  through the GitHub API with your confirmation.

## Two modes

**Init** scaffolds a new repo from scratch. The skill interviews you one
question at a time, skipping anything it can auto-detect, then generates
all files in a single pass.

**Update** scans an existing repo against the full file catalog, produces a
gap analysis table grouped by tier, and interviews you only for what's
missing. It never overwrites existing files without showing a diff first.

## Use it

Describe what you need; the agent routes to the skill:

```text
repo-ready              # init mode: scaffold everything
repo-ready update       # scan for gaps, suggest additions
```
