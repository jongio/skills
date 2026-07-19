---
name: repo-ready
description: >-
  Scaffold and maintain the standard community health files every GitHub
  repository needs: .gitignore, .gitattributes, LICENSE, README.md,
  CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, FUNDING.yml, CODEOWNERS,
  issue/PR templates, dependabot.yml, .editorconfig, and CI workflows. Two
  modes: **init** (interview the user, detect the stack, scaffold everything
  from scratch) and **update** (scan an existing repo, identify gaps against
  best practices, and suggest additions file by file). Use when the user says
  "repo ready", "repo init", "repo health", "community health", "add
  gitignore", "add license", "repo files", "repo setup", or asks about
  missing repo files. Do NOT use for project code scaffolding (use
  devx-scaffold), GitHub Pages setup (use create-gh-pages-site), or CI
  pipeline design beyond the starter workflow.
---

# Repo Ready

Turn any repository into a well-maintained, community-ready project by
scaffolding (or auditing) all the standard files GitHub expects. The hard part
isn't writing a LICENSE file; it's knowing which 15+ files matter, how GitHub
uses each one, and making choices that fit the project's stack, audience, and
governance model. This skill owns all of that.

## Two modes

### Init mode (bare `repo-ready` or `repo-ready init`)

Start from scratch. Interview the user to understand the project, then
scaffold every file in one pass.

### Update mode (`repo-ready update`)

Scan an existing repo, compare against the full checklist, report what's
missing or outdated, and offer to create each missing file interactively.

Both modes use the same interview/guidance engine and the same file catalog.
The difference is scope: init creates everything; update creates only what's
missing.

## The file catalog

Every file this skill knows about, grouped by category. The generator
(`scripts/generate.mjs`) produces each one from templates plus user answers.

### Tier 1: Essential (every repo should have these)

| File | Purpose | GitHub behavior |
|------|---------|-----------------|
| `.gitignore` | Exclude build artifacts, deps, OS files | New-repo UI offers language picker |
| `.gitattributes` | Line endings, binary handling, linguist | Powers language stats, diff behavior |
| `LICENSE` | Legal permissions for use/modification | Sidebar badge, license detection, search filter |
| `README.md` | Project introduction and docs | Rendered on repo homepage |

### Tier 2: Community health (open source and team projects)

| File | Purpose | GitHub behavior |
|------|---------|-----------------|
| `CONTRIBUTING.md` | How to contribute | Banner on new issues/PRs |
| `CODE_OF_CONDUCT.md` | Community standards | Community profile checklist, tab in repo |
| `SECURITY.md` | Vulnerability disclosure policy | Security tab, community profile checklist |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | Structured bug reports | Issue template chooser |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | Structured feature requests | Issue template chooser |
| `.github/ISSUE_TEMPLATE/config.yml` | Template chooser config | Controls blank issues, external links |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR body template | Auto-fills PR description |

### Tier 3: Automation and governance

| File | Purpose | GitHub behavior |
|------|---------|-----------------|
| `.github/dependabot.yml` | Automated dependency updates | Dependabot opens PRs on schedule |
| `.github/workflows/ci.yml` | CI pipeline (build + test) | Actions tab, PR status checks |
| `.github/CODEOWNERS` | Auto-assign PR reviewers by path | Review requests, branch protection |
| `.github/FUNDING.yml` | Sponsor button | Heart icon on repo page |
| `CHANGELOG.md` | Version history | Human-readable release notes |

### Tier 4: Editor and tooling (stack-dependent)

| File | Purpose | When to include |
|------|---------|-----------------|
| `.editorconfig` | Cross-editor formatting | Always (universal) |
| `.markdownlint.json` | Markdown style consistency | Repos with significant Markdown |
| `.prettierrc` | Code formatter config | JS/TS projects |
| `.eslintrc` / `eslint.config.js` | Linting config | JS/TS projects |

### Tier 5: Repo metadata (GitHub API settings)

These aren't files; they're repository settings managed via `gh` CLI / GitHub
API. The skill audits and updates them as part of both init and update modes.

| Setting | Purpose | How to check | How to set |
|---------|---------|--------------|------------|
| Description | One-line "About" text on repo page | `gh repo view --json description` | `gh repo edit --description "..."` |
| Topics | Searchable tags (shown as badges) | `gh repo view --json repositoryTopics` | `gh api -X PUT repos/{owner}/{repo}/topics -f "names[]=..."` |
| Website | Homepage URL in repo sidebar | `gh repo view --json homepageUrl` | `gh repo edit --homepage "..."` |
| Social preview | OpenGraph image for link sharing | GitHub web UI only | Cannot be set via API (inform user) |

