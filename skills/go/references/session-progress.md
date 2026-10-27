# Session progress in go

After resolving worktree choice and before substantial execution, invoke
`create-session-board-canvas`. Reuse its loaded provider and stable panel
handle. If the skill/provider/canvas support is missing or setup is declined,
state that once and continue with canonical tasks and a text progress view.
This optional presentation fallback does not waive required implementation,
test, review, authorization, or merge gates.

Use the approved plan and current session SQL todos/dependencies. Explicitly map
task IDs into a stable goal; do not infer scope from timestamps or unrelated
plans. Repeated `go` for the same goal reuses it; a new request gets a new goal
on the same board with retained history. Preserve a manual panel closure until
explicit reopening or the next invocation.

Primary owns configuration, task acceptance, and phase updates. Every delegate
receives goal identity, assigned task IDs, reporting tool availability, and the
new skill's reporting contract. Tool-capable delegates report directly;
restricted delegates keep their tool permissions and primary relays their
returned reports with provenance. Lifecycle events show actual team activity.

Report meaningful work/blocker/result changes and phases for planning, tests,
implementation, and review. Result-ready is not accepted completion: verify
first, then update canonical tasks. A status service is not a coordinator agent.
Split large milestones into verifiable canonical subtasks, map their parent
hierarchy, and accept/update each promptly. Percentages count leaf tasks, not
both parents and children; reports and elapsed time are not completion evidence.
When scope expands, map its approved canonical subtasks before implementation,
not only at the end of the milestone.
Never spawn agents or recurring model prompts merely to maintain the board.

Pass board/goal identity and the reporting contract into `pr`. It owns delivery
updates, including CI, review waits, remediation, merge approval, verified
merge, and cleanup pending. Task completion can be 100% while delivery awaits
approval. Neither agent completion, a passing command, nor green CI proves merge.

Hydrate Active work from explicit session-owned PR/issue controls when available.
Their successful operations mirror into the board without changing enrollment.
Pass the same references and verified head context to `pr`; it publishes CI
snapshots from the existing watcher. Unknown tracking/CI stays unknown, and
manual clear/remove is never undone merely to populate the board.
