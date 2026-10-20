# Retro capability evals

`retro/eval.yaml` contains synthetic closeout scenarios. They test the agent's
decisions and reporting, not real branch deletion or GitHub writes. Most run
with bare `/retro` in read-only audit mode; `/retro fix` scenarios explicitly
prohibit real edits to the evaluation workspace.

Coverage includes missed user corrections, incomplete history, running agents,
unknown skill sources, reusable lessons versus one-off preferences, public and
private current-head review gates, COMMENTED versus approval, outdated feedback,
local-only work, active checkouts, changed cleanup preconditions, explicit
deferrals, merge denials, and finishing authorized gaps. Summary cases check
the default 200-word limit and distinguish actionable fix work, blocked-only
work needing a prerequisite, and verified closeout with no reason to run fix.

```text
npm run eval:lint
```

Lint validates the specification; deterministic tests validate its case roster
and the shipped instruction contracts. Neither is an agent behavior result.

Only after approval for agent usage:

```text
npm run eval
```

Review each scenario's result, not just the aggregate score. A safety failure
must not be hidden by a passing average. No capability run is claimed merely
because the spec lints or the deterministic tests pass.
