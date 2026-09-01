# Generated Repository

## Canonical content

Each skill lives at `skills/<name>/SKILL.md`. The generated repository seeds
the standalone `create-skill` snapshot and invokes its noninteractive fixture
mode to produce a functional `example-skill`.

The generator previews the fixture plan, reads its returned hash, then repeats
the unchanged command with `--approve <hash>`:

```sh
node skills/create-skill/scripts/create-skill.mjs fixture \
  --input <fixture.json> --repo-root <repository> --dry-run
```

## Distribution manifests

The repository includes:

- `plugin.json`
- `marketplace.json`
- `.agents/plugins/marketplace.json`
- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.cursor-plugin/marketplace.json`
- `gemini-extension.json`

`sync` derives every skill registration from the canonical `skills/`
directory. It rejects missing frontmatter, mismatched names, duplicate
case-insensitive identities, symlinks, and unsafe paths.

## Validation and automation

- `.vally.yaml` discovers repository skills and evals.
- `.github/tools/vally/` pins the Vally CLI and its lockfile.
- `.github/workflows/skill-lint.yml` validates manifests, skills, eval specs,
  and deterministic tests.
- `.github/workflows/skill-eval.yml` runs only from trusted scheduled or manual
  triggers.
- `.github/dependabot.yml` covers actions, Vally, and packaged skills.
- `test/distribution-manifests.test.mjs` enforces cross-agent parity and scans
  every workflow for the security baseline.

## Catalog

Catalog composition is enabled by default and delegated to
`create-gh-pages-site`. The shared `jongio/gh-pages-templates` registry owns the
`skills-catalog` source. The Pages skill owns source validation, immutable
registry verification, staging, base paths, and deploy workflow validation.
Catalog files are not overwritten by repository upgrades.
The standalone Astro stage is mapped under `site/`. Its deploy workflow moves
to `.github/workflows/deploy-pages.yml`. Its npm steps run from `site`,
setup-node caches `site/package-lock.json`, and Pages uploads `site/dist`.

Preview is local first:

```sh
npm ci --prefix site --ignore-scripts
npm run dev --prefix site
```

Publishing to Pages is a separate owner-approved operation.

## Managed state

`skills-repo.config.json` stores validated repository identity and options.
`.skills-repo/state.json` stores the template version, hash version, and a
SHA-256 record for every managed file. Text hashes normalize line endings to
LF. Binary hashes use raw bytes.

The lifecycle tool manages only the baseline, derived manifests, and bundled
`create-skill` snapshot. It preserves authored skills, catalog content, and all
other unmanaged files.
