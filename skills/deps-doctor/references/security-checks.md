# Security and supply-chain checks

Lookup tables for the release-age, audit, screening, and override steps. The
decision rules live in `SKILL.md`; this file records the commands, settings, and
mechanisms each one needs.

## Minimum release age settings

Prefer enforcement by the package manager itself over checking publish dates by
hand, because a configured setting also protects every later install and every
contributor, not just this run.

| Ecosystem | Setting | Location | Unit |
|---|---|---|---|
| npm | `min-release-age` | `.npmrc` | days |
| pnpm | `minimumReleaseAge`, with `minimumReleaseAgeExclude` for exceptions | `pnpm-workspace.yaml` | minutes |
| Yarn Berry | `npmMinimalAgeGate`, with `npmPreapprovedPackages` for exceptions | `.yarnrc.yml` | minutes |
| Dependabot | `cooldown` with `default-days`, plus `semver-major-days`, `semver-minor-days`, `semver-patch-days` | `.github/dependabot.yml` | days |
| Renovate | `minimumReleaseAge` | Renovate configuration | duration string, such as `"3 days"` |

The units differ between ecosystems, so a value copied from one to another is
wrong by a factor of 1440. Give Yarn a plain numeric minute count rather than a
duration string. npm has no per-package exclusion yet, so a package that must
bypass the gate needs a different mechanism there.

These options are recent and their names, units, and defaults have changed
between releases. Confirm the setting and its unit against the installed
version's own documentation before writing it into a configuration file, rather
than assuming the values above are current.

Where no such setting exists, check the publish date before adopting a version.
Select the version explicitly rather than reading whatever is newest:

```sh
npm view "<package>@<version>" "time[<version>]"
curl -sS "https://pypi.org/pypi/<package>/json" | jq -r --arg v "<version>" '.releases[$v][0].upload_time'
curl -sS "https://crates.io/api/v1/crates/<package>/versions" | jq -r --arg v "<version>" '.versions[] | select(.num == $v) | .created_at'
```

A dotted npm field path such as `time.1.2.3` reads as nested keys and returns
nothing, so the bracket form is required. Selecting `.versions[0]` from
crates.io returns the newest release regardless of which version was asked
about, which is the opposite of what this check is for.

## Vulnerability audits

Run the native command for every detected ecosystem, before and after updates.

| Ecosystem | Audit and policy checks |
|---|---|
| npm | `npm audit` |
| pnpm | `pnpm audit` |
| Yarn Berry | `yarn npm audit --all --recursive` |
| pip and Poetry | `pip-audit` |
| Pipenv | `pipenv audit`, or `pipenv check --scan` where a Safety API key is available. Bare `pipenv check` is deprecated |
| Go | `govulncheck ./...` |
| Cargo | Prefer `cargo deny check`; fall back to `cargo audit` |
| Bundler | `bundle audit check --update` when `bundler-audit` is installed |
| Composer | `composer audit` |
| NuGet | `dotnet package list --vulnerable --include-transitive` |
| Maven and Gradle | OWASP Dependency-Check, or the build tool's own advisory plugin |
| Hex | `mix hex.audit` for retired packages, plus `mix deps.audit` when `mix_audit` is installed |

For a multi-ecosystem repository, also run `osv-scanner scan source --recursive .`
as a supplementary pass. Its value is not duplicate CVE coverage: it reports OSV
`MAL-` entries for known-malicious packages, including typosquats, dependency
confusion, and protestware, which the ecosystem-native audits above do not. It
does not replace them.

Source scanning does not see inside a container image. The operating system
packages a base image ships, the apt, apk, or yum layers underneath the
application, are a separate vulnerability surface that every command above
misses. Where the repository builds an image, scan the built image itself with
`trivy image <ref>` or `grype <ref>`, and treat an out-of-date base image as a
dependency finding rather than a deployment detail.

## Working alongside an update bot

Step 2 of `SKILL.md` decides the scope. These are the commands it needs.

Enumerate what the bot has in flight before planning anything, because every
open bot pull request is a package already claimed:

```sh
gh pr list --author "app/dependabot" --state open --limit 50 --json number,title,url
gh pr list --author "app/renovate"   --state open --limit 50 --json number,title,url
```

Dependabot titles carry the package and both versions, as in
`Bump lodash from 4.17.20 to 4.17.21`, so the package can be matched against the
update plan without opening each pull request.

Reconcile security alerts the run resolves. An alert stays open until the fix
lands, so a run that patches one should say which:

```sh
gh api "/repos/{owner}/{repo}/dependabot/alerts?state=open" \
  --jq '.[] | {number, pkg: .dependency.package.name, sev: .security_advisory.severity, patched: .security_vulnerability.first_patched_version.identifier}'
```

That endpoint needs `security_events` scope, and it returns nothing on a
repository with alerts disabled. Report that as unavailable rather than as no
alerts.

