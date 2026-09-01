# Command Contract

## Create

```sh
node scripts/cli.mjs create <target> --owner-login <login> [options]
```

Required:

- `<target>`: a path outside the installed skill.
- `--owner-login`: the GitHub owner login.

Options:

- `--owner-name <name>`
- `--repo <name>`
- `--package-name <name>`
- `--display-name <name>`
- `--description <text>`
- `--visibility <public|private|internal>`
- `--default-branch <name>`
- `--no-catalog`
- `--create-skill-source <path>`
- `--catalog-script <path>`
- `--catalog-templates-dir <path>`
- `--catalog-registry <owner/repo>`
- `--catalog-registry-ref <full-commit-sha>`

Catalog generation defaults on. The target stays untouched until the
`create-skill` snapshot and `create-gh-pages-site` capability checks pass.
Creation stages the full repository beside the destination and publishes it
with one directory rename.

Running the same `create` command against the resulting managed repository is
idempotent. Different identity options are rejected.

## Upgrade

```sh
node scripts/cli.mjs upgrade <target> [--create-skill-source <path>]
```

Upgrade refreshes the managed repository template and the canonical
`create-skill` snapshot. It does not regenerate authored skills or the catalog.
Those remain owned by their dedicated tools.

## Sync

```sh
node scripts/cli.mjs sync <target>
```

Sync discovers directories containing a valid `SKILL.md`, then rebuilds the
skill table, plugin registrations, root keywords, and Dependabot skill entries.
It preserves all other managed and unmanaged files.

## Check

```sh
node scripts/cli.mjs check <target>
```

Check compares current normalized content with managed hashes and freshly
derived registrations. Exit code 0 means clean. Exit code 2 means drift or a
conflict. It writes nothing.

## Dry run

```sh
node scripts/cli.mjs dry-run <create|upgrade|sync> <target> [options]
```

Dry run resolves dependencies, validates input, and returns planned changes.
It writes neither the target nor a staging tree.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, clean, or plan produced |
| 1 | Invalid input or unexpected failure |
| 2 | Managed conflict or drift |
| 3 | Required composition capability unavailable |

## GitHub plan

Create returns a data-only `githubPlan` with:

- `approvalRequired: true`
- `approved: false`
- a SHA-256 `planHash`
- one object per command containing `program`, `args`, and `cwd`

No command accepts an approval bypass. The caller must display the exact plan,
obtain approval outside the CLI, and execute only the approved argument arrays.
