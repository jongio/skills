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

Primary may supply `agentId` to relay an observed restricted agent's report.
The tool records that provenance. A subagent cannot report as another agent.
Report states: `working`, `blocked`, `result_ready`, `failed`, `cancelled`.
There is deliberately no report state named `done`.

Set `requiresOperator: true` only when an operator decision/action is required.
It defaults to false. **Needs attention** contains only explicit operator
requests, observed pending permission/input prompts, and final merge-approval
waits. Ordinary blocked work, failures, and dependency waits belong in
**Blockers & dependencies**, including dependencies owned by another subagent.
Send a newer report without the flag to clear an operator request after it is
resolved. Completed canonical tasks no longer require report-based attention.
Transient native prompts may not be reconstructable after reconnect; the host's
native permission/input UI remains authoritative.

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

Split large milestones into small verifiable canonical tasks, and map explicit
parent/child relationships with `subtasks`. Nested children are supported;
cycles, multiple parents, and cross-goal children are rejected. Percentage is
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