| Situation | Action |
|---|---|
| Bot has an open pull request for a package this run does not touch | Leave it alone. Say it stays with the bot. |
| Bot has an open pull request for a package this run needs to move | Do not bump it in parallel. Either take the bot's pull request as the delivery for that package, or supersede it deliberately and say so. |
| This run supersedes a bot pull request | Name it by number in the summary, then with approval either close it with a comment pointing at the replacement, or post `@dependabot recreate` so the bot rebuilds it against the new base. |
| Bot pull requests go stale after this run merges | `@dependabot rebase` asks for a rebase in place. Renovate's equivalent is ticking the rebase checkbox in its pull request body. |
| Bot is configured but has never opened a pull request | Treat the ecosystem as unowned and keep it in scope. |

Every one of those comments and closures is a GitHub write, so it needs the same
explicit approval as a commit or a push. Dependabot does close its own pull
request once it sees the dependency already satisfied, but only on its next
scheduled run, so leaving it to that means leaving a conflicting pull request
open in the meantime.

## Runtime and platform end of life

A dependency graph can be entirely current while the runtime under it is out of
support and no longer receiving security fixes, which no package audit reports.
Check the language runtime, framework, base image distribution, and database
versions against their published support windows, for example through
`endoflife.date`. Report an unsupported or nearly unsupported runtime as a
finding with the same weight as an advisory.

## Producing an SBOM

Where a policy, customer, or compliance process asks for a software bill of
materials, generate it from the resolved graph rather than the manifest, so it
reflects what actually installs. `osv-scanner` can emit CycloneDX and SPDX, and
`syft <target>` covers both source trees and built images. Treat an SBOM as an
output of this work, not a substitute for the audits above.

## Screening a newly introduced direct dependency

| Check | How |
|---|---|
| Typosquatting | Compare the exact name against the package you meant, character by character, and against the popular package it resembles. |
| Install and build hooks | `npm view <package> scripts` or `pnpm view <package> scripts` for Node; the published `pyproject.toml`, `setup.py`, and entry points for Python; a `build.rs` for Rust. Flag scripts that download remote payloads, decode opaque data, read environment variables, or invoke unexpected shells. |
| Source | Confirm the package resolves from the official registry rather than a URL, Git ref, or local path. |
| Maintainership | Prefer more than one maintainer, an active repository, and a known publisher. Treat a single-maintainer package on a critical path as a risk to record. |
| License | `license-checker` for Node, `pip-licenses` for Python, `cargo deny check licenses` for Rust, `go-licenses check ./...` for Go, `bundle exec license_finder` for Ruby, `composer licenses` for PHP. Flag missing, unknown, or policy-incompatible licenses for review before adding. |
| Provenance | `npm audit signatures` verifies npm's Sigstore-backed provenance and registry signatures for the resolved tree. For PyPI, prefer packages published through Trusted Publishing with PEP 740 attestations. At the same version, prefer the signed and attested package. |
| Transitive reach | `npm ls --all`, `pnpm list --depth Infinity`, `go mod graph`, `cargo tree`, `dotnet package list --include-transitive`. |

For Rust, `cargo deny check` enforces advisory, license, source, and ban policies
where the repository has a `deny.toml`; `cargo geiger` and `cargo vet` are
optional deeper checks. For Go 1.24 and later, track `govulncheck` as a project
tool with `go get -tool golang.org/x/vuln/cmd/govulncheck`, and use its SARIF
output when a security system consumes it.

## Patching a transitive vulnerability

When a vulnerable transitive package has a patched release but its direct parent
has not yet updated, use the ecosystem's scoped override mechanism only after
confirming compatibility.

| Ecosystem | Temporary patched-version mechanism |
|---|---|
| npm | `overrides` in `package.json` |
| pnpm | `overrides` in `pnpm-workspace.yaml` |
| Yarn Berry | `resolutions` in `package.json` |
| pip and uv | A constraints file, or `[tool.uv] constraint-dependencies` |
| Go | `replace` in `go.mod`, or a direct `require` of the patched version |
| Cargo | `cargo update -p <crate> --precise <version>` where existing constraints allow it |
| Maven | `dependencyManagement` |
| Gradle | A dependency constraint or a resolution strategy |
| NuGet | A direct `PackageReference` pin of the transitive package |

For Cargo, reach for `--precise` first. `[patch.crates-io]` is not a
same-registry version override: it redirects a dependency to a different source
such as a Git repository or a local path, applies across the whole workspace,
and is only appropriate when the parent's constraint excludes the patched
release and a reviewed fork is genuinely needed. Record its scope and removal
condition if it is used.

Document why the override exists, the advisory it mitigates, and the condition
for removing it. Remove it when the direct parent ships a compatible patched
release. Do not use an override to conceal an unresolved compatibility failure.

## Leaving protection behind

Anything this run enforces by hand is enforced once. Prefer leaving a control in
place: a minimum release age setting, a Dependabot or Renovate configuration,
and `actions/dependency-review-action` on ordinary pull requests so a new
advisory or a disallowed license fails the pull request without anyone running
an audit.
