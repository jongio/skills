# Dep Doctor

Multi-package-manager dependency updates for any project — no rollbacks, fix
forward.

## What it does

**Dep Doctor** scans every package manager in your workspace
(npm/pnpm/yarn, pip, go, cargo, bundler, composer, NuGet, Maven/Gradle,
Swift, Dart/Flutter, Elixir, Docker base images, GitHub Actions, Terraform,
and dev containers), checks for outdated and vulnerable packages, updates
them all to their latest versions, and fixes any breaking changes in your
code rather than reverting the dependency.

- **Detects unused and phantom dependencies** before updating.
- **Minimum release age cooldown**: holds back versions published within the
  last 4 days (configurable) so newly-published malicious or compromised
  releases get caught before you adopt them — the same defense Dependabot and
  Renovate now build in by default. CVE fixes override the cooldown.
- **No rollbacks**: if an update breaks something, the code gets fixed to
  match the new API — the dependency never gets downgraded.
- **Reproducibility-checked**: runs `npm ci`/`--frozen-lockfile`/`--immutable`
  before testing to prove the regenerated lockfile installs clean the same
  way CI will, and flags peer-dependency conflicts instead of masking them
  with `--force`.
- **No-Op Gate**: if nothing was actually outdated, the run ends with a
  report, not an empty branch, commit, or PR.
- **Security-first**: prioritizes CVE and vulnerability remediation with
  `osv-scanner` (catches known-malicious packages, not just CVEs) plus
  per-ecosystem native audit tools, and screens for supply-chain risks
  (typosquatting, new install scripts, missing npm/PyPI provenance, unpinned
  GitHub Actions, unpinned Docker digests, container image OS-package CVEs
  via Trivy/Grype, stale SBOMs, runtime EOL, license drift, abandoned
  packages).
- **Coexists with Dependabot/Renovate**: checks for an existing bot config
  before running, so it complements rather than duplicates automated PRs.
- **Monorepo-aware**: flags cross-package version mismatches with
  `syncpack` in addition to updating each workspace.

## Install

### As a Copilot skill (recommended)

```sh
# Install just this skill (global, for GitHub Copilot):
npx skills add jongio/skills --skill dep-doctor -g --agent github-copilot

# Into the current project instead (drop -g):
npx skills add jongio/skills --skill dep-doctor

# Or install every skill in the repo:
npx skills add jongio/skills --all
```

### Manual

Copy the `skills/dep-doctor/` directory into your project's `.github/skills/`
or reference it in your Copilot instructions.

## Usage

In any Copilot-enabled agent (GitHub Copilot, Claude Code, Cursor, etc.):

```
dep-doctor          # Scan, update, fix, and report on all dependencies
```

## Supported package managers

| File | Package Manager |
|------|-----------------|
| `package-lock.json` | npm |
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` | yarn |
| `requirements.txt` | pip |
| `Pipfile` | pipenv |
| `pyproject.toml` | poetry / uv |
| `go.mod` | go |
| `Cargo.toml` | cargo |
| `Gemfile` | bundler |
| `composer.json` | composer |
| `*.csproj`, `*.fsproj`, `packages.config` | NuGet (.NET) |
| `pom.xml` | Maven (Java) |
| `build.gradle`, `build.gradle.kts` | Gradle (Java/Kotlin) |
| `Package.swift` | Swift Package Manager |
| `pubspec.yaml` | Dart / Flutter (pub) |
| `mix.exs` | Elixir (Hex) |
| `Dockerfile`, `docker-compose.yml` | Docker base images |
| `.github/workflows/*.yml` | GitHub Actions |
| `*.tf` | Terraform |
| `.devcontainer/devcontainer.json` | Dev Container features/images |

## Workflow

1. **Check** for existing Dependabot/Renovate config so this run complements
   rather than duplicates an automated bot's coverage.
2. **Scan** every package manager in the workspace.
3. **Detect** unused (declared but unimported) and phantom (imported but
   undeclared) dependencies.
4. **Apply the minimum release age cooldown**: hold back versions published
   in the last 4 days unless they fix a CVE in the currently installed
   version.
5. **Update** each package manager to latest, prioritizing security patches
   and scanning with `osv-scanner` for known-malicious packages, not just
   CVEs.
6. **Verify reproducibility** with a clean-room `npm ci`/`--frozen-lockfile`/
   `--immutable` install, then **run tests**, fixing any breaking changes in
   code — never roll back.
7. **No-Op Gate**: only create a branch/commit/PR if manifest or lock files
   actually changed.
8. **Report** a scannable summary: what moved, what's held back, and
   validation status.

## Development

```sh
cd skills/dep-doctor
npm install
npm run eval:lint
npm test
npm run eval
```

`npm test` is the deterministic cross-surface registration check and needs no
external dependencies. `npm run eval` drives a real agent through
[Vally](https://www.npmjs.com/package/@microsoft/vally-cli) and is intended
for on-demand or nightly use.

### Directory structure

```
skills/dep-doctor/
  SKILL.md              # Agent instructions (the skill contract)
  README.md             # This file
  LICENSE               # MIT
  package.json          # Dev tooling
  test/
    registration.test.mjs  # Cross-surface registration parity check
  evals/
    dep-doctor/
      eval.yaml          # Vally capability eval
```

## License

[MIT](LICENSE) &copy; 2026 Jon Gallant
