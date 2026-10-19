# Test Doctor capability evals

`test-doctor/eval.yaml` contains seven cases: a real shipping-project audit,
test repair, blocked verification, retry interpretation, framework neutrality,
bounded incomplete repairs, and embedded-instruction/production-scope handling.

The shipping fixture uses only built-in Node.js tools and has two passing tests.
Its README independently defines the contract. One assertion accepts any
nonzero fee; exact-cutoff and invalid-input tests are absent. The repair case
must create those protections rather than merely describe them.

Audit cases combine a prompt judge with `diff-empty`; the repair case combines
a written-assertion check with a judge of actual edits and execution evidence.
The two grader types have equal weights and a 0.8 overall threshold, so either
type failing cannot be outvoted by the other. Prompt-only static checks are not
a substitute for executing these capability cases.

From the skill directory:

```sh
npm run eval:lint
npm run eval
```

Capability execution consumes agents. Lint and deterministic tests do not.
