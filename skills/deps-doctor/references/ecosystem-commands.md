# Ecosystem commands

Lookup tables for the discovery, update, workspace, and validation steps. The
decision rules live in `SKILL.md`; this file records only which command belongs
to which ecosystem.

Use the package manager the repository already selected, prefer its native
command, and preserve its lockfile format.

## Language package managers

The apply column changes manifests and lockfiles. Except where a command is
already marked as script-free, run it in the scripts-disabled form from step 5
of `SKILL.md` first, review the resolved graph, and only then install normally.
A bare install or update as the first action runs package-authored code before
anyone has looked at what changed.

The apply column also moves every package to its newest eligible release. That
is only correct when step 4 held nothing back. Where a release was withheld for
age or a package was pinned back to settle a peer conflict, apply that package
by explicit version from the table further down instead, or the bulk command
will reinstate exactly what step 4 rejected.

| Ecosystem | Discover updates | Apply updates |
|---|---|---|
| npm | `npm outdated` | `npx --yes npm-check-updates@<pinned> -u` (edits `package.json` only), then `npm install --ignore-scripts`, review, then `npm install` |
| pnpm | `pnpm outdated` | `pnpm update -r --latest --ignore-scripts`, review, then `pnpm install` |
| Yarn Berry | `yarn upgrade-interactive` (a TUI that writes on confirm and needs a TTY, so treat it as interactive only). For an unattended read, compare `yarn.lock` entries against `yarn npm info <package> --fields version` | `yarn up '<package>' --mode skip-build`, then `yarn dedupe --mode skip-build`, review the deduplicated graph, then `yarn install` |
| Yarn Classic | `yarn outdated` | `yarn upgrade --latest --ignore-scripts`, review, then `yarn install` |
| pip | `pip list --outdated` | Update the pinned requirements, then `pip install -r requirements.txt` |
| Pipenv | `pipenv update --outdated` | `pipenv update` |
| Poetry | `poetry show --outdated` | `poetry update --lock`, review `poetry.lock`, then `poetry install` |
| uv | `uv lock --upgrade --dry-run`, or `uv tree --outdated --depth 1` for project context | `uv lock --upgrade`, review, then `uv sync` |
| Go | `go list -u -m all` | `go get -u ./... && go mod tidy` |
| Cargo | `cargo update --dry-run`, or `cargo outdated` when that subcommand is installed | `cargo update` |
| Bundler | `bundle outdated` | `bundle lock --update`, review, then `bundle install` |
| Composer | `composer outdated` | `composer update --no-scripts --no-plugins`, review, then `composer install` |
| NuGet (PackageReference) | `dotnet package list --outdated` | `dotnet package add <name>`, or edit `Directory.Packages.props` under central package management |
| NuGet (`packages.config`) | `nuget list -Source <feed>`, comparing against the pinned versions | `nuget update <solution>.sln`, or `nuget update packages.config -Id <name> -Version <version>` |
| Maven | `mvn versions:display-dependency-updates` | `mvn versions:use-latest-releases` |
| Gradle | `./gradlew dependencyUpdates` (`ben-manes.versions` plugin) | Edit `gradle/libs.versions.toml` or the build script |
| Swift | `swift package show-dependencies`, then compare against upstream releases. Treat `swift package update --dry-run` as unsafe for discovery, since it has been reported to rewrite `Package.resolved` | `swift package update` |
| pub | `dart pub outdated`, or `flutter pub outdated` in a Flutter app | `dart pub upgrade --major-versions` |
| Hex | `mix hex.outdated` | `mix deps.update --all` |

## Applying a specific selected version

Use these whenever step 4 held a release back, so the apply step installs the
version that was chosen rather than the newest one available.

| Ecosystem | Apply one selected version |
|---|---|
| npm | `npm install <package>@<version> --ignore-scripts` |
| pnpm | `pnpm update <package>@<version> --ignore-scripts` |
| Yarn Berry | `yarn up '<package>@<version>' --mode skip-build` |
| Yarn Classic | `yarn upgrade <package>@<version> --ignore-scripts` |
| pip | Pin `<package>==<version>` in the requirements file, then install |
| Poetry | `poetry add '<package>@<version>' --lock`, then `poetry install` |
| uv | `uv lock --upgrade-package '<package>==<version>'`, then `uv sync` |
| Go | `go get <module>@<version> && go mod tidy` |
| Cargo | `cargo update -p <crate> --precise <version>` |
| Bundler | Pin the version in the `Gemfile`, then `bundle lock --update <gem>` |
| Composer | `composer require '<vendor/package>:<version>' --no-scripts --no-plugins` |
| NuGet | `dotnet package add <name> --version <version>` |
| Maven and Gradle | Set the version property or version catalog entry directly |
| Swift, pub, Hex | Set the constraint in the manifest, then resolve |

Yarn Classic and Yarn Berry are different tools that share a lockfile name.
A `.yarnrc.yml` in the repository means Berry; a `yarn.lock` without one is
usually Classic. `yarn up`, `--mode skip-build`, and `yarn install --immutable`
are Berry only, and `yarn outdated` was removed in Berry.

