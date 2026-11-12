# Cleanup and Revalidation Flow

Show the audit and exact preservation evidence before asking for one explicit
confirmation of the listed cleanup plan. Cover all listed local removals and
their named prerequisites in that confirmation. Read-only, dry-run, and metadata
requests end with the report.

## Default reconciliation

For full cleanup, report the primary checkout's branch, staged, unstaged and
untracked status, local and verified remote default tips, ahead/behind counts,
and stash identities. Aim for a clean primary checkout on the verified
default, exactly one local branch, and zero stashes. Check checkout status
even when the local ref already matches. Leave GitHub branches and
operational worktree contents alone.

Include all applicable steps in one plan.

- **Align the primary checkout.** Plan a fast-forward if the local default is
  behind. If it has commits outside upstream, explain the remaining work and
  show the old and new OIDs before offering an archive-backed ref update.
  Update a diverged default only while unchecked out, with its old tip archived
  and an expected-old-OID guard. If checked out, list a clean, same-commit
  detach before the ref update and subsequent switch. Never merge, rebase,
  or reset to get a clean checkout. For known inactive edits, offer to
  preserve the index, staged and unstaged changes, and exact untracked files
  before clearing them.
  Verify the saved bytes and index state. If a temporary stash is needed,
  list its creation and removal in the same plan and verify its full recovery
  snapshot before dropping it. Check for ignored-file collisions before
  switching to the verified default.
- **Retire branches and stashes.** Show exact refs, OIDs, and integration or
  surviving-copy evidence. When inactive history or edits remain outside the
  default, describe the delta and propose archive-backed retirement when the
  evidence supports it. Preserve each full stash commit and its parents,
  including staged, unstaged, and untracked content. Include reflog-only
  commits that would lose their last recovery handle.
- **Keep operational worktrees.** A local deployment branch can be retired
  while its worktree stays at the same commit if the deployment is proved
  independent of the symbolic local branch and the commit remains recoverable.
  List the exact path, OID, branch and same-commit detach. Check that the index
  and existing overlays survive the detach. Retain the branch if the deployment
  needs it or the transition cannot be proved safe. Keep rollback, dirty or
  locked linked worktrees unless a listed safe action preserves their data
  and role.

Show the private recovery destination and verification for each removal or
overwrite. After approval, prepare and verify backups before the first
removal or overwrite. For Git history, verify a self-contained bundle with the
exact tip OIDs by restoring into an empty repository without alternates and
checking the selected objects. Name otherwise unnameable commits using
temporary refs in an isolated backup repository. Verify exact paths and
SHA-256 hashes for backed-up files. Keep recovery outside the worktrees and
target Git directory, restricted to the user. Leave a target in place if its
backup cannot be verified.

The analyzer stays read-only. Archive-backed retirement requires its own
preservation evidence. For recovery-backed steps, bind the displayed plan to the
exact refs, OIDs, reflogs, checkout states, dependencies, and backup paths.
Re-read those identities and verify the approved recovery before mutation.
Use analyzer revalidation for its supported action classes. Withhold
unsupported steps whose prerequisites cannot be independently verified.

## Revalidation

1. Pass the exact verified schema 2.0 result, selected carrier IDs, one mutation
   class, and the verified remote URL to `revalidate`.
2. Present exact targets and commands, expected OIDs and status, retained
   witnesses and the proof for each, effects, recovery limits, and execution order. Include
   conditional branch removals with their exact identities and prerequisites.
   Request confirmation once for the complete listed plan.
3. After confirmation, bind each current batch's exact `planId` and
   `approvalClass` as `approvedPlan`. Execute only steps with
   `approvalRevalidated: true` that match the confirmed targets, identities,
   proof, and scope. Expected prerequisite changes can unlock listed actions.
   New targets or changed evidence require fresh confirmation.
4. Recheck each target immediately before mutation. For a local ref, require an
   exact non-symbolic ref at its expected OID and confirm it is unchecked out
   across all worktrees. Delete with `git update-ref --no-deref -d <ref> <oid>`.
   For a worktree, check its absolute registered path, Git directory, HEAD,
   status and operation state. Remove with non-force `git worktree remove`.
   For stashes, remap each selector to its OID immediately before dropping,
   highest selector index first.
