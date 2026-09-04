# Evidence Model

This reference defines the proof rules behind contract `1.1.0`. The normative
result shape and compatibility policy are in
[the specification](../../../docs/specs/git-tidy/spec.md).

## Units of reasoning

A **carrier** is a place where work currently exists: local branch, remote
branch, worktree, or stash. Pull requests are observations about work, not
carriers. A **work item** correlates carriers only when exact mechanical
evidence connects them. A **change unit** is a deterministic end-state record.

A durable carrier is a verified retained ref: a local branch, an exactly
observed remote branch, or `refs/stash`. A clean worktree's checked-out ref is
durable through that ref, not through the worktree directory. Detached commits
and staged, unstaged, untracked, ignored, or conflicted overlays are
non-durable until saved to a verified retained ref. Unknown remote state is
not durable.

For tracked content, a change unit contains raw path bytes, old/new modes,
old/new blob or gitlink OIDs, and change type. Sort by raw bytes and use
NUL-safe parsing. Normalize a rename into delete plus add while retaining
rename metadata for display. Hash untracked regular files as Git objects
without writing to the object database. Hash symlink target bytes without
following the link.

Exact grouping is allowed only for:

1. identical observed commit or tree OIDs;
2. identical complete change-unit sets;
3. an observed worktree/checked-out-branch relationship;
4. a local/tracking-remote relationship with observed OIDs; or
5. a PR/remote relationship with immutable repository ID, exact ref name, and
   exact head OID.

Names, messages, subjects, age, path similarity, patch IDs, `git cherry`, and
model similarity are hints or corroboration. They never merge work items.
Partial overlap is recorded as overlap.

## Evidence lattice

Each work item has independent dimensions:

```text
authority:  mechanical | content-review | user-judgment
evidence:   complete | partial | blocked
confidence: proven | strong | indicative | unknown
```

There is no numeric score. Hard blockers win.

- `proven` requires complete exact mechanical proof.
- `strong` is non-conclusive mechanical corroboration.
- `indicative` covers interpretive assessment.
- `unknown` covers absent, conflicting, or unusable evidence.

Age affects review order only. Content review is capped at `indicative` and
cannot support deletion. Missing objects, truncation, unsupported formats,
timeouts, rate limits, and skipped content make affected evidence `partial` or
`blocked` and prohibit destructive action.

## Last-copy witnesses

Evaluate a proposed destructive carrier set as one transaction. Every selected
change unit must remain exact and reachable on at least one durable,
unselected, retained carrier after all steps. Record those carrier IDs on each
destructive action.

Valid witnesses are retained refs or other durable carriers with complete
change-unit equality. Invalid witnesses include:

- the selected carrier itself or another selected carrier;
- a pull request or GitHub diff;
- reflog-only or unreachable object retention;
- dirty, untracked, ignored, or otherwise unsaved overlays;
- an unverified remote, missing object, or partial comparison; and
- a carrier removed by a prerequisite or earlier action.

Failure for one unit blocks the whole selection. A recovery/save prerequisite
must complete and be verified before its new durable carrier can witness a
dependent deletion.

## Recommendation and action matrix

Recommendations are the seven user-requestable work outcomes and describe the
work item. Actions describe each carrier. Destructive operations exist only as
explicit per-carrier actions and are never inferred from a recommendation.

| Recommendation | Typical carrier actions |
|---|---|
| `delete` | Work outcome only: retained canonical carrier is `keep`; a separately proved duplicate may receive `delete-ref`, `drop-stash`, or `remove-worktree` |
| `keep-save` | Durable carrier: `keep`; unsaved carrier: `keep` with save prerequisite |
| `resume` | Chosen carrier: `keep`; duplicates normally `no-action` pending user decision |
| `update-rebase` | Source carrier: `keep`; hand off, no destructive action |
| `merge-as-is` | Source carrier: `keep`; hand off, no destructive action |
| `open-pr` | Source carrier: `keep`; hand off, no destructive action |
| `defer` | Every carrier: `keep` or `no-action` |