### Tier 6: Supplementary (situational)

| File | Purpose | When to include |
|------|---------|-----------------|
| `SUPPORT.md` | Where to get help | Projects with forums/Discord/SO presence |
| `CITATION.cff` | Academic citation metadata | Research/academic software |
| `.github/DISCUSSION_TEMPLATE/` | Structured discussion forms | Repos using GitHub Discussions |

## Interview protocol

**Never scaffold on a guess.** Every file involves choices (which license? what
stack for .gitignore? who are the codeowners?). Interview the user to make
informed decisions.

### Interview flow

Ask one question at a time using `ask_user`. Skip any question the user already
answered in their prompt. Confirm inferred answers in one line before
scaffolding.

#### Phase 1: Project context (always detect, then ask)

1. **Stack detection** (auto): Scan the repo for lockfiles, manifests, and
   source files. Detect: `package.json`/`pnpm-lock.yaml`/`yarn.lock` (Node.js),
   `requirements.txt`/`pyproject.toml`/`Pipfile` (Python), `go.mod` (Go),
   `Cargo.toml` (Rust), `*.csproj`/`*.sln` (.NET), `pom.xml`/`build.gradle`
   (Java), `Gemfile` (Ruby), `Dockerfile`, `terraform/` (IaC). Report what you
   found: "Detected: Node.js (pnpm), TypeScript, Docker."

2. **Repo visibility** (auto-detect, NEVER guess): Run
   `gh api repos/{owner}/{repo} --jq '.private'` to determine if the repo is
   public or private. This is authoritative. Do NOT infer visibility from the
   repo name, description, or any other heuristic. If `gh` is unavailable or
   the command fails, ask the user explicitly. Report what you found:
   "Repo visibility: private" or "Repo visibility: public".

3. **Project type**: Is this a library/package, a CLI tool, a web app, an API
   service, a monorepo, or something else? (Affects README structure,
   CONTRIBUTING guidance, CI workflow.)

4. **Audience**: Based on the detected visibility, set the default:
   - **Private repo** -> default to "internal/personal". Ask: "This is a
     private repo. Should I include community files (CODE_OF_CONDUCT,
     CONTRIBUTING, issue templates) anyway, or skip them?"
   - **Public repo** -> default to "open source". Ask: "This is a public repo.
     Should I include full community health files (CODE_OF_CONDUCT,
     CONTRIBUTING, SECURITY, issue templates, FUNDING)?"
   
   Never tell the user a repo is public when it's private, or vice versa.
   The `gh api` result is the source of truth.

#### Phase 2: License (ask if no LICENSE exists)

5. **License selection**: Guide the user through license choice:
   - "I want maximum freedom for users" -> MIT or ISC
   - "I want patent protection too" -> Apache 2.0
   - "I want derivatives to stay open" -> GPL-3.0 or AGPL-3.0
   - "I want file-level copyleft" -> MPL 2.0
   - "Public domain" -> Unlicense or CC0-1.0
   - "Match my ecosystem" -> detect and suggest (npm defaults to ISC, Rust
     community uses MIT/Apache dual)

   Present choices with the `ask_user` tool. Include a "(Recommended)" label
   on the option that best fits the detected context.

6. **Copyright holder**: Who holds copyright? Default to the git user name
   (`git config user.name`) or the GitHub org if detected from the remote.

#### Phase 3: Community files (ask if audience includes external contributors)

7. **Code of Conduct**: Use Contributor Covenant v2.1? (Recommended for all
   open source.) Ask for the enforcement contact email.

8. **Security contact**: Email or URL for vulnerability reports.

9. **Funding**: Does the project accept sponsorship? Which platforms?
   (GitHub Sponsors, Ko-fi, Patreon, Open Collective, custom URL.)

10. **CODEOWNERS**: Who should review PRs? Map paths to GitHub usernames/teams.
    Default: `* @<repo-owner>`.

#### Phase 4: Automation (ask for all projects)

11. **Dependabot**: Enable automated dependency updates? Which ecosystems?
    (Auto-detect from stack.) What schedule? Default: weekly.

12. **CI workflow**: Generate a starter CI workflow? (Auto-detect framework
    and test runner from stack.)

#### Phase 5: Repo metadata (GitHub settings)

Auto-detect current values via `gh repo view --json description,repositoryTopics,homepageUrl`.
For each setting, show the current value and ask if the user wants to update it.

13. **Description**: The one-line "About" text shown on the repo page. If empty
    or generic, suggest a description based on the detected stack and project
    type. Show the current value (or "empty") and ask: "Update description to:
    '...'?" Present the suggestion as the first choice.

