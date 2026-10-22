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

## Base updates

Being behind base alone does not trigger a rebase, merge from base, or
update-branch operation, before submission, during monitoring, or before merge.
Preserve the PR head and existing CI/review evidence while checks are pending or
passing. Update only for confirmed merge conflicts or a verified enforced
up-to-date requirement blocking this PR; use rebase only when necessary to clear
that blocker. Resolve confirmed conflicts even after submission.

Unknown mergeability or unavailable policy evidence requires bounded rechecking
or a blocker report, not a speculative update. A required merge queue alone
does not justify updating the branch. Before a necessary update, record the
blocker and target base OID and recheck that the blocker still applies; batch
known fixes into the same push where practical. Repeated updates require fresh
evidence, and every changed head needs invalidated checks and expected reviews
again. Never bypass required freshness checks or force-push shared branches
without explicit confirmation.

## Merge choice

The default is to ask for final merge approval once all readiness gates pass:

```text
/pr
/pr --merge=approval
/pr --merge=auto
```

Use `--merge=auto` (or "auto merge") to authorize merging without another merge
prompt after all CI, reviews, approvals, and feedback gates pass. Use
`--merge=approval` (or "ask me before merging") to require final confirmation.
A validated `go` handoff carries the user's choice; a later explicit choice
overrides it. Conflicting choices require clarification. This is invocation-only,
not a saved preference; standing policies and reviewer approvals do not override
the default.

In approval mode, the final prompt identifies the PR, repository, full head OID,
and strategy and offers "Merge this head", "Auto merge for this invocation", or
"Not yet". Declined or unavailable confirmation pauses delivery as awaiting merge
approval, not merged. A changed head or strategy requires fresh confirmation.
Auto mode skips only this prompt, not publication or other approval boundaries.
It does not enable GitHub's `--auto` queue.

Both modes default to **squash merge and delete the PR branch afterward**.
Explicitly request another strategy or keeping the branch to override either
default. If squash is unavailable, the workflow asks rather than silently
switching strategies. The final prompt includes cleanup.

Merge without `--delete-branch`; cleanup is a separate step after GitHub confirms
the intended head merged. For a required merge queue, first verify its configured
strategy matches the authorized strategy. Queue admission is not a completed
merge and never permits early cleanup or bypassing review, CI, or consent gates.

Verify the head repository, remote, and branch, including fork identity. Delete
remote and local refs only with atomic expected-OID guards using the original
PR head OID, not the squash/merge commit:

```text
git push --force-with-lease=refs/heads/<branch>:<merged-head-OID> <verified-head-remote> :refs/heads/<branch>
git update-ref --no-deref -d refs/heads/<branch> <merged-head-OID>
```

The local branch must be non-symbolic and not checked out in any worktree.
Never delete a base/default branch or an advanced head, replace the expected OID
to retry a failed guard, force-delete a branch, remove a worktree, or discard local
changes. Verify local and remote deletion separately. Already-absent refs need no
deletion; blocked or unavailable safe cleanup is reported as "merged with cleanup
pending", not successful deletion.

## Progress and blocked work

During long-running execution, report the current stage, elapsed time, last
meaningful result, and next event at least every 60 seconds. Use host notifications
or scheduling instead of tight polling. Distinguish running checks from external
review/CI waits and approval/input blockers; identify the exact pending decision
and state when execution is paused. Wall-clock waiting is not active execution,
and an unknown completion time is not an ETA.

If a stage exceeds its documented runtime budget or stalls, inspect bounded
evidence and report the blocker. Do not restart expensive checks, weaken gates,
or redesign the workflow without authorization.

## Review feedback

The workflow reads full submitted review bodies and PR conversation comments,
not just inline comments and unresolved threads. Copilot can embed actionable
findings inside nested details, including "previously missed" issues in unchanged
code, even when the same review says "No open issues".

Each finding receives an evidence-backed disposition. Duplicate links are
reconciled, older findings are checked against the current head, and body-only
findings receive a PR reply identifying the review and heading rather than a
claim that a nonexistent thread was resolved.

Reply to every actionable comment and finding, including Copilot review bodies.
For each fix, use one short sentence or bullet with a clickable link to the actual
fixing commit and a brief description; omit long validation summaries and verbose
resolution reports. Related body-only fixes may share a reply if each remains
identifiable by review ID and heading. Unfixed or disputed findings get a concise,
evidence-backed disposition, never an invented fixing commit. Replies do not
replace resolving addressed bot threads or the existing review and merge gates.

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
and results, including checks not run. A merge also requires authorization under
the selected merge mode, no merge conflicts, applicable enforced base-freshness
or merge-queue requirements, green CI,
and settled feedback. Use a literal `gh pr merge` command naming the PR, repository,
authorized strategy, and full `--match-head-commit` OID, then verify actual merged
state. GitHub auto-merge, admin, API, and wrapper bypasses are not allowed.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

Deterministic tests check portable skill shape, instruction contracts, and
registration. Synthetic capability scenarios cover owner-specific exceptions,
exact-head review completion, authorized pinned merges, documentation preflight,
progress and approval waits, and feedback including body-only findings; linting
them does not establish agent behavior.

## License

MIT. See [LICENSE](LICENSE).
