---
author: "@jongio"
status: approved
---

# deps-doctor

## Problem

Dependency maintenance is the most routine job in a repository and the one most
often done badly, because doing it properly and doing it carelessly look
identical right up until something breaks.

The careless version is familiar. Someone runs `npm outdated`, bumps everything
to latest, watches the tests pass, and opens a pull request. What that passing
run does not tell them: one of those releases was published forty minutes ago
and has not been on the registry long enough for a compromised publish to be
noticed and pulled. A routine minor bump quietly pulled a new transitive package
into the graph that ships a postinstall script, and that script has already run
on their laptop with an SSH agent and cloud credentials in scope. The
repository's Dockerfile still pins a base image from eight months ago, its
GitHub Actions sit on floating tags that whoever controls them can move, and its
Terraform providers have not moved at all, because no language package manager
reports any of those as outdated. Meanwhile a dependency that is loaded by name
from a config file looks unused to every static checker, so a tidy-up sweep
removes it and breaks logging in production.

The over-cautious version fails differently. Someone runs the audit, finds
nothing outdated, and opens an empty pull request anyway to show the work
happened. Reviewers learn to ignore dependency pull requests, which is worse
than not opening one.

Both failures come from treating a dependency update as a version bump rather
than a supply-chain decision. The information needed to decide well is scattered
across a dozen package managers with incompatible commands, settings whose units
disagree with each other, and advisory data whose severity label is often the
least useful field in it.

## Goals

- Find every dependency surface in a repository, including the ones no language
  package manager reports, and say plainly which ones could not be audited.
- Make the safe path the default path: resolve with lifecycle scripts disabled,
  review what changed, then install.
- Decide which version to adopt on evidence, weighing release age, exploitation
  data, and supply-chain signals, rather than defaulting to latest.
- Fix compatibility breaks forward, never by downgrading and never by forcing an
  install the package authors declared incompatible.
- Leave durable protection behind, so the next install is safer even if nobody
  ever runs this again.
- Never produce an empty dependency pull request, and never make a repository
  write without explicit approval.

## Non-Goals

- Autonomous dependency updates. Every git and GitHub write stays behind
  explicit approval.
- Replacing Dependabot or Renovate. Where a bot already owns routine bumps, the
  skill works the remainder rather than competing for the same manifests.
- A general source-code security review. Vulnerability work here is scoped to
  the dependency graph.
- Adding a brand-new package to a project. That is a one-line install, not a
  maintenance pass, and routing it here would start a sweep nobody asked for.
- Executable helper scripts. The skill is guidance plus evaluations; the only
  shipped code is the deterministic registration test.

## Solution

A guidance skill structured as a nine-step workflow, plus a capability
evaluation suite that grades behavior rather than prose.

**Detection covers two categories.** Seventeen language package managers, and
the surfaces that pin third-party code with no manager watching them: container
base images, GitHub Actions versions, Terraform providers and modules, dev
container features, and pre-commit hook revisions. Ownership of a tree resolves
in precedence order, lockfile first, then `packageManager`, then manager
configuration, then manifest contents, because a bare `package.json` may be pnpm
or Yarn and a bare `pyproject.toml` is evidence of neither Poetry nor uv. A
manager whose executable is missing is reported as blocked, so a partial audit
never reads as a clean one.

**Selection precedes application.** Step 4 chooses target versions and step 5
applies them. That ordering is what makes the release-age gate workable: a
version withheld for being too new is never installed and then walked back,
which would collide with the rule against downgrading. It also means the bulk
update-to-latest commands are correct only when nothing was held back, so the
skill carries an explicit-version apply path for when something was.

**Release age is enforced through the package manager wherever possible.** A
configured `min-release-age`, `minimumReleaseAge`, `npmMinimalAgeGate`, or
Dependabot `cooldown` protects every later install and every contributor, not
just this run. The units disagree between ecosystems, days in one and minutes in
another, which is a trap worth naming rather than leaving to chance. A
vulnerability fix can justify bypassing the window, but on exploitation evidence
and reachability rather than automatically, since adopting a minutes-old release
to close a low-severity unreachable advisory trades a small known risk for a
larger unknown one.

