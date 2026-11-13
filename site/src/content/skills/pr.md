---
title: pr
tagline: "A concise checklist workflow for taking changes from local commit and preflight checks through PR submission, review resolution, CI monitoring, and merge."
useWhen: "PR checklist, prepare a PR, submit a PR, monitor a PR, address PR feedback, merge a PR"
repoPath: skills/pr
thumb: images/thumb-pr.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill pr --skill test-doctor --skill doc-doctor"
---

## What it does

A concise checklist workflow for taking changes from local commit and preflight checks through PR submission, review resolution, CI monitoring, and merge.

Requires `test-doctor` and `doc-doctor`. Before committing, `pr` audits modified
and untracked files against the final chosen approach to strip superseded
scaffolding, dead flags/helpers, and stray debug or secret files so only the
minimal complete change is committed. PR preflight owns the documentation pass,
including when called by `go`, and reuses matching passing evidence (including
`go`/`test-doctor` test evidence and `go` Step 4's diff + repository-local
`code-review` skill in local/branch mode or bounded, read-only
cross-model `rubber-duck` sub-agent review covering scope minimality,
cross-file CLI/function call contracts, lifecycle/state-machine symmetry, and
fail-closed mutations, or running them when invoked directly
without `go`; documentation-only `doc-doctor` edits do not invalidate passing
code-review or `test-doctor` evidence).

Preserves the PR template and records exact validation commands and results.
Expects Copilot review unless `--no-copilot` (`"copilotReview": false` in `.github/repo-maintain.json` / `repo-maintain` or explicit user instruction, which also cancels auto-triggered `Copilot Code Review` workflow runs so zero Actions minutes are billed) or an explicitly authorized, verified private-owner
exception applies; posted feedback remains in scope. Every expected review must
complete on the full current head OID, with `COMMENTED` distinct from approval.
Merges require authorization and all gates satisfied, use a literal head-pinned
command, and verify actual merged state rather than enabling GitHub auto-merge.

Being behind base alone never triggers a rebase, merge from base, or update-branch
operation. Preserve the head and CI/review evidence unless confirmed merge
conflicts or a verified enforced up-to-date requirement blocks the PR; use rebase
only when necessary to clear that blocker. This applies before submission,
during monitoring, and before merge. Unknown mergeability calls for bounded
rechecking, not speculative updates; a required merge queue alone is not a reason
to update. Necessary updates require fresh blocker evidence and new-head checks
and reviews, without bypassing freshness requirements or shared-branch safeguards.

Batch related repairs before requesting reviews; normally wait for applicable
current-head CI to pass. Final-head review and approval gates remain unchanged.
After two unsuccessful repair cycles for the same failure, pause with diagnostic
evidence rather than continuing speculative pushes.

For each new CI-ready review round, inventory paginated submitted review history
and retain all prior human reviewers in the expected roster across pushes and
resumptions, not only pending or required reviewers. Request or re-request them
individually, except those already pending or with a valid submitted review on
that full head. Recheck the full head and CI before each request. On resume,
rebuild and deduplicate from live pending requests
and full-head submitted reviews, not conversation memory; pending requests
persist across pushes. Verify requests after writing, not every poll, and never
re-request pending or completed reviewers. Exclude the PR author and bots;
Copilot keeps its separate request and exception policy. An unrequestable
reviewer or failed request is a blocker to report, not a reason to silently drop
a reviewer or prevent requesting other eligible reviewers. Recheck live state
before retrying unknown request outcomes. New pushes need new-head reviews
without waiving required approvals or active changes-requested decisions.

Deduplicate underlying findings across review rounds. The watcher groups exact
repeats from the same reviewer and retains source review IDs and dispositions.
Heading-only advisories are not findings; new evidence and active
`CHANGES_REQUESTED` decisions still block. Reconcile paraphrases manually and
update one consolidated disposition instead of posting repetitive acknowledgments.
An old disposition must be revalidated after a later review before it settles
that renewed concern, explicitly citing its review ID. Unrelated edits do not
revalidate another concern.
For long prose or ambiguous titles, cite the review ID and the exact `concern:...`
token from `unsettledConcernDetails`; full evidence and local context remain
available without requiring a verbatim reply. Critically evaluate every reviewer
and Copilot suggestion before editing code: distinguish concrete bugs, security
boundary violations, or broken contracts in touched code from speculative
hypotheticals for impossible or already-guarded inputs; reject over-engineered
state machines, locks, duplicate validation layers, wrapper helpers, config
knobs, or extra abstractions when simpler code or no change suffices; and fix
confirmed defects with the smallest surgical change rather than copying an
over-complicated suggested patch verbatim. When re-auditing `Needs a closer look`
prose warnings, change code only if a concrete defect is confirmed, otherwise
recording a terse evidence-backed disposition without speculative guards. When
an automated/Copilot thread is declined on merit, reply tersely citing the
invariant or `file:line` and resolve the automated/bot thread on GitHub rather
than writing bloatware just to turn it green, while keeping human threads with
open questions open.

