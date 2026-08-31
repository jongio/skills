---
name: create-skills-repo
description: >-
  **WORKFLOW SKILL** - Create or safely maintain a portable skills marketplace
  repository for multiple AI coding agents. INVOKES: bundled Node.js generator,
  standalone create-skill, standalone create-gh-pages-site, Vally, git, and gh.
  USE FOR: create a skills repo, scaffold an agent skills marketplace, upgrade a
  skills repository, sync skill manifests, check managed skills repo files, dry
  run a skills repository update. DO NOT USE FOR: authoring one skill (use
  create-skill), creating an unrelated GitHub Pages site (use
  create-gh-pages-site), or general repository health files (use repo-ready).
---

# Create Skills Repository

Create and maintain a repository whose canonical `skills/` directory is
discoverable by GitHub Copilot, Codex, ChatGPT desktop, Claude Code, Cursor,
Gemini CLI, and Agent Plugins compatible hosts.

## Commands

| Command | Behavior |
|---|---|
| `create` | Build a new repository in a sibling staging directory, validate it, then publish it locally in one rename. |
| `upgrade` | Update the managed repository baseline and bundled `create-skill` snapshot. |
| `sync` | Rebuild skill-derived manifests, documentation, and Dependabot entries. |
| `check` | Report managed drift and registration drift without writing files. |
| `dry-run` | Preflight `create`, `upgrade`, or `sync` and report the exact local changes without writing files. |

Use the standalone `create-skill` skill for individual authoring.

Read [references/command-contract.md](references/command-contract.md) before
running a command. Read
[references/generated-repository.md](references/generated-repository.md) when
reviewing the generated shape.

## Workflow

1. Resolve the target and requested command.
2. For `create`, gather the owner login, owner name, repository name,
   visibility, display name, and description. Catalog generation is enabled
   unless the user explicitly opts out.
3. Run the matching local command by absolute path while keeping the target
   workspace as the process context:

   ```sh
   node "<skill-dir>/scripts/cli.mjs" create "<target>" --owner-login "<login>"
   node "<skill-dir>/scripts/cli.mjs" upgrade "<target>"
   node "<skill-dir>/scripts/cli.mjs" sync "<target>"
   node "<skill-dir>/scripts/cli.mjs" check "<target>"
   node "<skill-dir>/scripts/cli.mjs" dry-run upgrade "<target>"
   ```

4. If catalog generation is enabled, the generator must resolve
   `create-gh-pages-site` before creating a staging directory. If it cannot,
   stop and show the exact install command printed by the generator. Never
   substitute another site generator.
   Resolve the shared `jongio/gh-pages-templates` registry to a full commit SHA
   and pass it with `--catalog-registry-ref`, unless the user explicitly provides
   a reviewed local templates directory.
5. If the canonical `create-skill` snapshot or its fixture capability is
   unavailable, stop before target writes. Never hand-build `example-skill`.
6. Treat conflict status or exit code 2 as blocked. List every conflicting
   managed path. Do not force, delete, or overwrite user changes.
7. Run the generated repository's validation:

   ```sh
   npm ci --prefix .github/tools/vally --ignore-scripts
   npm test --prefix .github/tools/vally
   ```

8. Preview the catalog locally before proposing publication:

   ```sh
   npm ci --prefix site --ignore-scripts
   npm run dev --prefix site
   ```

9. Read the returned `githubPlan`. It contains exact program and argument
   arrays and a binding hash. Show every command and the target repository to
   the user.
10. Get explicit approval before each git or GitHub write. Execute only the
    approved arrays. Never infer approval from a flag, automation mode, or an
    earlier approval. Repository creation, push, Pages publication, and every
    later GitHub write retain their own approval gates.

## Safety invariants

- The CLI never imports a GitHub client or executes `git` or `gh`.
- Catalog and example composition run only in a sibling staging directory.
- `check` and `dry-run` never write files.
- Managed files carry SHA-256 state. A user edit, deletion, symlink, or
  untracked collision blocks the full operation before target writes.
- Upgrade and sync use a lock, immediate recheck, temporary files, and rollback
  so a reported failure leaves no partial managed update.
- Unmanaged files and authored skills are preserved.
- Input paths, identities, URLs, visibility, templates, and configuration keys
  are validated before use.
- External tools receive argument arrays with `shell: false`.
- Generated workflows use pinned action SHAs, least privilege,
  `persist-credentials: false`, ignored dependency lifecycle scripts, job
  timeouts, and trusted triggers.

## Exit criteria

- The requested command reports `created`, `unchanged`, `updated`, `clean`, or
  `planned`.
- Conflict and drift results are not reported as success.
- Generated validation passes.
- Catalog preview is local until the owner explicitly approves publication.
- No git or GitHub write occurs without its required approval.