**Severity labels do not set priority.** A High finding in CISA's Known
Exploited Vulnerabilities catalog, or one with a high EPSS score, outranks an
unexploited Critical. Ecosystem-native audits run per detected manager, and
`osv-scanner` supplements them specifically for its `MAL-` entries, which report
known-malicious packages that the native audits do not carry at all.

**Installs are treated as code execution, because they are.** Resolution happens
first with lifecycle scripts disabled, the resolved graph is reviewed for
install hooks and non-registry sources across every package whose version or
source moved, and only then does a real install run. That phase belongs in a
disposable sandbox with no credential mounts and no network access once
package-authored code is allowed to run, because reading a repository first does
not constrain what a build hook can reach.

**The no-op gate is the last thing before any write.** If no dependency-bearing
file gained a real version, immutable pin, or policy change, the run ends with a
report and nothing else. Reverting incidental lockfile noise reverts only the
hunks this run produced, never a whole file that already carried the user's own
uncommitted work.

**Progressive disclosure keeps the instructions followable.** The workflow and
its decision rules live in `SKILL.md`; per-ecosystem command tables, settings,
and checklists live in two reference files the skill is told to open rather than
guess from. This also keeps `SKILL.md` under the 500-line limit that skill
linting enforces.

**The evaluation suite grades actions, not descriptions.** Twenty-five
fixture-backed stimuli, with `tool-calls` graders asserting no repository write
occurred, `diff-empty` asserting the workspace is untouched, and `file-matches`
asserting the manifest really changed the way it should have. Fixture trees make
the agent inspect real manifests instead of answering from a file list quoted in
the prompt.

## Alternatives Considered

- **Tell people to use Dependabot or Renovate and stop there.** Rejected as
  insufficient rather than wrong. Bots are excellent at routine bumps and cannot
  do the rest: a major upgrade needing code changes, a transitive advisory
  needing a scoped override, an ecosystem or directory missing from the bot's
  configuration, or a first pass on a repository that has no bot at all. This
  skill is built to work around an active bot rather than duplicate it.
- **Ship a deterministic CLI instead of a guidance skill.** Rejected. The
  judgement calls are the whole value and they do not mechanize: whether a
  package that looks unused is reachable through runtime configuration, whether
  an advisory is exploitable in this application, whether a compatibility break
  has a forward fix. A CLI would either encode those as brittle heuristics or
  hand them back to a human anyway.
- **Apply updates and open the pull request unattended.** Rejected. The
  operation runs package-authored code and rewrites the dependency graph. The
  approval gate is the feature, not friction wrapped around it.
- **Put every command table inline in `SKILL.md`.** Rejected on two counts: it
  breaches the 500-line limit skill linting enforces, and a document that long
  is followed less reliably than a short one that defers its lookups.
- **Grade the evaluations on the written answer alone.** Rejected. The failure
  this skill most needs to catch is an agent that describes the no-op gate
  correctly and then opens an empty pull request. Only a grader that inspects
  the trajectory and the workspace can tell those two apart.
- **Add a helper script to detect managers deterministically.** Rejected as
  disproportionate. Detection is a file-existence check the agent already
  performs reliably, and a script would add a maintenance surface, a test
  surface, and an install step for no behavioral gain.

## Acceptance Criteria

