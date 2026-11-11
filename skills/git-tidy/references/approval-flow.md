# Cleanup and Revalidation Flow

Show the audit and exact preservation evidence before asking for one explicit
confirmation of the listed cleanup plan. Cover all listed local removals and
their named prerequisites in that confirmation. Read-only, dry-run, and metadata
requests end with the report.

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
revalidates the live and local evidence. If any commits would become
unreachable, it creates a self-contained recovery bundle and verifies all
listed tips, complete history, and the pack checksum. It then rechecks the plan
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
authorization and regenerate in an isolated directory. Without an exact match,
keep the entry and worktree blocked. Keep ignored names and payloads out of audit artifacts. `--include-ignored` requests this check
for the report even when cleanup is not enabled.

Before clearing verified outputs, confirm the worktree's exact registered
absolute root. Resolve every target under that root, reject symlinks, reparse
points, submodules and nested repositories, and preview the exact literal
targets in the confirmation plan. Require that each target remains ignored,
contains no tracked or unignored files, and still matches the verified bytes.
Use native
filesystem operations without shell interpolation. Rerun proof after cleanup and
use ordinary worktree removal. Unknown entries, credentials, local configuration,
or irreplaceable data keep the worktree blocked. Do not use blanket
`git clean` or force-remove a worktree to get around the blocker.

## Exceptions

Keep unique overlays and stashes. If the user requests recovery, verify that a
durable branch contains the saved change units before removing the original.
A new ref name, command success, or reflog reachability alone is insufficient.

Report remaining decisions together after routine cleanup. Saving unique work,
discarding uncertain data, modifying tags/remotes, aborting interrupted operations,
rebase, merge, PR writes, and recovery-destroying maintenance require their own
user direction. Use the established specialist workflow for those operations.
