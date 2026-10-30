# Progress reporting contract

Discover `session_progress` before use. All calls are bound to the joined
session; do not pass a session path or arbitrary SQL. Read `status` to reconcile
revisions, known agents, task IDs and report sequences. UI actions are read-only.

| Action | Caller | Required fields |
| --- | --- | --- |
| `status` | Any attributed agent | None |
| `refresh` | Any attributed agent | Primary only for `confirmEmpty: true` |
| `goal` | Primary | `goalId`, `title`, explicit canonical `taskIds` |
| `draft` | Primary | `drafts: [{ id, title }]`; never changes canonical tasks |
| `assign` | Primary | Observed `agentId`, active-goal `taskIds` |
| `subtasks` | Primary | `parentTaskId`, canonical child `taskIds` in the active goal |
| `report` | Primary or subagent | Unique `updateId`, increasing `sequence`, `status`, `message`; optional `taskId`, `evidence` |
| `phase` | Primary | `phase`, `status`; verified evidence for merged phases |
| `references` | Primary | Complete owned `prs`/`issues` snapshots; optional verified title/state/head metadata |
| `ci` | Primary | Tracked `reference`, full `headRefOid`, `status`, ISO `observedAt`; paired `passed`/`total` counts and check names when known |

Primary may supply `agentId` to relay an observed restricted agent's report.
The tool records that provenance. A subagent cannot report as another agent.
Report states: `working`, `blocked`, `result_ready`, `failed`, `cancelled`.
There is deliberately no report state named `done`.
Keep one latest report per actor/task/goal; do not truncate live blockers or
sequence guards because many tasks exist. Only historical activity is bounded.
Task reassignment marks previous-owner task reports `superseded` and retires
their operator alerts. Their sequence guards remain, so delayed reports cannot
resurrect old requests when ownership returns.
Goal remapping applies the same retirement to removed task scopes and prunes
agents' assignment IDs against the new membership. Historical reports and
guards remain stored; they are not current operator requests.

Pass the originating `goalId` from the delegation context with reports. Task
membership and an established agent assignment also pin that origin; switching
the active goal does not relabel late reports. New streams with conflicting
task/assignment/goal identities are rejected before sequence reconciliation.
After reassignment, an existing actor/task/goal stream can still resolve its
request using the original `goalId`, subject to current task ownership and
sequence checks. Prior-goal reports do not replace the agent's current-goal
team status. Direct primary reports update team status for the active goal
without moving earlier task assignments. A taskless unassigned
delegate must specify `goalId` once a goal is active. Primary's own reports may
default to the active goal. Before goal activation, session-level reports remain
unscoped and explicit operator requests are still visible.
If a later goal's source read omits an earlier task, its retained goal snapshot
still accepts origin-bound reports under the same membership, ownership, and
sequence checks. These reports amend history without restoring canonical rows,
accepting completion, or replacing current-goal team status. Explicitly removed
or remapped task scopes remain invalid.
After activation, `goalId: null` can continue an existing pre-goal taskless
stream to resolve that request. It cannot create a new unscoped delegate stream
or bypass a task's goal identity.

Set `requiresOperator: true` only when an operator decision/action is required.
It defaults to false. **Needs attention** contains only explicit operator
requests, observed pending permission/input prompts, and final merge-approval
waits. Ordinary blocked work, failures, and dependency waits belong in
**Blockers & dependencies**, including dependencies owned by another subagent.
Send a newer report without the flag to clear an operator request after it is
resolved. Completed canonical tasks no longer require report-based attention.
Transient native prompts may not be reconstructable after reconnect; the host's
native permission/input UI remains authoritative.
Native plan-approval (`exit_plan_mode`) requests are also operator attention;
their completion clears only the matching request, not unrelated permissions.
Root turn cancellation or session shutdown clears pending native prompts, but
not report-based operator requests. A delegate's cancellation cannot clear the
root session's prompts.

Keep a monotonically increasing sequence per reporter/task/goal, starting at 1.
Reuse an update ID only to retry the same logical update. For a revision
conflict or stale report, inspect `status` and reconcile; never overwrite the
entire board or erase a newer blocker. Configuration calls may pass
`expectedRevision` for optimistic concurrency.

