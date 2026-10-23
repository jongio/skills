# Related-issue reconciliation

This contract is shared by direct `pr`, a `go` handoff, and resuming an already-merged PR.
Issue reconciliation belongs to `pr`; do not duplicate it in callers or the review watcher.

## Before merge: inventory and assess

- Collect GitHub closing links, explicit issue references in the PR body, the task/handoff, and relevant PR conversation. Paginate the linked issues and comments; inspect issue bodies, acceptance checklists, and relevant issue comments. Do not crawl unrelated issues or treat every incidental reference as delivery scope.
- Deduplicate by `owner/repo#number`, retaining full issue URLs and cross-repository identities; never apply a bare number to a guessed repository. Verify each target is an issue rather than another PR.
- Record each issue's acceptance criteria, merged changes (or the proposed changes before merge), validation evidence, current state, and disposition: fully resolved, partially resolved, reference-only, or unknown. A mere mention is not delivery evidence or permission to close an issue.
- Fully resolved means all acceptance criteria are met with evidence, including any required rollout or follow-up outside the PR. Partially resolved means some delivered work is established but requirements remain; reference-only issues receive no mutations. Unknown means evidence or access is insufficient: do not close; record the blocker and request a user decision only when necessary.
- Remove misleading closing keywords or automatic closing links for partially resolved or unknown issues before merging, preserving neutral references and the PR template. Inspect the proposed squash/merge message and applicable commit closing keywords too; do not rewrite shared history without authorization. If an automatic closure cannot safely be prevented, pause merge for a decision rather than knowingly closing incomplete work.
- A non-default base or a missing closing link can mean no automatic closure; neither proves the issue is unrelated or fully resolved. An unavailable or incomplete inventory is not evidence of no related issues: report the discovery gap, without inventing issue identities or waiving existing gates.

## After confirmed merge: reconcile

Do not mutate issues before GitHub confirms the intended head actually merged.
Command success or queue admission is insufficient. When resuming an already-merged PR,
verify its merged head and reconstruct the same inventory from durable GitHub evidence.
Reassess against the actual merged changes and current issue requirements, not just
the former PR body or a closing keyword.

Before each write, re-read the issue state and relevant comments; preserve concurrent
edits, existing checklists, and unrelated work. Use explicit issue repository and number
on every command, and pass Markdown through `--body-file` or a safe literal.

| Disposition | Action |
| --- | --- |
| Fully resolved | If already closed, verify completion evidence and do not add a duplicate closure or comment. If still open, close with reason completed and a concise merged PR link plus completion evidence: `gh issue close <number> -R <owner/repo> --reason completed --comment <safe-literal>`. A closed state alone does not prove the requirements are complete. |
| Partially resolved | Normally keep the issue open; post a concise update with the merged PR link, completed work, remaining acceptance criteria, and concrete next steps or blockers. Do not invent an owner, deadline, or follow-up issue. Prefer a comment over replacing the issue body; update checklist items only when verified and without overwriting concurrent edits. |
| Unknown | Do not close or claim completion. If delivered progress is known, post only that verified progress and the unresolved evidence gap; otherwise report the blocker without speculative issue edits. Reconciliation remains pending until the disposition is established. |
| Reference-only | Preserve the issue unchanged; record why it is outside the PR's delivery scope. |

If a partially resolved issue was automatically closed by this merged PR, inspect the
closure event and current state, then reopen with the remaining-work evidence and
progress update. For an unrelated or intentional closure, do not reopen automatically:
obtain a user decision before reopening or changing that disposition.

Re-read the issue state and comments after each action to verify the intended result
persisted. Fully resolved issues must be closed; partial issues must be open with the
remaining-work update actually present. Tool success alone is not verification.

## Retries, failures, and reporting

- Identify an update by its merged PR URL and substantive delivered/remaining work. If the same merged PR and remaining work are already documented, reuse the existing update rather than posting a duplicate. If requirements changed, add only the missing or corrected information.
- After a timeout or ambiguous write result, re-read state and comments before retrying. Resume only unfinished reconciliation; never repeat successful writes or infer success from a lost response.
- A permission, API, discovery, or verification failure leaves delivery as **merged with issue reconciliation pending**. Report each affected issue, attempted action, and exact blocker; retain successful results for other issues. Do not retry the merge to repair a failed issue update.
- Keep branch cleanup independent of issue reconciliation: preserve its existing guards, attempt safe cleanup even if an issue write is blocked, and report both pending statuses when applicable. Keeping the branch or blocked cleanup does not skip issue checks.
- Report each related issue's final verified disposition and link, or explicitly say no related issues only after a complete inventory. Do not claim full delivery while any required reconciliation is pending.
