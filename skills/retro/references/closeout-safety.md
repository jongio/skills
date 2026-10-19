# Closeout safety

These are minimum closeout gates, not a replacement for the installed `/pr`
or `git-tidy` workflows. Apply stricter repository/user policies as well.

## PR delivery remains in /pr

Devy supplements the built-in `/pr` command; continue its standard workflow.
A retro may discover unfinished PR work, but it must not become a second
merge implementation. Do not commit, push, request reviews, resolve threads,
or merge without the applicable user authorization.

Before any merge:

1. Read the repository policy at `.github/devy-merge-policy.json`. The default
   policy is `{"copilot":true,"expectedReviewers":[]}`. Missing policy does not
   mean no reviews are expected; invalid/unreadable policy blocks the merge.
   Only explicitly set `copilot:false` for a repository that does not require
   Copilot, with authorization. Never weaken policy to pass a blocked merge.
2. Verify GitHub repository owner and visibility, not a folder name or remote
   nickname. **Only for PRIVATE repositories owned by jongio**, do not request
   or wait for Copilot review, including already-pending Copilot requests.
   This exception does not dismiss posted feedback or other expected reviewers,
   required approvals, CI, repository rules, or head pinning. If identity or
   visibility is unknown, do not assume the exception applies.
3. Establish expected reviewers from policy, current requests, and requests
   recorded during the session. Configure other expected reviewers by login
   in `expectedReviewers` before requesting them. Preserve that set when an
   in-flight request disappears. Policy changes need the normal authorization.
4. Capture the current full head SHA. Wait for every expected review to
   complete on that current head. Copilot review is expected by default outside
   the exception or an explicit `copilot:false` policy. Require actual submitted
   review evidence associated with the head SHA and expected reviewer.
   A pending draft or a review on an earlier head is not completion.
5. A completed **COMMENTED** review counts as completion, not approval.
   Dismissed reviews cannot satisfy required approvals. Green CI, **MERGEABLE**,
   no threads, no requests, and an empty **reviewDecision** are not
   review-completion evidence.
6. Address feedback and resolve review threads, including outdated ones, after
   the concern is actually fixed or explicitly settled. Do not bulk-resolve
   unanswered human questions, dismiss criticism, or treat "outdated" as
   "addressed". Paginate reviews and threads. Check posted feedback even from
   Copilot when the private-owner exception removes the need to wait for it.
7. Any new commit restarts current-head review and check verification. Confirm
   all required approvals, passing CI, and repository merge rules against the
   final head. Re-read the head immediately before the authorized merge.

Use one literal command with the verified number, repository, and full SHA:

```text
gh pr merge NUMBER -R OWNER/REPO --match-head-commit FULL_SHA
```

Alternatively, use structured `merge_pull_request` with `sha` set to that
same full SHA when available. Do not bypass a denial with wrappers, scripts,
raw APIs, admin, or deferred auto-merge. On denial, continue `/pr` to remediate
or wait and retry. The hook does not wait for human reviews.

After a successful tool result, read GitHub state to verify that the intended
PR actually merged. An open, queued, or auto-merge-enabled PR is not merged.
Do not clean its branch/worktree on the strength of tool success alone.

## Cleanup remains in git-tidy

Build a scoped candidate list from the session's known repository paths,
branches, worktrees, and PR identities. Include skill-source worktrees that
this retro edited, but never expand deletion scope to unrelated work.

Use `git-tidy`'s existing analyzer, proof, isolated remote verification,
revalidation, and approved action mechanism. Honor its runtime requirements.
Do not reinvent preservation proof or invoke mutating Git commands during
the inventory. A failed, offline, or partial collector leaves a coverage gap,
not permission to delete.

Before proposing removal, require evidence for:

- Exact repository identity, resolved worktree path, branch/ref, head OID,
  default/base identity, and association with this session.
- Tracked, staged, untracked, and ignored content, using the cleanup workflow's
  protected checks. A clean tracked diff alone is insufficient. Preserve any
  local-only content; do not read secret ignored payloads to prove safety.
- Preservation of every relevant change in the verified destination. Ancestry
  may not prove a squash/rebase merge; use the workflow's content proof rather
  than concluding merged or unmerged from commit shape alone.
- No pending task, review, agent, running process, other session, or user need
  depending on that checkout. Unknown ownership/use means retain.
- No uncommitted or unpublished skill improvement that would be lost. A
  previously merged branch can contain new commits and is not automatically
  disposable.

Keep the current worktree and primary worktree, protected/default branches,
dirty or locked worktrees, unproven refs, and active or uncertain candidates.
Do not unlock, force-delete, discard, stash, or move work just to make removal
possible. Any preservation action needs its own approval.

Present the exact approved action set with paths/refs, current identities,
preservation evidence, and retained entries. Approval of local cleanup does
not approve remote branch deletion, fetch/prune, stash dropping, or broad
garbage collection. Those actions are outside retro's branch/worktree scope
unless the user explicitly requests them through the appropriate workflow.

After approval, revalidate those same identities and preconditions immediately
before each mutation. A new commit, dirty file, active session, moved ref,
changed worktree registration, or expired proof invalidates the plan. Stop,
retain the target, and obtain a new preview/approval; never force through it.

Verify each postcondition independently. If some actions succeed and another
fails, report the partial result and retain the remainder. Never report an
entire batch deleted because the first command succeeded.