5. Verify each result and run fresh analysis after removing worktrees. Their
   attached branches may now be removable. Never reuse a stale plan. On drift
   or partial failure, re-inventory and continue only with independent confirmed
   actions whose evidence still holds.

Local cleanup depends on the verified default branch. Before a requested live
remote deletion,
verify the remote repository, exact live branch OID, integration into the
verified default, and current protection. Use an expected-OID lease and verify
absence afterward. A failed remote lookup never establishes absence.

## Stale origin tracking refs

Include this section in the same report and confirmation as local branches,
worktrees, and stashes. Run the helper at the target repository root with JSON
on stdin. Use the exact verified origin URL and a fresh absolute `.bundle`
path in the user's private recovery or scratch storage, outside the target
worktrees. On Windows, use a directory with an access control list restricted
to the user because the bundle inherits that directory's permissions.
Resolve the helper from the installed skill directory and use its absolute path.
Supply any local refs slated for removal as `excludeWitnessRefs`. Include
`refs/stash` if any stash will be dropped.

```text
node "<installed-skill-dir>/scripts/tracking-prune.mjs" plan
{"remoteUrl":"<origin URL>","bundlePath":"<absolute path>","excludeWitnessRefs":[]}

node "<installed-skill-dir>/scripts/tracking-prune.mjs" apply
{"input":<plan.input>,"approvedPlanId":"<confirmed plan.planId>"}
```

Planning verifies the standard origin fetch mapping and the live head list
through the isolated remote verifier. Show the exact absent tracking refs,
local tip OIDs, per-tip and deduplicated total unreachable commit counts,
omissions, and any coverage gap. Counts exclude all refs slated for removal.
The helper guards the default tracking ref and leaves symbolic refs in place.
A failed check leaves pruning blocked. Dry runs use only `plan`.

Apply the confirmed tracking plan before the other cleanup batches. The helper
revalidates the live and local evidence. For every nonempty plan, it creates a
self-contained recovery bundle and verifies all listed tips, complete history,
and the pack checksum before the first removal. If a tracking ref has reflog-only
commits to preserve, verify their separate recovery before invoking the helper.
The helper then rechecks the plan
and deletes the approved tracking refs atomically using their exact old OIDs.
If archiving or verification fails, leave the refs in place. After pruning,
report the exact refs removed and the verified bundle path. Refresh the
read-only audit before revalidating any remaining confirmed batches.

## Ignored worktree entries

The analyzer counts ignored entries without persisting names or reading payloads.
For otherwise removable worktrees, check ignored paths privately using
NUL-delimited Git output. Names, metadata, and build configuration only identify
candidate outputs. Require user-authorized byte-for-byte comparison against a
trusted copy of the exact output. If regeneration is needed, obtain explicit
authorization and regenerate in an isolated directory. A private verified file
backup can also preserve an ignored entry. Keep the worktree blocked until one
of these proofs holds. Keep ignored names and payloads out of public audit
artifacts. `--include-ignored` requests this check
for the report even when cleanup is not enabled.

Before clearing verified files, confirm the worktree's exact registered
absolute root. Resolve every target under that root, reject symlinks, reparse
points, submodules and nested repositories from recursive operations, and preview the exact literal
targets in the confirmation plan. Require that each target remains ignored,
contains no tracked or unignored files, and still matches the verified bytes.
Use native
filesystem operations without shell interpolation. Unlink an explicitly listed
junction only as a link after verifying its target. Rerun proof after cleanup
and use ordinary worktree removal. Unverified local data keeps the worktree
blocked. Do not use blanket
`git clean` or force-remove a worktree to get around the blocker.

## Exceptions

Keep active or uncertain overlays and stashes. For approved recovery, verify
the saved change units before removing the original. A new ref name, command
success, or reflog reachability alone is insufficient.

Report remaining decisions together after routine cleanup. Saving unique work,
discarding uncertain data, modifying tags/remotes, aborting interrupted operations,
rebase, merge, PR writes, and recovery-destroying maintenance require their own
user direction. Use the established specialist workflow for those operations.
