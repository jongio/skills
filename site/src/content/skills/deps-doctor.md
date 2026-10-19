---
title: deps-doctor
tagline: "Find outdated, vulnerable, unused, and undeclared dependencies; apply updates and fix compatibility problems."
useWhen: "When dependencies are outdated, a CVE needs remediating, a package graph has unused or undeclared entries, a major bump needs a forward compatibility fix, or a supply-chain review is due before adopting a release."
repoPath: skills/deps-doctor
thumb: images/thumb-deps-doctor.png
order: 9
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill deps-doctor -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin marketplace add jongio/skills && copilot plugin install deps-doctor@jongio-skills
---

## What it does

`deps-doctor` reviews dependency files and actual usage, proposes updates, and
checks that the project still works after changes.

- Detects npm, pnpm, Yarn, pip, Pipenv, Poetry, uv, Go modules, Cargo, Bundler,
  Composer, NuGet, Maven, Gradle, Swift Package Manager, pub, and Hex.
- Also covers the surfaces no language package manager owns: Docker base images,
  GitHub Actions versions, Terraform providers and modules, dev container
  features, and pre-commit hook revisions.
- Reports a manager it could not audit as blocked, so a partial audit never
  reads as a clean one.
- Defers to Dependabot or Renovate where one already owns routine bumps, and
  works the scope the bot leaves uncovered.
- Reconciles declared packages against real imports, keeping dependencies that
  are reached only through configuration or runtime loading.
- Reviews changed packages before allowing their install scripts to run.
- Defers releases that are too new under the configured minimum release age.
- Prioritizes vulnerabilities with evidence of exploitation, not severity alone.
- Screens new direct dependencies for typosquatting, install hooks, non-registry
  sources, maintainership, license, and registry provenance.
- Fixes breaking changes forward and resolves peer dependency conflicts by
  version selection, never with a force flag and never by downgrading.
- Checks that a clean install from the updated lockfile works.
- Makes no branch, commit, or pull request when there is nothing to change.

## Use it

```text
/deps-doctor
Update dependencies and fix security patches
Audit outdated and unused packages
Remediate the CVEs in this repo
```

Every git and GitHub write waits for explicit approval, and the concrete change
list is presented first so there is something real to approve.
