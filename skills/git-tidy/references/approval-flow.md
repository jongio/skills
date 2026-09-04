# Approval and Revalidation Flow

Triage is advisory. A selected disposition is not authorization. Approval is
specific to one displayed operation, identity set, command set, and expected
effect; it does not carry across drift or action classes.

## Lifecycle

1. Preflight Node.js `>=22`. If unavailable, failed, malformed, or older, stop
   at metadata-only orchestration and offer no work-bearing destructive action.
2. Run read-only inventory and proof.
3. For remote refresh or acquisition, request separate approval and hand off
   to an external workflow. The analyzer never performs it. Start a fresh
   analysis after that workflow returns. Optionally request separate approval
   for ignored-content review or isolated merge simulation.
4. Present the Git Clean style categorized report inside the
   `ask_user.question` field with numbered **Safe to Remove**, **Needs Review**,
   **Keep**, and **Skipped** sections. Show up to ten rows per category, state
   the remaining count, and never select an unlisted row. Every safe row names
   its retained durable carrier. Never separate the report from its choice menu.
5. Let the user select all visible safe rows, choose row numbers, review medium
   items, keep everything, or show full evidence. Record the corresponding
   internal outcomes without exposing analyzer vocabulary by default.
6. Build explicit per-carrier actions without inferring any action from the
   outcome, including `delete`; then run read-only `revalidate` to validate the
   selected set's last-copy witnesses and produce an inert guarded plan.
7. On drift, emit no plan and return to fresh analysis.
8. Without adding another per-carrier decision round, show the stable plan's
   exact argv, refs, paths, expected OIDs, ordering, effects, recovery, and
   approval class.
9. Obtain approval for that action class only.
10. Immediately run read-only `revalidate` again. Continue only when the
    relevant plan steps remain identical and stable.
11. Execute only the revalidated, approved action through its established
    workflow; report each result.

## Approval classes

Never combine these classes in one consent:

- remote refresh (`fetch`) or prune;
- ignored-content read/hash;
- temporary clone or isolated fetch;
- isolated temporary Git directory and object directory creation for merge
  simulation;
- cleanup of merge-simulation temporary directories;
- recovery/save, including stash creation or commit;
- checkout/switch;
- rebase or base merge;
- merge;
- push;
- pull request creation;
- pull request merge, per PR;
- stash drop;
- local branch deletion;
- remote ref deletion;
- worktree removal;
- tag deletion;
- remote removal;
- artifact/file removal or `git rm --cached`;
- reflog expiration; and
- garbage collection/repack.

Approval for temporary creation does not imply approval for cleanup. Approval
for recovery does not imply deletion. Refresh does not imply cleanup. PR
creation and PR merge always use the established GitHub-write flow, and merge
requires fresh per-PR approval.

Remote refresh approval authorizes only the external refresh workflow. It never
authorizes the analyzer to fetch or prune, and the refreshed state requires a
new analyzer run and new downstream approvals.

Force deletion, dirty worktree force-removal, or explicit discard of unique or
unmerged work requires an additional warning and approval. Mechanical review
does not make such loss safe.

## Prerequisites and ordering

Prerequisites must finish and be verified before dependent actions are offered.
When applicable:

1. save/recover unique overlays to a named durable carrier;
2. verify the saved change units and new witness;
3. remove worktrees that hold branches;
4. delete local refs;
5. delete remote refs with an expected-OID lease;
6. drop stashes in descending revalidated selector order;
7. delete tags/remotes or clean artifacts;
8. perform separately approved recovery-destroying maintenance last.

`resume`, `update-rebase`, `merge-as-is`, and `open-pr` hand off rather than
execute inline. A clean merge simulation proves only mechanical mergeability;
merge-as-is additionally requires bounded code review, repository policy, and
passing tests.

All seven dispositions are user-requestable work outcomes. Destructive
operations are exclusively per-carrier actions. A requested `delete` outcome
does not identify a carrier to destroy and cannot authorize or imply a
destructive action.

## Revalidation

Pass the prior exact `1.1.0` result and selected carrier IDs to `revalidate` through
stdin. Re-read:

- repository and remote identity;
- selected and witness OIDs and change-unit identity;
- local/remote ref targets;
- stash selector-to-OID mapping;
- canonical worktree path, registration, and status fingerprint;
- protection and checked-out state;
- PR repository/head OID, state, checks, and merge state;
- prerequisite output; and
- the complete selected-set witness proof.

A stable result returns an inert guarded plan with exact argument arrays,
expected values, witnesses, dependencies, and approval classes. It never
fetches or executes.

Any changed, missing, newly protected, partial, blocked, or unavailable value
is drift. Emit no plan, name each changed field without exposing secrets, and
require fresh analysis and approval. Do not continue unaffected steps from the
old plan because witness relationships are batch-wide.

Before each stash drop, remap selector to OID again. Before remote deletion,
require an expected-OID lease; if the provider cannot enforce one atomically,
abort rather than use an unchecked delete.

## Recovery verification

A save is successful only after a durable carrier exists and exact change-unit
comparison confirms preservation. Command success, a new ref name, a PR diff,
or reflog reachability alone is insufficient. Failed or partial verification
keeps the original carrier and blocks dependent deletion.

Reflog expiration and garbage collection destroy recovery paths. They are
never preselected, never described as ordinary housekeeping, and each gets
separate approval after all cleanup results are known.

## Failure handling

- Network/auth/rate-limit failure: mark remote evidence unknown; do not infer
  absence.
- Unsupported Git capability: keep overlap evidence, mark the stronger proof
  unavailable, and defer.
- Missing, malformed, failed, or pre-22 Node runtime: remain metadata-only and
  offer no work-bearing destructive action.
- Protection or command failure: preserve the carrier and report the exact
  blocker.
- Any drift: invalidate approval and rebuild the plan.
- Partial batch execution: stop, re-inventory the repository, and recompute
  witnesses before offering remaining actions.
