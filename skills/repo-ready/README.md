# Repo Ready

Scaffold and maintain the standard community health files every GitHub
repository needs.

## What it does

**Repo Ready** ensures your repository has all the files GitHub expects for a
well-maintained project: `.gitignore`, `.gitattributes`, `LICENSE`, `README.md`,
`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates,
`dependabot.yml`, CI workflows, `.editorconfig`, and more.

Two modes:

- **Init**: Interview the user, detect the project stack, and scaffold
  everything from scratch.
- **Update**: Scan an existing repo, identify what's missing, and suggest
  additions file by file.

## Install

### As a Copilot skill (recommended)

```sh
# Install just this skill (global, for GitHub Copilot):
npx skills add jongio/skills --skill repo-ready -g --agent github-copilot

# Into the current project instead (drop -g):
npx skills add jongio/skills --skill repo-ready

# Or install every skill in the repo:
npx skills add jongio/skills --all
```

### Manual

Copy the `skills/repo-ready/` directory into your project's `.github/skills/`
or reference it in your Copilot instructions.

## Usage

In any Copilot-enabled agent (GitHub Copilot, Claude Code, Cursor, etc.):

```
repo-ready          # Init mode: scaffold all files with guided interview
repo-ready init     # Same as above (explicit)
repo-ready update   # Update mode: scan for gaps, suggest additions
```

The skill auto-detects your project stack (Node.js, Python, Go, Rust, .NET,
Java, Ruby, Docker, Terraform, etc.) and tailors every generated file to match.

## What gets created

### Tier 1: Essential (every repo)
- `.gitignore` (stack-specific via gitignore.io API)
- `.gitattributes` (line endings, binary handling, linguist overrides)
- `LICENSE` (guided selection from 12+ SPDX licenses)
- `README.md` (structure tailored to project type)

### Tier 2: Community health (open source)
- `CONTRIBUTING.md` (stack-aware setup instructions)
- `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1)
- `SECURITY.md` (vulnerability disclosure policy)
- `.github/ISSUE_TEMPLATE/bug_report.yml` (structured YAML form)
- `.github/ISSUE_TEMPLATE/feature_request.yml` (structured YAML form)
- `.github/ISSUE_TEMPLATE/config.yml` (template chooser config)
- `.github/PULL_REQUEST_TEMPLATE.md`

### Tier 3: Automation and governance
- `.github/dependabot.yml` (auto-detected ecosystems)
- `.github/workflows/ci.yml` (stack-matched CI pipeline)
- `.github/CODEOWNERS`
- `.github/FUNDING.yml`
- `CHANGELOG.md`

### Tier 4: Editor and tooling
- `.editorconfig` (universal cross-editor config)

### Tier 5: Repo metadata (GitHub API settings)
- Description ("About" text on repo page)
- Topics (searchable tag badges)
- Homepage URL (sidebar link)

## How the interview works

The skill asks one question at a time and skips anything it can auto-detect or
that the user already specified. Typical flow:

1. Auto-detect stack from lockfiles and manifests
2. Auto-detect repo visibility via `gh api` (never guesses)
3. Ask: project type (library, CLI, web app, API, monorepo)
4. Ask: audience (defaults based on detected visibility)
5. Ask: license (guided with recommendations)
6. Ask: code of conduct contact
7. Ask: security contact
8. Ask: funding platforms (if applicable)
9. Ask: CODEOWNERS mapping
10. Ask: dependabot schedule
11. Review repo metadata (description, topics, homepage)
12. Confirm: show summary table, let user deselect files
13. Generate everything in one pass

## Update mode

When running on an existing repo, the skill:

1. Scans for every file in the catalog
2. Audits repo metadata (description, topics, homepage)
3. Reports a gap analysis table (present/missing/outdated)
4. Groups suggestions by tier
5. Interviews only for missing files and metadata
6. Shows diff previews before modifying existing files
7. Offers to append missing patterns to existing `.gitignore` instead of
   overwriting

## Development

```sh
cd skills/repo-ready
npm test    # Run all tests
```

### Directory structure

```
skills/repo-ready/
  SKILL.md              # Agent instructions (the skill contract)
  README.md             # This file
  LICENSE               # MIT
  package.json          # Dev tooling
  scripts/
    generate.mjs        # File generator
    detect-stack.mjs    # Re-export of lib/detect-stack.mjs + CLI entry point
    scan-repo.mjs       # Existing file scanner (update mode)
  test/
    generate.test.mjs   # Generator tests
    detect.test.mjs     # Stack detection tests
    scan.test.mjs       # Scanner tests

lib/                    # Shared modules (repo root)
  detect-stack.mjs      # Source of truth for stack detection
```

## License

[MIT](LICENSE) &copy; 2026 Jon Gallant