14. **Topics**: Searchable tags shown as badges on the repo page. Auto-suggest
    topics based on detected stack (e.g., `node`, `typescript`, `python`,
    `go`, `rust`, `docker`, `cli`, `library`, `api`). Show current topics
    and suggest additions. Use `gh api -X PUT repos/{owner}/{repo}/topics`
    to set them (this replaces all topics, so merge existing + new).

15. **Website/Homepage**: The URL shown in the repo sidebar. If the repo has a
    GitHub Pages site, suggest that URL. If it has a docs site or project
    website, suggest that. If empty, ask: "Does this project have a website
    or docs URL?"

16. **Social preview**: Cannot be set via API. If the repo lacks a social
    preview image, inform the user: "Consider adding a social preview image
    via Settings > Social preview for better link sharing on social media."

#### Phase 6: Confirm and scaffold

17. **Summary**: Show a table of all files to be created AND all repo settings
    to be updated, each with a one-line description. Ask: "Create all of
    these?" with options to deselect individual items.

    The summary should clearly separate:
    - **Files to create** (committed to the repo)
    - **Repo settings to update** (applied via GitHub API, not committed)

## Stack detection

The generator auto-detects the project stack by scanning for these markers:

| Marker file(s) | Stack | .gitignore template | CI template |
|-----------------|-------|---------------------|-------------|
| `package.json` | Node.js | `node` | `node.js.yml` |
| `pnpm-lock.yaml` | Node.js (pnpm) | `node` | `node.js.yml` (pnpm variant) |
| `yarn.lock` | Node.js (yarn) | `node` | `node.js.yml` (yarn variant) |
| `tsconfig.json` | TypeScript | `node` | adds tsc build step |
| `requirements.txt`, `pyproject.toml`, `setup.py`, `Pipfile` | Python | `python` | `python-package.yml` |
| `go.mod` | Go | `go` | `go.yml` |
| `Cargo.toml` | Rust | `rust` | `rust.yml` |
| `*.csproj`, `*.sln` | .NET | `dotnetcore` | `dotnet.yml` |
| `pom.xml` | Java (Maven) | `java` | `java-gradle.yml` |
| `build.gradle`, `build.gradle.kts` | Java/Kotlin (Gradle) | `java` | `java-gradle.yml` |
| `Gemfile` | Ruby | `ruby` | `ruby.yml` |
| `Dockerfile` | Docker | `docker` added | adds docker build |
| `*.tf` | Terraform | `terraform` | terraform validate |
| `composer.json` | PHP | `composer` | `php.yml` |
| `Package.swift` | Swift | `swift` | `swift.yml` |
| `pubspec.yaml` | Dart/Flutter | `flutter` | flutter test |

Multiple stacks combine: a repo with `package.json` + `Dockerfile` +
`terraform/` gets all three in `.gitignore` and appropriate CI steps.

## The gitignore.io API

For `.gitignore` generation, the skill uses the Toptal gitignore.io API:

```
GET https://www.toptal.com/developers/gitignore/api/{templates}
```

Where `{templates}` is a comma-separated list like `node,macos,windows,visualstudiocode`.

The generator always includes OS templates (`macos,windows,linux`) and editor
templates (`visualstudiocode`) alongside the detected stack templates.

If the API is unreachable, fall back to bundled minimal templates in
`references/gitignore-fallbacks/`.

## The GitHub Licenses API

For `LICENSE` generation, use the GitHub API:

```
GET https://api.github.com/licenses/{spdx-id}
```

This returns the full license text with `[year]` and `[fullname]` placeholders
to fill in. Supported SPDX IDs: `mit`, `apache-2.0`, `gpl-3.0`, `gpl-2.0`,
`lgpl-3.0`, `agpl-3.0`, `bsd-2-clause`, `bsd-3-clause`, `isc`, `mpl-2.0`,
`unlicense`, `cc0-1.0`.

## File generation details

### .gitattributes

Always include these universal rules:

```gitattributes
# Auto-detect text files and normalize line endings
* text=auto

# Force LF for shell scripts (even on Windows)
*.sh text eol=lf
*.bash text eol=lf

# Force CRLF for Windows-specific files
*.bat text eol=crlf
*.cmd text eol=crlf
*.ps1 text eol=crlf
*.sln text eol=crlf

# Binary files: never diff, never line-end convert
*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.ico binary
*.webp binary
*.svg text
*.pdf binary
*.zip binary
*.tar.gz binary
*.woff binary
*.woff2 binary
*.ttf binary
*.eot binary

# Linguist overrides (customize per project)
*.min.js linguist-generated
*.min.css linguist-generated
```

Add stack-specific rules based on detection (e.g., `*.lock linguist-generated`
for Node.js, `go.sum linguist-generated` for Go).