`delete` requires `mechanical`, `complete`, `proven`, no blocker, protection
clear, exact witnesses, and current identities. Recommendation alone never
authorizes or implies an action. Each destructive carrier action requires its
own identity, proof, witness set, blocker check, and approval.

## Source-specific proof

### Stashes

The stash graph, not its message, is authoritative:

1. first parent: original `HEAD` and base;
2. second parent: index snapshot;
3. stash commit tree: final tracked worktree snapshot; and
4. optional third parent: untracked/ignored snapshot.

Analyze base-to-index, index-to-stash-tree, base-to-stash-tree, and third-parent
content independently. Missing or malformed topology is incomplete and
`defer`. Record exact identity as
`{stashOid,baseOid,indexOid,treeOid,untrackedOid,observedSelector}`. Resolve
`treeOid` from Git's tree-peeling revision operator for valid topology. Base,
index, tree, and
untracked OIDs remain null when unavailable; `untrackedOid` is also null for a
valid two-parent stash. Use first-parent containment to find viable resume
bases. Stable patch IDs and `git cherry` corroborate only.

Record `observed.componentChangeUnitIds` as the closed map
`{staged,unstaged,trackedFinal,untracked}`. `staged` is base-to-index,
`unstaged` is index-to-stash-tree, `trackedFinal` is base-to-stash-tree, and
`untracked` is third-parent evidence. Retention `changeUnitIds` remains staged
plus unstaged plus untracked only, preserving distinct snapshots and staged-only
duplicate behavior. Associate every `trackedFinal` ID with the stash work item
for reporting and review.

Before a drop, remap the displayed selector to its recorded stash OID. Drop
multiple approved stashes in descending index order and remap before each.

### Local branches

Record tip/tree OIDs, upstream, ahead/behind, checked-out worktrees, ancestry
against the observed default tip, exact changed-path end states, and associated
PR identity. Every local branch and locally available remote ref stores
`observed.ancestry={mergeBaseOid,ahead,behind,state,mergedIntoDefault,reachableFromDefault}`.
State is exactly `identical`, `ahead`, `behind`, or `diverged`.

Resolve the default branch exclusively from the locally observed
`refs/remotes/origin/HEAD` symbolic ref and its exact inventoried
`refs/remotes/origin/<name>` target object. Map the suffix to
`refs/heads/<name>` only for local default protection, and use the remote target
OID as the comparison base. There is no `main`, `master`, other-remote, or
arbitrary-branch fallback.

If that identity is missing, malformed, non-origin, non-UTF-8, or dangling,
record `default-branch-identity`. Ordinary local branches then have unknown
protection, partial protection evidence, and
`default-branch-identity-unknown`. Policy-protected local refs remain protected
with complete policy evidence but retain the blocker. Destructive branch
actions remain unavailable.

Resolve the merge base exactly, then count
`git rev-list --left-right --count <default>...<tip>`, interpreting left as
`behind` and right as `ahead`. Diff only merge base to tip. An ahead count of
zero has no unique work and emits an empty unit set. Record
`branch-no-unique-work` in that case plus exactly one of `branch-identical`,
`branch-ahead`, `branch-behind`, or `branch-diverged`.

Merge-base, count, diff, and comparison-limit failures record respectively
`branch-merge-base-unavailable`, `branch-ancestry-unavailable`,
`branch-change-units-unavailable`, or `branch-proof-limit`. Each also adds
`branch-proof-incomplete`; incomplete branch proof cannot authorize destruction.

A merged PR proves only its exact head. If the live tip differs, its added
range remains active. Squash/cherry-pick proof may combine stable patch IDs,
`git cherry`, and complete end-state blob/mode equality, but only exact
end-state equality is preservation proof. Reverts, unique merges, replacement
refs, grafts, shallow/partial history, unrelated histories, and missing
objects block a proven verdict unless another exact proof is complete.

### Remote branches and pull requests

The analyzer never refreshes, fetches, or prunes. Identify a GitHub repository
by immutable repository ID. Normalize each GitHub branch to stable ID,
repository ID, ref name, tip OID, and protected state. Attach it to remote
evidence only on exact repository ID, ref name, and tip OID.

