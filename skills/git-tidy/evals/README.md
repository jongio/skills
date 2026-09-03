# git-tidy eval

The eval covers content-aware Git work triage and its read-only, fail-closed
safety boundary. Scenarios must verify:

- exact mechanical correlation instead of age-only stash deletion or name-only
  pull request joins;
- seven work outcomes kept separate from explicit per-carrier actions;
- dirty-worktree precedence, durable last-copy witnesses, and drift handling;
- metadata, proof, and opt-in review depth behavior;
- deterministic tests for Node.js 22-or-newer capability fallback to metadata-only;
- unknown remote failures rather than dead-remote guesses;
- read-only analyzer behavior, including no fetch or prune;
- explicit coverage gaps for missing, partial, hostile, or over-budget evidence;
- monotone bounded review that can't strengthen deletion eligibility; and
- separate approvals and established handoffs for every action class.

Tags, artifacts, ignored-but-tracked files, large blobs, remotes, and maintenance
retain their protected behavior. In particular, recovery-destroying maintenance
is never called non-destructive or preselected.

From the repository root:

```sh
npm test --prefix skills/git-tidy
npm run test:coverage --prefix skills/git-tidy
npm run eval:lint --prefix skills/git-tidy
npm run eval --prefix skills/git-tidy
npm run build --prefix site
```

The deterministic suite covers the shipped analyzer plus registration and
safety behavior. Coverage enforces the package thresholds. Eval lint validates
the capability specification, the full eval drives a real agent, and the site
build verifies the public catalog surface.