### Issue templates (YAML forms, not Markdown)

Use the modern YAML issue form format (`.yml`) with structured fields, not the
legacy Markdown format. YAML forms provide dropdown menus, required field
validation, and checkboxes.

### CI workflow

Generate based on detected stack. Use the latest stable action versions:
- `actions/checkout@v4`
- `actions/setup-node@v4`
- `actions/setup-python@v5`
- `actions/setup-go@v5`
- `actions/setup-dotnet@v4`

### CONTRIBUTING.md

Tailor to the detected stack:
- Include the correct install command (`npm install`, `pip install -e .`,
  `go mod download`, `cargo build`, `dotnet restore`)
- Include the correct test command
- Include branch naming convention (default: `feat/`, `fix/`, `docs/`)
- Include commit convention (Conventional Commits)

### CODE_OF_CONDUCT.md

Use Contributor Covenant v2.1 text verbatim. Only customize the enforcement
contact.

## Update mode behavior

When running in update mode (`repo-ready update`):

1. **Scan**: Check for every file in the catalog. For each file:
   - **Present**: Mark as existing (green checkmark)
   - **Missing**: Mark as missing (red X)
   - **Outdated**: Check for known issues (e.g., old action versions in CI,
     legacy `.eslintrc` format, Markdown issue templates instead of YAML forms)

2. **Audit repo metadata**: Check description, topics, and homepage via
   `gh repo view --json description,repositoryTopics,homepageUrl`. Flag
   empty or missing values.

3. **Report**: Show a summary table with status for every file AND repo
   metadata settings.

4. **Suggest**: For each missing or outdated file, describe what it does and
   why the repo should have it. Group by tier (essential, community, automation,
   tooling). For empty repo metadata, suggest values.

5. **Interview**: For each file the user wants to add, run the relevant
   interview questions (same as init mode, but only for the gaps).

6. **Generate**: Create only the selected files.

7. **Apply repo metadata**: For each approved metadata change, apply via `gh`
   CLI (requires `ask_user` approval for each change).

8. **Delta awareness**: If a file exists but is incomplete (e.g., `.gitignore`
   exists but is missing patterns for the detected stack), offer to append the
   missing patterns rather than overwriting. Show a diff preview before
   applying.

## The workflow you follow

### Init mode

1. Detect stack (auto-scan)
2. Detect repo visibility (auto, via `gh api`)
3. Interview (phases 1 through 6)
4. Generate all selected files via `scripts/generate.mjs`
5. Apply approved repo metadata changes via `gh` CLI
6. Show summary of created files and applied settings
7. Offer to commit: `git add -A && git commit -m "chore: scaffold repo health files"`

### Update mode

1. Detect stack (auto-scan)
2. Detect repo visibility (auto, via `gh api`)
3. Scan existing files against catalog
4. Audit repo metadata (description, topics, homepage)
5. Report gaps with tier labels
6. Interview for missing files and metadata only
7. Generate selected files
8. Apply approved repo metadata changes via `gh` CLI
9. Show diff for any file being appended to (not overwritten)
10. Offer to commit

## The generator

```
node scripts/generate.mjs <mode> [options]
```

| Option | Purpose |
|--------|---------|
| `--mode init\|update` | Init (scaffold all) or update (fill gaps) |
| `--stack <stacks>` | Override auto-detected stacks (comma-separated) |
| `--license <spdx-id>` | License to use (e.g., `mit`, `apache-2.0`) |
| `--owner <name>` | Copyright holder name |
| `--year <year>` | Copyright year (default: current year) |
| `--coc-contact <email>` | Code of Conduct enforcement contact |
| `--security-contact <email>` | Security vulnerability report contact |
| `--funding <platform:username>` | Funding config (repeatable) |
| `--codeowners <pattern:owner>` | CODEOWNERS entries (repeatable) |
| `--no-dependabot` | Skip dependabot.yml |
| `--no-ci` | Skip CI workflow |
| `--no-editorconfig` | Skip .editorconfig |
| `--dir <path>` | Output directory (default: current directory) |
| `--dry-run` | Show what would be created without writing |

## Safety rules

1. **Never overwrite existing files** without explicit user approval via
   `ask_user`. Show a diff preview first.
2. **Never commit** without user approval.
3. **Never push** without user approval.
4. **Append mode**: When a file exists and the generator would add content,
   show the additions and ask before modifying.
5. **License accuracy**: Use exact license text from the GitHub API or
   canonical sources. Never paraphrase legal text.

## Exit criteria

- **Init mode**: All selected files created, summary shown, commit offered.
- **Update mode**: Gap report shown, selected missing files created, diffs
  shown for modifications, commit offered.
