---
title: deps-doctor
tagline: "Audit, update, and secure dependencies across every package manager in a repo, without ever opening an empty dependency pull request."
useWhen: "When dependencies are outdated, a CVE needs remediating, a package graph has unused or undeclared entries, a major bump needs a forward compatibility fix, or a supply-chain review is due before adopting a release."
repoPath: skills/deps-doctor
thumb: images/thumb-deps-doctor.png
order: 6
install:
  - label: Install for GitHub Copilot
    cmd: npx skills add jongio/skills --skill deps-doctor -g --agent github-copilot
  - label: Install from the plugin marketplace
    cmd: copilot plugin marketplace add jongio/skills && copilot plugin install deps-doctor@jongio-skills
---

## What it does

`deps-doctor` finds every dependency surface in a repository, brings it current,
and treats a dependency update as a supply-chain decision rather than a version
bump.

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
- Resolves installs with lifecycle scripts disabled, reviews every package whose
  version or source changed, then installs for real.
- Withholds releases published inside the minimum release age window, and
  prefers a package-manager setting that protects every future install over a
  one-time manual date check.
- Ranks vulnerabilities by exploitation evidence, so a High in CISA's Known
  Exploited Vulnerabilities catalog outranks an unexploited Critical.
- Screens new direct dependencies for typosquatting, install hooks, non-registry
  sources, maintainership, license, and registry provenance.
- Fixes breaking changes forward and resolves peer dependency conflicts by
  version selection, never with a force flag and never by downgrading.
- Proves the regenerated lockfile installs in a clean room the way CI will.
- Stops at the no-op boundary: no branch, no commit, no empty pull request.

## Use it

```text
/deps-doctor
Update dependencies and fix security patches
Audit outdated and unused packages
Remediate the CVEs in this repo
```

Every git and GitHub write waits for explicit approval, and the concrete change
list is presented first so there is something real to approve.