Derive the GitHub API hostname only from the safely parsed HTTPS URL returned by
the closed repository-view response. Lowercase and canonically revalidate that
hostname before passing it as the separate `--hostname` argument. This supports
GitHub Enterprise without trusting remote URLs or repository display text.

Join a PR using its head repository ID, exact head ref name, and exact head OID.
Record open, draft, closed-unmerged, merged, review, check,
mergeability, and post-merge-advanced states separately. A separately approved
external refresh invalidates prior observations and requires a new analyzer
run.

Normalized unjoined PR records carry `exactHeadMatch: false`. Only a strict
repository ID, ref name, and head OID match may attach, and serialized attached
PR evidence carries `exactHeadMatch: true`.

PR data is non-durable. A PR can corroborate shipped identity but cannot be a
last-copy witness. Same-name fork heads never share evidence.

Use locally available remote-tracking objects without network writes.
Determine remote-only GitHub tip availability with one strict batched
`cat-file --batch-check` read across all deduplicated validated OIDs. Exact
`<oid> commit <size>` is present; exact `<oid> missing` is absent. Unknown,
malformed, non-commit, or unmatched output is unavailable. Strict batch or
parser failure records `remote-content-availability-unavailable`. Only present
tips proceed to merge-base and diff proof within `maxComparisons`.

Remote-only unavailable content remains metadata-only and incomplete unless the user separately
approves an external isolated-acquisition workflow and then starts a new
analyzer run. It remains `keep`, ineligible, and `defer`, with
`remote-content-unavailable`, `isolated-acquisition-required`, and one
deterministic prerequisite ID. Protected GitHub branches add
`remote-branch-protected`. Local tracking OID disagreement adds
`remote-tracking-drift`. Authentication, authorization, DNS, timeout,
rate-limit, or access failure means unknown, not dead or redundant, and records
`github-branches-unavailable` when branch inventory fails.

### Worktrees

Analyze the main and every linked worktree with porcelain-v2 NUL output.
Record staged, unstaged, intent-to-add, untracked, conflicted, detached,
unborn, locked, prunable, missing, sparse, invalid-common-directory, submodule,
file-mode, branch OID, and status fingerprint state. Record nonnegative staged,
unstaged, submodule, conflict, intent-to-add, and untracked counts. Record
sparse enablement, cone mode, sparse-index mode, and pattern count as values or
null with an explicit gap.

Count ignored paths only from `! ` records produced by the exact
`--ignored=matching --untracked-files=all` status recipe. Do not retain ignored
names or read payloads. A positive count on a linked worktree adds
`ignored-content-present`; an unavailable count adds `ignored-state-unknown`
and blocks removal.

The main worktree always has `protection: "protected"`, complete protection
evidence, and blocker `worktree-main`. Conflicts, dirty submodules, and
intent-to-add add `worktree-conflict`, `worktree-submodule-dirty`, and
`worktree-intent-to-add` respectively.

Dirty, locked, conflicted, or unknown worktrees are never normal removal
candidates. Their overlay must be separately saved or explicitly discarded
through an approved workflow before removal can be reconsidered.

### Special files

- Binary: compare mode, size, and blob OID; never semantically review payload.
- Git LFS: parse only a strict small pointer; compare declared OID and size;
  never download payload.
- Submodule: compare gitlink OID; do not recurse.
- Symlink: compare mode and link blob OID; do not follow.
- Generated: include mechanically, omit from semantic review, never presume
  disposable.
- Rename/copy: normalize path/content operations and retain display metadata.

## Confidence projection

HIGH is only complete, blocker-free, proven mechanical evidence. MEDIUM is
strong mechanical evidence or complete user-judgment evidence. LOW includes
content review, partial evidence, conflict, or preservation uncertainty. The
projection is display compatibility only and cannot change eligibility.

Node.js below version 22, a missing runtime, or an invalid runtime probe is a
capability blocker. Orchestration may report metadata, but it cannot produce
proof/review evidence or offer a destructive action for a work-bearing carrier.
