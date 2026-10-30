# Optional session board handoff

When a `go` handoff includes a live session-progress board/goal, reuse it.
Do not install/recreate another board or require this dependency for direct `pr`.
Follow the [shared reporting contract](../../create-session-board-canvas/references/reporting.md).

Primary reports `delivery`, `ci`, `awaiting_review`, `remediation`, and
`awaiting_merge_approval` as those states are actually observed. Report blockers
and meaningful changes using `session_progress`; delegates report results
without changing canonical task acceptance. Keep the existing watcher and
status updates; do not add another poller or coordinator agent.

List the session's explicit PR/issue controls when available. They mirror owned
targets into Active work; never adopt targets from comments, body references,
or closing links alone. Publish verified `references` metadata for the active
PR, including the full current head. After every push, update that head before
publishing CI so old green snapshots are invalidated immediately.

For each meaningful watcher snapshot, publish `session_progress` `ci` with the
tracked reference, matching full head OID, actual status/counts/check names,
and its ISO observation timestamp. Incomplete/failed inventory is unknown,
not zero-of-zero passed. Do not start a second GitHub poller, parse footer glyphs,
or re-enroll a manually removed target to make a CI update succeed.

Only publish `merged` with `verified: true` and actual GitHub merge evidence
after the intended head is verified merged. Queue admission and successful
commands are not merge evidence. If cleanup remains, publish `cleanup_pending`
with verified merge evidence and describe the remaining work. Related issue
reconciliation and cleanup remain governed by the existing PR workflow.

Unavailable reporting tools use the existing text status view. Never weaken
reviews, CI, head-pinned approval, issue reconciliation, or safe cleanup.