The .NET CLI moved to noun-first commands in the .NET 10 SDK: `dotnet package
list` and `dotnet package add` replace `dotnet list package` and `dotnet add
package`. The verb-first forms still work, so check `dotnet --version` and use
the noun-first form on SDK 10 and later. `dotnet package list` also restores by
default; pass `--no-restore` when that is not wanted.

Those `dotnet package` commands only understand PackageReference projects. A
legacy `packages.config` project is driven by `nuget restore` and
`nuget update` instead, has no `packages.lock.json` and therefore no
`--locked-mode` equivalent to validate against, and may need Visual Studio for
package content transformations. Say so rather than reporting the project as
audited.

Poetry needs `poetry update --lock` rather than `poetry lock` to move
dependencies. `poetry lock` preserves the versions already locked unless a
constraint changed, so a run built on it can report success while updating
nothing. Use `poetry lock --regenerate` to rebuild the lock from scratch.

Composer's `--no-scripts` does not disable Composer plugins, which are
third-party executable code in their own right. Pair it with `--no-plugins` for
the review pass, then re-enable both only after the resolved graph has been
read.

Confirm a subcommand exists before relying on it. `cargo outdated`,
`bundler-audit`, and the Gradle versions plugin are add-ons rather than built in.
A repository that does not have them installed is not a repository with no
updates available, so report the difference.

## Surfaces no package manager owns

| Surface | Approach |
|---|---|
| Docker base images | Compare the pinned tag or digest against the registry, then bump the `FROM` line or the compose `image:`. Pin as `image:<tag>@sha256:<digest>`, which keeps the tag readable and still resolves by digest. Do not put the tag in a trailing `#` comment: Docker treats `#` after an instruction as part of the argument, not as a comment, so that produces an invalid reference. |
| GitHub Actions | Read the referenced versions out of `.github/workflows/*.yml` and `.github/actions/*/action.yml`, then bump each to its latest release. Pin `uses:` to a full commit SHA with the version as a trailing comment, because a tag is mutable and a SHA is not. |
| Terraform | `terraform init -upgrade`, then `terraform providers lock` with a `-platform` flag for every platform the team builds on, so the lock file does not become machine-specific. |
| Dev containers | Bump the image reference and each entry under `features` to its current release. |
| pre-commit | `pre-commit autoupdate`, which rewrites each hook `rev`. |

## Workspaces and monorepos

Run updates in every workspace through the package manager's own workspace
support, and avoid mixing npm, pnpm, and Yarn commands in the same managed tree.

For pnpm, inspect `pnpm-workspace.yaml` for `catalog:` entries and update catalog
versions rather than individual workspace references when a dependency is
centrally managed. On pnpm 10 and later, dependency lifecycle scripts do not run
by default: confirm a build script is genuinely needed and trusted before adding
only that package to `onlyBuiltDependencies`, and never allow every lifecycle
script. Keep pnpm project settings in `pnpm-workspace.yaml`; current pnpm
versions no longer read general settings from the `pnpm` field in
`package.json`.

For .NET repositories using central package management, change the version in
`Directory.Packages.props` rather than in each project file. For Gradle version
catalogs, change `gradle/libs.versions.toml` rather than individual build
scripts.

Across a JavaScript monorepo, check that the same dependency is not pinned to
different versions in different workspaces. `syncpack list-mismatches` reports
the drift, and a catalog entry is usually the durable fix.

## Version constraints

| Dependency type | Update approach |
|---|---|
| Direct and development dependencies | Update freely within the maintenance scope. |
| Peer dependencies | Preserve the supported compatibility range. |
| Optional dependencies | Update only when the optional path is used and validated. |
| Pinned production dependencies | Preserve the pinning policy while selecting the latest compatible release. |

## Clean-room validation

| Ecosystem | Frozen install |
|---|---|
| npm | `npm ci` |
| pnpm | `pnpm install --frozen-lockfile` |
| Yarn Berry | `yarn install --immutable` |
| Yarn Classic | `yarn install --frozen-lockfile` |
| uv | `uv lock --check`, then `uv sync --locked` |
| Poetry | `poetry check --lock`, then `poetry install` |
| Bundler | `BUNDLE_FROZEN=true bundle install` |
| Composer | `composer install` |
| Cargo | `cargo build --locked` |
| Go | `go mod verify`, then build with `-mod=readonly` |
| NuGet | `dotnet restore --locked-mode`, which requires a committed `packages.lock.json` |

Use the form that validates rather than the one that merely avoids writing.
`uv sync --frozen` installs the lockfile as-is without checking it against
`pyproject.toml`, so it will happily install a stale lockfile; `uv lock --check`
plus `uv sync --locked` is what actually proves the two agree. For Bundler,
prefer the `BUNDLE_FROZEN` environment variable over `bundle config set` or the
deprecated `--deployment` flag: the first two persist settings into
`.bundle/config` and vendor gems into `vendor/bundle`, which changes the
project's install layout when the goal was only to check the lockfile.
