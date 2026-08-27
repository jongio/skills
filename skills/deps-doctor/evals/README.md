# deps-doctor eval

A Vally capability eval for dependency auditing, updating, and remediation.
Twenty-six scenarios cover nine areas:

- **Discovery:** detect every ecosystem in a mixed-manager workspace, detect the
  surfaces no language package manager owns, defer to Dependabot or Renovate
  where one already owns routine updates, and split scope against the bot's
  in-flight pull requests rather than duplicating a package it already claims, and report a manager that could not be
  audited as blocked rather than implying full coverage.
- **Correctness:** hold the no-op boundary when nothing is outdated, fix
  compatibility breaks forward instead of downgrading, keep a dependency that is
  referenced only at runtime, declare imports that currently resolve only
  through a transitive package, and resolve a peer dependency conflict without
  forcing an unsupported install.
- **Security:** rank an actively exploited vulnerability above a higher-scoring
  but unexploited one, patch a transitive advisory through a scoped override,
  and review a new dependency's supply-chain signals.
- **Supply chain:** withhold a release published minutes ago in favor of one that
  has aged past the minimum-release-age window, flag a dependency resolved from
  a Git ref rather than the registry, and review the resolved graph before
  letting package-authored install scripts run.
- **Progressive disclosure:** configure the release-age gate in the project's own
  package manager using the correct ecosystem-specific key, which is recorded in
  `references/` rather than in `SKILL.md`. A model answering from memory reaches
  for the wrong ecosystem's setting, so passing implies the reference was read.
- **Integrity:** preserve lockfile-integrity gates in CI so the committed
  lockfile is proven to install the way CI installs it, and pin mutable action
  tags and image tags to commit SHAs and digests.
- **Boundaries:** ask before any repository write, refuse repository
  administration outright rather than asking, decline work outside the skill's
  scope, and never discard uncommitted work that was already in the tree when
  the run started.
- **Untrusted input:** treat instructions embedded in repository content as data
  rather than following them.

Scoring uses equal weights across every grader type, with a single eval-level
threshold. Vally decides a trial with `score >= threshold` once a threshold is
set, and its weighted score renormalizes over only the grader types a stimulus
declares, which creates two opposite traps. Prose-heavy weights let a perfect
answer outvote failed behavioral graders. Behavior-heavy weights do the reverse:
in a plan-only stimulus the behavioral graders pass trivially because nothing
was run, so a model recommending exactly the wrong thing still passes. Equal
weights make any single grader failure decisive, as long as a stimulus declares
at most three grader types. `test/registration.test.mjs` replays Vally's own
scoring arithmetic for every stimulus in both directions, and also compiles
every grader regex the way Vally does, so neither trap can return unnoticed.

One consequence is worth knowing when writing a judge prompt. A judge score `s`
on the 1-to-5 scale normalizes to `(s - 1) / 4`, so with `n` grader types and
every behavioral grader passing, the trial scores `(n - 1 + prose) / n`. On a
two-type stimulus only a judge score of 2 or below actually fails; on a
three-type stimulus only a 1 does, because there the two behavioral graders are
the real gate and prose is graded signal rather than the verdict. Write
disqualifying bands to match: say "Score 2 or below" only where that band really
fails, and state a bare score elsewhere rather than promising a verdict the
arithmetic will not deliver. `test/registration.test.mjs` checks every rubric's
stated band against this arithmetic and fails the build on an overpromise.

Every stimulus whose failure mode is observable is graded against something
other than prose. `tool-calls` graders assert that no git or GitHub write
command was issued, `diff-empty` asserts the workspace was left untouched, and
fixture trees force the agent to inspect real manifests instead of answering
from a file list quoted in the prompt.

From the skill root:

```sh
npm install
npm run eval:lint
npm test
npm run eval
```

`npm test` is the deterministic cross-surface registration check and needs no
dependencies. The full eval drives a real agent and is intended for on-demand or
nightly use.