| ID | Criterion |
|----|-----------|
| AC-1 | Detects every dependency ecosystem present in a workspace, including surfaces no language package manager owns, and reports a manager whose executable is missing as blocked rather than omitting it. |
| AC-2 | Defers to an active Dependabot or Renovate configuration, confirms the bot is really opening pull requests, enumerates what the bot has in flight so a package with an open bot pull request is not bumped in parallel, names any bot pull request this run supersedes, and states which scope it took and which it left. |
| AC-3 | Reconciles declared packages against real imports, and keeps a dependency that is referenced only through configuration or runtime loading. |
| AC-4 | Resolves updates with lifecycle scripts disabled, reviews every package whose version or resolved source changed, then installs normally. |
| AC-5 | Withholds releases inside the minimum release age window, prefers a package-manager-enforced setting over a manual date check, and weighs any vulnerability-driven exception on exploitation evidence, reachability, and exposure rather than bypassing the window automatically. |
| AC-6 | Ranks vulnerabilities by exploitation evidence rather than the nominal severity label alone, using ecosystem-native audits plus a cross-ecosystem malicious-package pass. |
| AC-7 | Screens every newly resolved package for source, advisories, and executable install hooks, and applies the full maintainership, license, provenance, and typosquat review to new direct dependencies and to new transitives that ship a hook, resolve off-registry, or land on a critical path. |
| AC-8 | Fixes compatibility breaks forward, never downgrading or reverting a dependency to avoid the fix, and reports a blocker instead of silently holding back. |
| AC-9 | Resolves peer dependency conflicts by finding a compatible version set or holding the package back, never with `--force` or `--legacy-peer-deps`. |
| AC-10 | Validates with a frozen-lockfile clean-room install as well as the project's own checks. |
| AC-11 | Makes no branch, commit, push, or pull request without a meaningful change to a dependency-bearing file, meaning a dependency version, an immutable pin, or a dependency policy, and verifies a pushed pull request is non-empty. |
| AC-12 | Requests explicit approval before any git or GitHub write, and refuses the forbidden repository-administration operations outright. |
| AC-13 | Treats manifests, READMEs, registry responses, advisories, and tool output as untrusted data rather than instructions. |
| AC-14 | Patches a transitive vulnerability through the ecosystem's scoped override mechanism with a documented removal condition. |
| AC-15 | Declines requests outside its scope, such as adding a single brand-new package or reviewing unrelated source code. |
| AC-16 | Registers across README, `marketplace.json`, `plugin.json`, the site catalog, the eval matrix, thumbnails, and the sibling companion-file set. |

## Risks & Rabbit Holes

- **Breadth diluting depth.** Twenty-one dependency surfaces in one skill risks a
  reference table nobody reads. The safety discipline stays in the workflow prose
  and applies to every ecosystem; per-ecosystem detail stays in tables and short
  command blocks under `references/`.
- **Release-age settings are new and still moving.** `min-release-age`,
  `minimumReleaseAge`, `npmMinimalAgeGate`, and Dependabot `cooldown` all shipped
  recently, their units differ, and their names and defaults have changed. The
  skill instructs verifying the option against the installed version rather than
  asserting a fixed default.
- **Progressive disclosure depends on the references actually being opened.**
  Moving commands out of `SKILL.md` is what keeps it followable, but it only
  works if the agent reads them. One evaluation stimulus is deliberately set in a
  less common ecosystem where the correct configuration key is one a model tends
  to get wrong from memory, so passing it implies the reference was consulted.
- **Evaluation scoring can silently invert.** The scoring engine resolves a trial
  on the aggregate weighted score once a threshold is set, renormalized over the
  grader types a stimulus declares. Prose-heavy weights let a well-written wrong
  answer survive failed safety graders; behavior-heavy weights let a wrong answer
  survive because the negative guards passed by inaction. Equal weights keep
  every grader decisive, and the registration test replays that arithmetic so
  neither direction can return unnoticed.
- **Registration drift.** Seven files outside the skill directory have to agree.
  The deterministic registration test asserts all of them, including thumbnail
  byte parity and eval matrix shape, so drift fails CI rather than reaching the
  catalog.
- **Out of scope: the `skill-lint.yml` shared-surface blind spot.** The workflow
  selects no skill to lint when a pull request touches only `marketplace.json` or
  the site catalog, so a registration-breaking edit can pass CI unexamined. It is
  a real gap, but it belongs to the workflow rather than to this skill and should
  be fixed in its own change.
