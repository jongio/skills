# Test Doctor capability evals

`test-doctor/eval.yaml` contains nine cases: a real shipping-project audit,
test repair, effect-outcome repair, a read-only negative control, blocked
verification, retry interpretation, framework neutrality, bounded incomplete
repairs, and embedded-instruction/production-scope handling.

The shipping fixture uses only built-in Node.js tools and has two passing tests.
Its README independently defines the contract. One assertion accepts any
nonzero fee; exact-cutoff and invalid-input tests are absent. The repair case
must create those protections rather than merely describe them.

The effects fixture is a synthetic single-use voucher flow. Only
`src/redeem.mjs` is presented as changed; unchanged transport and store helpers
decide retries, fallback, cancellation, and how errors map to applied, no-effect,
or unknown outcomes. Its original tests are green with about 90% line coverage
yet detect none of eight seeded regressions. The effect repair case scores the
agent's tests by copying the workspace, applying each mutant, and requiring the
tests to pass unmodified and kill at least seven of eight. The read-only case
scopes the same fixture to `src/report.mjs` and fails if new tests import the
redeem or transport modules. `test/effects-fixture.test.mjs` runs both graders against
the original tests and the reference tests in `test/oracles/effects.mjs`.

Audit cases combine a prompt judge with `diff-empty`; repair cases combine
written-assertion or `run-command` checks with a judge of actual edits and
execution evidence. Grader types have equal weights and a 0.8 overall
threshold, so any single failing type cannot be outvoted by the others.
Prompt-only static checks are not a substitute for executing these cases.

From the skill directory:

```sh
npm run eval:lint
npm run eval
```

Capability execution consumes agents. Lint and deterministic tests do not.