Delegate with: active goal, canonical task IDs, acceptance criteria, available
status tool, and instructions to report start, meaningful progress, blocker,
result-ready/evidence, and failure/cancellation. Do not add a timed reporting
model loop. Primary assigns real observed agent IDs; synchronous agents can
report a known active task before assignment, but remain visibly unassigned
until primary reconciles. An existing assignment cannot be claimed by another.

The primary reviews evidence, accepts results, and updates `todos` through the
normal session SQL tool. The extension only reads those canonical rows. Missing
or failed source reads preserve the last-known snapshot and display stale state.
The SDK may return empty rows on a read error; only use `confirmEmpty` after an
independent canonical read proves tasks were actually removed.
Confirmation removes deleted active-goal cards, assignments, related reports,
and hierarchy edges; archived goal snapshots remain available.

Split large milestones into small verifiable canonical tasks, and map explicit
parent/child relationships with `subtasks`. Nested children are supported;
cycles, multiple parents, and cross-goal children are rejected.
Goal remapping cannot split an existing hierarchy; explicitly detach child edges
with `subtasks` before moving tasks between goals. Percentage is
verified done leaf tasks / total leaf tasks; parent milestones show roll-ups
without counting the work a second time. Accepting children does not
automatically accept the parent or change its canonical status. Update each
canonical task promptly when verification finishes instead of batching
completion until the end of a large milestone.

Delivery phases: `planning`, `testing`, `implementing`, `reviewing`, `delivery`,
`ci`, `remediation`, `awaiting_review`, `awaiting_merge_approval`, `merged`,
`cleanup_pending`, `blocked`. Status is `running`, `waiting`, `blocked`, or
`done`. `merged` and `cleanup_pending` require `verified: true` plus `evidence`
from the owning `pr` workflow. Never infer merge from tool success or green CI.

Example report:

```json
{"action":"report","updateId":"parser-check-1","taskId":"parser-tests","sequence":1,"status":"blocked","message":"Waiting for the fixture contract"}
```

Each invocation reuses the loaded provider. A resumed session rehydrates
canonical data because task invalidations are ephemeral. One runtime bundle
serves independently scoped providers/state; it is not a shared global daemon.
Older hosts lacking caller attribution cannot write reports; use observed
lifecycle information and a primary text fallback rather than bypassing identity.

## Active work and CI

The board mirrors successful `session_prs`/`session_issues` list/add/remove/clear
results through the SDK post-tool hook. A confirmed `session_statusline clear`
also clears the board's reference view, not its tasks, agents, or work. Only
entries with explicit `owned: true` are imported. No shell text, PR body,
closing link, example, or another session's tracking is enrollment evidence.
Successful command and tool membership changes also publish a transient
session-local invalidation. It only requests fresh `list` results through the
host's native tool pipeline; its text or payload cannot supply ownership,
targets, or arbitrary tool names. Concurrent invalidations coalesce, and a
change during a read schedules a fresh follow-up. Native tool hooks do not
wait on nested tool reads. Standalone issue controls use the same signal.
Refresh requests current tracking as well as canonical plan/tasks; no periodic
tracking or GitHub poller is added. Unsupported, denied, failed, or malformed
reads preserve the last-known data with an unverified source label.

When tracking controls are unavailable, disclose that source limitation; do not
claim an empty verified list. Primary may supply only explicitly owned current
work through `references`, never search-derived targets. An unavailable source
retains the last-known snapshot with an unverified label.

Each reference uses `owner/repo#number`, a matching credential-free HTTPS URL
when supplied, `owned: true`, and optional title/state metadata. PR metadata may
include its verified full `headRefOid`. Different GitHub hosts remain distinct;
use the full PR URL when qualified names are ambiguous.

CI is fed by the existing `pr` watcher/controller, not another background poller.
Before publishing CI, synchronize the current PR head through `references`.
Then publish `ci` with that exact OID and the verified observation timestamp.
Older observations and wrong-head data are rejected. A changed head resets CI
to unknown; passed requires a complete non-empty inventory with all checks
accepted and no pending/failed names. A failed API read is unknown, not passed.
Freshness is displayed explicitly; Refresh reads canonical session sources,
not an independent GitHub polling loop.

If a target was manually removed or cleared, a CI update must not re-enroll it.
Continue text reporting until new work or an explicit request owns it again.
