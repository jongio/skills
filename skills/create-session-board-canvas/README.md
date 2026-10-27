# create-session-board-canvas

A live read-only session board: kanban, canonical completion percentage,
primary/subagent team, blockers, ready-next tasks, plan, goal history, and
delivery/approval status. No coordinator agent or background model loop.
Active work shows explicitly session-owned PRs/issues, safe links, and
head-pinned CI summaries with their observation time.

## Install

```sh
npx skills add jongio/skills --skill create-session-board-canvas -g --agent github-copilot
```

The aggregate or individual skill plugin discovers the bundled Copilot
extension. For a plain skill-only installation, preview a thin user loader:

```text
node <installed-skill-dir>\scripts\setup.mjs --dry-run
node <installed-skill-dir>\scripts\setup.mjs --approve <displayed-hash>
```

Approve that exact preview, reload extensions, then ask:

```text
Create a canvas that shows session progress
```

One bundle supplies code/assets for all sessions. Only lightweight JSON is
stored in each session workspace at `files\session-progress\board.json`
(session-scoped storage is used when workspace support is absent). State lasts
as long as that session and survives panel reopening and extension reload.
Re-run setup after moving/reinstalling a plain skill; never overwrite an
unowned loader. No per-session runtime copies, global daemon, or remote store.

## Sources and reporting

The current session's plan and SQL `todos`/`todo_deps` remain canonical. Agents
use `session_progress`; primary verifies results before changing canonical task
status. Reports of `result_ready` do not mean accepted work. Task percentage
is done/total leaf tasks; parent milestones show subtask roll-ups without
double-counting. No-task progress is unknown, and 100% tasks does not mean merged.

**Needs attention** is reserved for operator decisions/actions. Agent blockers,
task failures, and dependency waits appear separately in **Blockers & dependencies**,
with ownership and cross-subagent links. Reports default to
`requiresOperator: false`; explicit operator requests clear when superseded.

All task titles stay visible. Expand a task for its ID, parent, and full reports;
delivery evidence, activity, and the plan stay collapsed until requested.

Successful session PR/issue controls mirror their explicitly owned targets into
Active work. CI is a verified, head-pinned snapshot published by the existing
PR workflow, with an observation time; the board does not start another poller.
Wrong-head, stale, and incomplete green snapshots are rejected. Unknown tracking
or CI is labelled unknown rather than shown as an empty verified list.

See the [reporting contract](references/reporting.md) for action fields,
ownership, sequences, assignments, relays, and delivery phases. Each new goal
gets an explicit task mapping; earlier goal history is retained.

## Supported hosts and recovery

Requires a Copilot host with canvas/extension support, plan/todo RPC readers,
and runtime-attributed tool callers. Verified against CLI 1.0.104. Hosts without
those capabilities use text progress; the skill never blocks `go` merely
because the board is unavailable. Already-running or read-only agents may lack
the reporting tool: primary relays their returned reports with provenance.

Source failures/ambiguous empty reads retain the last snapshot and show stale
state. Refresh or reconnect rehydrates canonical sources. Do not confirm an
empty read without independently verifying canonical task removal.

The session provider uses a local OS-owned IPC lease so duplicate loaders do
not register duplicate tools. On Windows/Linux the lease disappears with its
process. On other Unix hosts an unclean termination may leave a socket under
the system temporary directory; fail closed and restart/clean that exact stale
socket only after verifying no provider is running. It carries no session data.

No automatic PR/issue enrollment, permission escalation, task edits from the UI,
model API calls, or cross-session scans. Generic canvas apps belong to
`create-canvas-app`; footer management belongs to `session-statusline`.

## Development

```text
node --test --test-concurrency=1 skills\create-session-board-canvas\test\*.test.mjs
node skills\create-canvas-app\scripts\check-kit-freshness.mjs skills\create-session-board-canvas\runtime
```

Use the repository's locked Vally toolchain for skill/eval lint. Capability evals
require separate authorization; deterministic tests do not prove agent routing.

## License

MIT. See [LICENSE](LICENSE).
