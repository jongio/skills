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

Development tooling, the bundled authoring snapshot, and newly generated skills
pin `@microsoft/vally-cli` to `0.18.0`. The bundled shared tooling lockfile matches
the authoring skill's pin so noninteractive repository creation works without
installing dependencies. Intentional eval fixtures and unrelated template
dependency snapshots remain unchanged.

Vally requires grader names to be unique across each eval file and at most
60 characters long. Strict-lint existing eval specs before running them.

## Versioning

Creation accepts `--package-version <semver>` (default `1.0.0`).
Generated repositories include `scripts/version-skills.mjs` with `check`,
`sync`, and `bump <package|skill-name> <major|minor|patch>` commands; add
`--dry-run` to preview. `package.version` in the managed configuration is
the aggregate source of truth, and each skill uses `metadata.version` in
`SKILL.md`. Skill bumps also patch the aggregate plugin and update managed
hashes transactionally. CI checks distribution version parity.
Release commands hold shared locks during both planning and application.
In the source marketplace, a `create-skill` release also refreshes its bundled
metadata and patches the containing `create-skills-repo` release.

Generator sync preserves each discovered skill version. Upgrade reads the
incoming bundled authoring skill's version, not a hard-coded `1.0.0`.
It rejects an authoring-skill downgrade and patches the aggregate when upgrading
to a newer authoring-skill release.
For legacy authored skills, sync preserves the existing marketplace version;
run the generated version helper's `sync` to populate missing metadata.
Private npm tooling versions and schema/template versions remain independent.

## Safety guarantees

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
