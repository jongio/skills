---
title: repo-ready
tagline: "Scaffold and maintain the standard community health files every GitHub repository needs: .gitignore, .gitattributes, LICENSE, CONTRIBUTING, issue templates, CI workflows, dependabot, editorconfig, and repo metadata."
useWhen: "When you're starting a new repo and need all the standard files, or when you want to audit an existing repo for missing community health files and GitHub settings."
repoPath: skills/repo-ready
thumb: images/item-thumb.svg
order: 3
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill repo-ready -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin install repo-ready@jongio-skills
---

## What it does

`repo-ready` makes sure your repo has every file GitHub expects for a
well-maintained project. It detects your stack, interviews you once for the
decisions that matter (license, audience, contacts), and generates everything
in one pass.

- **Stack detection** for 15+ ecosystems (Node.js, Python, Go, Rust, .NET,
  Java, Ruby, Docker, Terraform, and more) from lockfiles and manifests.
- **Guided license selection** from 12+ SPDX licenses with recommendations
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