## Install with required skills

The single-skill options above do not install dependencies. Use this command
to install `pr` and every required skill, or choose the full collection.

```sh
npx skills add jongio/skills --skill pr --skill test-doctor --skill doc-doctor
```

## Use it

```text
/pr
/pr --merge=approval
/pr --merge=auto
```

By default, `pr` asks for final merge approval with the PR, repository, full head
OID, and strategy after readiness gates pass. Choose `--merge=auto` (or "auto
merge") to skip only that final prompt; `--merge=approval` (or "ask me before
merging") requires it. A validated `go` or `repo-maintain` handoff (`"autoMerge": true`) preserves the choice, and a later
explicit user choice overrides it. Choices apply only to the current invocation;
standing policies and reviewer approvals do not override the default.
Changed heads or strategies require fresh confirmation in approval mode.
Declined or unavailable confirmation leaves the PR awaiting approval, not merged.
Auto mode preserves all CI, review, feedback, and other approval gates and does
not enable GitHub's `--auto` queue.
Both modes default to squash merging and deleting the PR branch afterward,
unless explicitly overridden. Merge without `--delete-branch`, then perform
separate cleanup with atomic expected-OID guards using the original PR head.
Verify the head repository and branch, and leave checked-out local branches alone.
For required merge queues, verify the queue strategy matches the authorized
strategy and wait for confirmed merge, not just queue admission, before cleanup.
Verify local and remote deletion separately; failed guards or unavailable safe
cleanup are reported as pending rather than retried unconditionally or claimed done.

## Bounded PR monitoring

Direct `pr` and `go`-routed monitoring use the same watcher. Emit a 1-line
user-visible status update in `assistant.message.content` outside `<thought>` at
every stage transition, report the PR URL and head SHA when submitted, and print
the timestamped status table in visible `assistant.message.content` when launching
or relaunching `watch` and in the same response that invokes each
`read_powershell(delay: 60)` call, even when `read_powershell` reports the command
is still running (`<thought>` blocks are hidden from the user). `watch` budgets
API calls and sleeps to 540 seconds by default, reduced for shorter positive
`COPILOT_TASK_WAIT_TIMEOUT_SECONDS`. `--max-wait-sec <non-negative integer>`
overrides that budget; `0` disables chunking. Local startup/state writes add
overhead, so overrides must leave room below the host deadline.

`WATCH_CHUNK_TIMEOUT` is a clean rotation, not readiness or merge authorization.
Report status and re-arm with the same repository, head pins, reviewer policy
and watchlist. Emit a 1-line user-visible status update in
`assistant.message.content` outside `<thought>` at every stage transition, and
print the timestamped status table in visible `assistant.message.content` in the
same response that invokes the next `read_powershell(delay: 60)` call (never
chaining empty `assistant.message` turns). Requests and fallback share the deadline. The next PR, phases,
snapshots, ETags, retry counters, comment cursors and shared cooldown persist
under `$COPILOT_HOME/pr-watch` (default `~/.copilot/pr-watch`). Active cooldowns
prevent premature API calls after restart. After handling comments, use
`--since-comment-id <pr>:<id>` for a specific watched PR; a scalar ID advances
only the primary PR. Use one active watcher per PR.

## Related issues after merge

Inventory related issues before merging, including closing links, PR references,
the task/handoff, relevant discussion, and cross-repository work. Assess each
issue's acceptance criteria against delivered changes and evidence; remove
misleading closing links for incomplete or reference-only work rather than treating
a reference as permission to close. Persist and verify the repository-qualified
inventory and scope rationale in the PR body or a PR comment before merging,
including associations present only in the task or handoff.

After GitHub confirms the intended head merged, fully resolved issues must be
verified closed; close any still open with the merged PR link and completion
evidence. Keep partial issues open with a verified progress update describing
completed and remaining work and next steps. Correct accidental closure by this
PR, but ask before reopening unrelated intentional closures.

Resuming an already-merged PR runs the same check without duplicate updates.
Verify actual issue state and persisted comments, re-reading after timeouts.
Unknown scope, incomplete discovery, permission failures, or unverified writes
leave delivery **merged with issue reconciliation pending**, separately from
any pending branch cleanup.
