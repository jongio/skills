# pr

A concise checklist workflow for taking changes from local commit and preflight checks through PR submission, review resolution, CI monitoring, and merge.

## Install

```sh
npx skills add jongio/skills --skill pr --skill test-doctor --skill doc-doctor
```

Reload your agent skills, then invoke `/pr`. Preflight uses `test-doctor` for tests
and `doc-doctor` for the diff and affected documentation. `pr` owns the documentation
pass, including when called by `go`; matching passing evidence is reused, and
later edits invalidate affected evidence rather than triggering duplicate checks.

## Review feedback

The workflow reads full submitted review bodies and PR conversation comments,
not just inline comments and unresolved threads. Copilot can embed actionable
findings inside nested details, including "previously missed" issues in unchanged
code, even when the same review says "No open issues".

Each finding receives an evidence-backed disposition. Duplicate links are
reconciled, older findings are checked against the current head, and body-only
findings receive a PR reply identifying the review and heading rather than a
claim that a nonexistent thread was resolved.

## Review and merge gates

Copilot review is expected by default. Only an explicit user-authorized exception
for a verified private repository with the exact allowed owner skips requesting
and waiting, including already-pending requests. Posted feedback and other
required reviews still apply.

Every expected reviewer must submit a non-dismissed review on the full current
head OID. `COMMENTED` completes a review but is not approval; new pushes invalidate
head-specific review and check evidence. Required approvals and unresolved change
requests remain separate gates.

PR bodies preserve the repository template and record exact validation commands
and results, including checks not run. A merge also requires explicit authorization
or an applicable user-approved standing policy and an up-to-date base, green CI,
and settled feedback. Use a literal `gh pr merge` command naming the PR, repository,
authorized strategy, and full `--match-head-commit` OID, then verify actual merged
state. Auto-merge, admin, API, and wrapper bypasses are not allowed.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

Deterministic tests check portable skill shape, instruction contracts, and
registration. Synthetic capability scenarios cover owner-specific exceptions,
exact-head review completion, authorized pinned merges, documentation preflight,
and feedback including body-only findings; linting them does not establish agent
behavior.

## License

MIT. See [LICENSE](LICENSE).
