---
title: pr
tagline: "A concise checklist workflow for taking changes from local commit and preflight checks through PR submission, review resolution, CI monitoring, and merge."
useWhen: "PR checklist, prepare a PR, submit a PR, monitor a PR, address PR feedback, merge a PR"
repoPath: skills/pr
thumb: images/thumb-pr.png
install:
  - label: Install for GitHub Copilot
    cmd: "npx skills add jongio/skills --skill pr --skill test-doctor --skill doc-doctor -g --agent github-copilot"
---

## What it does

A concise checklist workflow for taking changes from local commit and preflight checks through PR submission, review resolution, CI monitoring, and merge.

Requires `test-doctor` and `doc-doctor`. PR preflight owns the documentation pass,
including when called by `go`, and reuses matching passing evidence (including
`go` Step 4's diff + cross-model `rubber-duck` sub-agent review, or running both
when invoked directly without `go`).

Preserves the PR template and records exact validation commands and results.
Expects Copilot review unless an explicitly authorized, verified private-owner
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

## Install with required skills

The single-skill options above do not install dependencies. Use this command
to install `pr` and every required skill, or choose the full collection.

```sh
npx skills add jongio/skills --skill pr --skill test-doctor --skill doc-doctor -g --agent github-copilot
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
merging") requires it. A validated `go` handoff preserves the choice, and a later
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
