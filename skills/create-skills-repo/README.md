# create-skills-repo

Create or safely maintain a portable skills marketplace repository with all
current cross-agent manifests, Vally validation, secure CI, Dependabot, a
functional example skill, and an optional catalog.

## Install

```sh
npx skills add jongio/skills --skill create-skills-repo -g --agent github-copilot
```

Reload skills, then ask:

```text
/create-skills-repo create a skills marketplace for my organization
```

## Local CLI

```sh
node scripts/cli.mjs create ./my-skills --owner-login octocat
node scripts/cli.mjs upgrade ./my-skills
node scripts/cli.mjs sync ./my-skills
node scripts/cli.mjs check ./my-skills
node scripts/cli.mjs dry-run upgrade ./my-skills
```

Catalog generation defaults on and composes the standalone
`create-gh-pages-site` skill. If that skill is unavailable, creation stops
before target writes and prints the exact install command. Use `--no-catalog`
to opt out intentionally. The reusable `skills-catalog` template comes from
the shared `jongio/gh-pages-templates` registry at an immutable commit.

The generated repository seeds the bundled canonical `create-skill` snapshot
and uses its noninteractive fixture mode to create `example-skill`. This skill
keeps individual authoring in the standalone tool.

## Safety model

- New repositories are completed in sibling staging directories.
- Managed upgrades preflight all hashes and roll back a failed transaction.
- User-modified managed files block the entire operation.
- Unmanaged files are preserved.
- `check` and `dry-run` write nothing.
- GitHub plans contain argument arrays and are never executed by the CLI.
- Git and GitHub writes require explicit approval outside the CLI.

## Development

```sh
npm test
npm run eval:lint
```

Tests use injected composition fixtures because the canonical
`templates/repository/skills/create-skill/` snapshot is populated from the
standalone skill by the repository coordinator.

## License

MIT. See [LICENSE](LICENSE).
