---
title: Git Tidy Content-Aware Triage Contract
created: 2026-08-28
updated: 2026-09-01
status: active
type: feature
owner: "@jongio"
---

# git-tidy content-aware triage contract

## Status and scope

This document freezes contract version `1.1.0`. It governs content-aware
triage of stashes, local and remote branches, and all registered worktrees.
Tags, artifacts, ignored-but-tracked files, large blobs, remotes, and
maintenance retain their existing scopes but must obey the mutation and
approval rules here.

The analyzer emits typed, bounded inventory for legacy non-work scopes.
Explicit legacy scopes show that inventory as their primary result; `all`
appends every legacy inventory after carrier triage.

The analyzer is advisory. It inventories carriers, proves exact relationships,
optionally reviews bounded text, and recommends a disposition. It never
performs cleanup, remote refresh or acquisition, fetches, prunes, writes Git
objects, or calls a GitHub write API.

Normative supporting contracts:

- [Evidence model](../../../skills/git-tidy/references/evidence-model.md)
- [Content review](../../../skills/git-tidy/references/content-review.md)
- [Approval flow](../../../skills/git-tidy/references/approval-flow.md)
- [Command recipes](../../../skills/git-tidy/references/command-recipes.md)
- [Test plan](test-plan.md)

## Public syntax

Every existing scope remains valid:

```text
git-tidy
git-tidy branches
git-tidy worktrees
git-tidy remote
git-tidy stashes
git-tidy tags
git-tidy artifacts
git-tidy blobs
git-tidy maintenance
```

Depth and safety options are orthogonal to scope:

```text
git-tidy [scope] --depth metadata
git-tidy [scope] --depth proof
git-tidy [scope] --depth review
git-tidy [scope] --include-ignored
git-tidy [scope] --dry-run
```

- `metadata` inventories but cannot establish deletion safety for a
  work-bearing carrier.
- `proof` adds deterministic content and history proof.
- `review` adds bounded semantic review and cannot strengthen deletion.
- `include-ignored` records a request for a separately approved ignored-content
  handoff. The analyzer itself remains count-only and never retains ignored names
  or reads ignored payloads.
- `dry-run` skips approvals and actions and performs no local or remote write.

`proof` is the shipped default for work-bearing scopes. `metadata` remains an
explicit compatibility mode, and `review` remains opt-in.

## Result schema

The analyzer emits one UTF-8 JSON object. Contract version `1.1.0` has this
closed top-level shape:

```text
{
  "schemaVersion": "1.1.0",
  "operation": "analyze" | "revalidate",
  "runId": string,
  "generatedAt": RFC-3339 string,
  "repository": RepositoryIdentity,
  "request": Request,
  "workItems": WorkItem[],
  "inventory": LegacyInventory,
  "coverage": Coverage,
  "reviewBundle": ReviewBundle | null,
  "actionPlan": ActionPlan | null,
  "drift": DriftRecord[],
  "compatibility": CompatibilityProjection
}
```

Unknown `schemaVersion` values must be rejected. Consumers must reject missing
required fields and type or enum mismatches. Additive fields require a minor
version; removals, renames, changed meaning, or relaxed identity rules require
a major version. Field order is not significant; array order is stable and
documented below.

`runId` is the lowercase hexadecimal SHA-256 digest of the UTF-8 canonical JSON
serialization of exactly `schemaVersion`, `repository`, `request`, and the
observed mechanical identities. Canonical JSON sorts object keys
lexicographically, uses the stable array ordering defined by this contract, and
contains no insignificant whitespace. Observed mechanical identities include
carrier identities and OIDs, change-unit raw paths/modes/OIDs, worktree status
fingerprints, and immutable remote/PR identities and observed OIDs. They
exclude observation times, `generatedAt`, display text, reasons, content
review, and action authorization. Identical inputs therefore produce the same
`runId`. `generatedAt` is informational only and cannot affect identity,
ordering, evidence, drift, eligibility, or any digest.

When session artifact storage is available, every accepted result is written
once as
`git-tidy-<generatedAt-compact>-<runId-first-12>.json`. Existing artifacts are
never replaced; a numeric suffix resolves a collision. An optional
`git-tidy-latest.json` convenience copy does not replace the immutable artifact.
The user-facing result reports the immutable path and full `runId`.

### Identities

`RepositoryIdentity` requires `objectFormat` (`sha1` or `sha256`),
`commonDir`, `primaryWorktree`, and zero or more canonical remote identities.
A remote identity requires normalized host, immutable repository ID when
available, and sanitized display URL. Credentials and raw URL user-info are
never emitted.

Every identity-bearing record has:

- `id`: deterministic opaque ID derived from typed immutable identity.
- `displayName`: sanitized, single-line, display-only text.
- `identity`: typed fields used for equality; never a display name.
- `observed`: relevant OIDs, status fingerprint, and observation time.

Raw paths are represented as base64 bytes plus a sanitized display path. Ref
and path display strings are never keys.

Closed identity shapes are:

```text
EncodedPath = { "rawBase64": string, "display": string }
RemoteIdentity = {
  "id": string, "host": string, "repositoryId": string | null,
  "displayUrl": string, "transport": "file" | "https" | "ssh"
}
RepositoryIdentity = {
  "objectFormat": "sha1" | "sha256",
  "commonDir": EncodedPath,
  "primaryWorktree": EncodedPath,
  "remotes": RemoteIdentity[]
}
```

### Request and coverage

`Request` requires `scope`, `depth`, `includeIgnored`, and `limits`. `scope` is
`all`, `branches`, `worktrees`, `remote`, `stashes`, `tags`, `artifacts`,
`blobs`, or `maintenance`; `depth` is `metadata`, `proof`, or `review`.
`includeIgnored` is Boolean. `limits` is a closed object containing every
named analyzer limit in [Limits](#limits). It records effective values, not
merely user input, and rejects unknown fields.

`dry-run` is workflow context, not analyzer evidence. The orchestrator uses it
to suppress approval and action prompts, never persists it in `Request`, and
does not accept it for `revalidate`.

`Coverage` requires `state` (`complete`, `partial`, or `blocked`), observed and
skipped counts by source, `gaps`, `limitsReached`, and command capability
records. Each gap requires a stable code, affected IDs, and sanitized reason.
Any omitted preservation evidence makes affected work items `partial` or
`blocked` and ineligible for a destructive carrier action.

```text
CoverageGap = {
  "code": string, "affectedIds": string[], "reason": string
}
Capability = {
  "name": string, "available": boolean, "version": string | null,
  "gapCode": string | null
}
Coverage = {
  "state": "complete" | "partial" | "blocked",
  "observedCounts": { <source>: nonnegative integer },
  "skippedCounts": { <source>: nonnegative integer },
  "gaps": CoverageGap[],
  "limitsReached": string[],
  "capabilities": Capability[]
}
```

Count keys are exactly `localBranches`, `remoteBranches`, `tags`, `worktrees`,
`stashes`, `pullRequests`, `artifacts`, `blobs`, `maintenanceSignals`,
`changeUnits`, and `reviewFiles`.

### Legacy inventory

Legacy inventory is advisory and never authorizes cleanup:

```text
LegacyInventory = {
  "tags": TagInventory[],
  "artifacts": ArtifactInventory[],
  "blobs": BlobInventory[],
  "maintenance": MaintenanceInventory | null
}
```

Tag records contain stable ID, encoded ref, object OID and type, optional peeled
OID, recommendation `keep`, and reason codes. Artifact records contain stable
ID, encoded path, tracked state, recommendation `inspect`, and reason codes.
Blob records contain stable ID, OID, byte size, recommendation `review`, and
reason codes. Maintenance contains object and pack counts, garbage metrics,
fixed interrupted-operation markers, a recommendation, and reason codes.

Each explicit legacy scope leaves unrelated inventory empty. Scope `all`
collects every inventory. Arrays sort by stable ID. Limit or command failure is
a coverage gap, never an empty successful result. Maintenance is `null` only
when `maintenance-inventory-unavailable` records that the collector failed.

### Review bundle

`ReviewBundle` is present only at `review` depth. It contains only mechanically
identified work-item content that survived the exclusion rules and sanitization
pipeline. Every object below is closed:

```text
ReviewLimits = {
  "maxWorkItems": nonnegative integer,
  "maxFilesPerItem": nonnegative integer,
  "maxChangedLinesPerItem": nonnegative integer,
  "maxBytesPerFile": nonnegative integer,
  "maxBytesTotal": nonnegative integer
}
ReviewCounts = {
  "originalFiles": nonnegative integer,
  "includedFiles": nonnegative integer,
  "excludedFiles": nonnegative integer,
  "originalBytes": nonnegative integer,
  "sanitizedBytes": nonnegative integer,
  "includedBytes": nonnegative integer,
  "originalChangedLines": nonnegative integer,
  "includedChangedLines": nonnegative integer,
  "redactedLines": nonnegative integer
}
ReviewBundleCounts = ReviewCounts + {
  "originalWorkItems": nonnegative integer,
  "includedWorkItems": nonnegative integer,
  "excludedWorkItems": nonnegative integer
}
ReviewGap = {
  "code": string,
  "count": positive integer,
  "affectedIds": string[]
}
ReviewFileIdentity = { "rawBase64": string }
ReviewFile = {
  "identity": ReviewFileIdentity,
  "display": string,
  "originalBytes": nonnegative integer,
  "sanitizedBytes": nonnegative integer,
  "includedBytes": nonnegative integer,
  "originalChangedLines": nonnegative integer,
  "includedChangedLines": nonnegative integer,
  "redactedLines": nonnegative integer,
  "truncated": boolean,
  "framed": string
}
ReviewItem = {
  "workItemId": string,
  "counts": ReviewCounts,
  "gaps": ReviewGap[],
  "files": ReviewFile[]
}
ReviewBundle = {
  "schemaVersion": "1.0.0",
  "nonce": string,
  "markers": { "start": string, "end": string },
  "limits": ReviewLimits,
  "complete": boolean,
  "counts": ReviewBundleCounts,
  "gaps": ReviewGap[],
  "items": ReviewItem[],
  "prompt": string
}
```

Every `workItemId` and every `ReviewGap.affectedIds` entry is an exact stable
`WorkItem.id` from the same result. Change-unit IDs are resolved to their owning
work-item IDs before bundle construction. Unknown IDs are rejected rather than
placed in a model-facing bundle.

For stash carriers, review collection also resolves every
`observed.componentChangeUnitIds.trackedFinal` ID to that stash's owning work
item. These exact base-to-stash-tree units are reporting and review evidence
only; they do not replace the carrier's retained change-unit membership.

The closed review gap code set and its reason are:

| Code | Reason |
|---|---|
| `work-item-limit` | A known work item exceeded the item limit. |
| `file-limit` | A file exceeded its work item's file limit. |
| `invalid-utf8` | Content was not valid UTF-8. |
| `binary-content` | Content was binary or contained NUL. |
| `lfs-content` | Content was a Git LFS pointer or payload. |
| `submodule-content` | The change was a gitlink. |
| `symlink-content` | The change was a symlink. |
| `sensitive-content` | The path or content was sensitive. |
| `generated-content` | The path or content was generated. |
| `ignored-content` | Ignored content lacked separate read approval. |
| `non-text-content` | The record was not reviewable text. |
| `credential-redaction` | One or more credential-like lines were redacted. |
| `file-byte-limit` | Sanitized text was truncated at the per-file byte limit. |
| `run-byte-limit` | Sanitized text was truncated at the per-run byte limit. |
| `changed-line-limit` | Text was truncated at the per-item changed-line limit. |
| `review-identity-incomplete` | A required before or after blob OID was absent. |
| `review-metadata-unavailable` | Required object metadata could not be read. |
| `review-non-blob` | A required object was not a blob. |
| `review-byte-limit` | Required object reads exceeded the review read budget. |
| `review-blob-size-drift` | Blob size changed between metadata and content reads. |
| `review-content-unavailable` | Required blob content could not be read. |

`display` is a JSON-quoted, control-cleaned, delimiter-defused display path.
`identity.rawBase64` remains the authoritative path identity. `framed` begins
and ends with the exact nonce-bearing markers and treats all enclosed path and
content text as untrusted external data. Binary, invalid UTF-8, LFS, gitlink,
symlink, generated, sensitive, secret-like, non-text, unapproved ignored, and
over-budget content is not included.

Counts are authoritative for the complete candidate set supplied to review.
`originalFiles = includedFiles + excludedFiles` and
`originalWorkItems = includedWorkItems + excludedWorkItems`. Original,
sanitized, and included byte and changed-line totals have the same meanings at
item and bundle level. `ReviewGap.code` is the machine-readable exclusion,
redaction, truncation, read-failure, or limit reason; `count` is the number of
occurrences and may exceed the number of unique affected work items. Per-item
and bundle gaps use stable work-item IDs. Any skipped file, truncated file,
redaction, unavailable read, or reached limit makes `complete` false and blocks
review from strengthening the mechanical result.

`nonce` is 8 through 128 ASCII letters, digits, underscores, or hyphens.
`markers.start` and `markers.end` are exactly
`<<<EXTERNAL_DATA_START:<nonce>>>` and
`<<<EXTERNAL_DATA_END:<nonce>>>`. `prompt` contains only the fixed untrusted
data instruction, stable `WORK_ITEM_ID` lines, and included framed files in
stable item and file order.

### Runtime capability

The versioned analyzer requires Node.js `>=22`. Before invoking it, the
orchestrator runs a no-shell `node --version` capability preflight and parses a
valid Node semantic version. Missing Node, an unparseable version, a nonzero
probe, or a major version below 22 records an unavailable `node-runtime`
capability. The orchestrator must then remain metadata-only: it cannot invoke
proof, review, or `revalidate`, and it cannot offer any work-bearing
destructive carrier action. A guarded action plan remains `null`. Installing or
upgrading Node is a separate user-controlled workflow, not an analyzer action.

### Work items and carriers

`WorkItem` requires:

```text
{
  "id": string,
  "changeUnits": ChangeUnit[],
  "overlaps": Overlap[],
  "recommendation": Disposition,
  "authority": "mechanical" | "content-review" | "user-judgment",
  "evidence": "complete" | "partial" | "blocked",
  "confidence": "proven" | "strong" | "indicative" | "unknown",
  "reasons": ObservationRef[],
  "blockers": Blocker[],
  "preservation": PreservationStatus,
  "review": AppliedReview | null,
  "carriers": Carrier[]
}
```

`Disposition` is exactly `delete`, `keep-save`, `resume`, `update-rebase`,
`merge-as-is`, `open-pr`, or `defer`. These seven values remain the work
outcomes the analyzer recommends and the user may request. They are not
operations. Destructive operations exist exclusively as explicit per-carrier
actions. In particular, `delete` means the requested work outcome is to remove
proved redundant copies while retaining a canonical copy; it cannot imply or
be translated into a destructive action for any carrier.

Each `Carrier` requires a type (`local-branch`, `remote-branch`, `worktree`, or
`stash`), typed identity, observed state, change-unit membership, durability,
protection, evidence references, and:

```text
{
  "action": "keep" | "delete-ref" | "drop-stash" |
            "remove-worktree" | "no-action",
  "eligible": boolean,
  "preservationWitnessIds": string[],
  "prerequisiteIds": string[],
  "blockerCodes": string[]
}
```

All nested objects are closed. Their shapes are:

```text
ChangeUnit = {
  "id": string, "path": EncodedPath,
  "oldMode": string | null, "newMode": string | null,
  "oldOid": string | null, "newOid": string | null,
  "kind": "add" | "delete" | "modify" | "type-change" | "gitlink",
  "binary": boolean, "sourceComponent": string
}
Overlap = {
  "otherWorkItemId": string, "changeUnitIds": string[],
  "relation": "partial"
}
ObservationRef = {
  "code": string, "source": "git" | "github" | "filesystem" | "review",
  "subjectId": string, "summary": string
}
Blocker = {
  "code": string, "subjectIds": string[], "reason": string
}
PreservationStatus = {
  "lastCopy": boolean, "durableCarrierIds": string[],
  "unwitnessedChangeUnitIds": string[]
}
AppliedReview = {
  "schemaVersion": "1.0.0", "summary": string,
  "riskFlags": string[], "recommendation": "keep-save" | "resume" | "defer",
  "reasons": string[]
}
```

Carrier identity is a tagged closed object:

```text
local-branch:  { "refRawBase64": string, "tipOid": string }
remote-branch: { "remoteId": string, "refRawBase64": string, "tipOid": string }
worktree:      { "path": EncodedPath, "gitDir": EncodedPath,
                 "headOid": string | null, "branchRawBase64": string | null,
                 "statusFingerprint": string }
stash:         { "stashOid": string, "baseOid": string | null,
                 "indexOid": string | null, "treeOid": string | null,
                 "untrackedOid": string | null,
                 "observedSelector": string }
```

Stash observed state adds this closed component map:

```text
StashComponentChangeUnitIds = {
  "staged": string[],
  "unstaged": string[],
  "trackedFinal": string[],
  "untracked": string[]
}
StashObserved = {
  "commitOid": string,
  "componentChangeUnitIds": StashComponentChangeUnitIds,
  "selector": string
}
```

Worktree observed state is also closed:

```text
WorktreeSparseState = {
  "enabled": boolean | null,
  "cone": boolean | null,
  "sparseIndex": boolean | null,
  "patternCount": nonnegative integer | null
}
WorktreeStatusCounts = {
  "staged": nonnegative integer,
  "unstaged": nonnegative integer,
  "submodule": nonnegative integer,
  "conflict": nonnegative integer,
  "intentToAdd": nonnegative integer,
  "untracked": nonnegative integer
}
WorktreeObserved = {
  "headOid": string | null,
  "branchCarrierId": string | null,
  "ignoredPathCount": nonnegative integer | null,
  "sparse": WorktreeSparseState,
  "statusCounts": WorktreeStatusCounts,
  "statusFingerprint": string,
  "main": boolean
}
```

`stashOid` and `observedSelector` identify the observed reflog entry. The base,
index, tree, and untracked OIDs are nullable because malformed, missing, or
partial topology can prevent parents or the exact stash commit tree from being
proved. Valid topology resolves `treeOid` through Git's tree-peeling revision
operator applied to the stash OID.
`untrackedOid` is also null for a valid two-parent stash with no untracked
parent. On malformed or unavailable topology, all unavailable topology-derived
OIDs, including `treeOid`, remain null and the carrier remains present with
partial evidence,
`stash-proof-incomplete`, and an affected `stash-topology-incomplete` gap; it
cannot receive `drop-stash`. No identity field is filled from a stash message or
other display text.

The four component arrays preserve source-specific snapshots. `staged` is exact
base-to-index evidence, `unstaged` is exact index-to-stash-tree evidence,
`trackedFinal` is exact base-to-stash-tree reporting and review evidence, and
`untracked` is exact third-parent evidence. The carrier's retention
`changeUnitIds` is exactly staged plus unstaged plus untracked, not
`trackedFinal`. This preserves distinct index and final snapshots and keeps
staged-only duplicate behavior stable.

### GitHub branch and pull request evidence

A pull request is a closed, non-durable evidence record attached to a carrier
only after strict repository and head matching. The collection's base
repository identity is also closed:

```text
GitHubRepositoryEvidence = {
  "id": string,
  "nameWithOwner": string,
  "host": string,
  "displayUrl": string
}
GitHubBranchEvidence = {
  "id": string,
  "repositoryId": string,
  "refName": string,
  "tipOid": string,
  "protected": boolean
}
GitHubBranchAttachment = {
  "repositoryId": string,
  "refName": string,
  "tipOid": string,
  "protected": boolean
}
GitHubHeadRepositoryInput =
  { "id": string, "name": string, "nameWithOwner": string } | null
GitHubCheckRunInput = {
  "__typename": "CheckRun",
  "completedAt": string | null,
  "conclusion": string | null,
  "detailsUrl": string | null,
  "name": string,
  "startedAt": string | null,
  "status": string,
  "workflowName": string | null
}
PullRequestCheck = {
  "type": "check-run",
  "name": string,
  "workflowName": string | null,
  "status": "COMPLETED" | "EXPECTED" | "IN_PROGRESS" | "PENDING" |
            "QUEUED" | "REQUESTED" | "WAITING",
  "conclusion": "ACTION_REQUIRED" | "CANCELLED" | "FAILURE" |
                "NEUTRAL" | "SKIPPED" | "STALE" | "STARTUP_FAILURE" |
                "SUCCESS" | "TIMED_OUT" | null,
  "startedAt": RFC-3339 string | null,
  "completedAt": RFC-3339 string | null,
  "detailsUrl": string | null
}
PullRequestEvidence = {
  "id": string,
  "headRepositoryId": string | null,
  "headRepositoryName": string | null,
  "headRepositoryNameWithOwner": string | null,
  "number": positive integer,
  "headRefName": string,
  "baseRefName": string,
  "headOid": string,
  "baseOid": string,
  "state": "OPEN" | "CLOSED" | "MERGED",
  "isDraft": boolean,
  "mergedAt": RFC-3339 string | null,
  "url": string,
  "mergeStateStatus": "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" |
                      "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE",
  "reviewDecision": "APPROVED" | "CHANGES_REQUESTED" |
                    "REVIEW_REQUIRED" | null,
  "checks": PullRequestCheck[],
  "hasFailingChecks": boolean,
  "hasPendingChecks": boolean,
  "exactHeadMatch": boolean
}
```

The GitHub reader requests exactly `number`, `state`, `isDraft`, `mergedAt`,
`headRefOid`, `headRefName`, `headRepository`, `baseRefOid`, `baseRefName`,
`url`, `mergeStateStatus`, `reviewDecision`, and `statusCheckRollup`.
`headRepository` must have the exact live shape shown above or be null. Every
check-run input must have exactly the eight `GitHubCheckRunInput` keys before
normalization.

Repository discovery uses exact argv
`gh repo view --json id,nameWithOwner,url`. `parseRepository` accepts only the
closed response, safely parses its HTTPS `url`, derives `host` solely from that
URL's hostname, lowercases it, and revalidates it as a canonical hostname.
Branch inventory then uses the exact argument array:

```text
gh api repos/<validated-owner>/<validated-repo>/branches?per_page=100 --hostname <repository.host> --paginate --slurp
```

Owner/repository and hostname values are independently canonicalized before
argument construction. No remote URL, display name, branch value, environment
value, or fallback host may supply `--hostname`. This rule applies equally to
GitHub.com and GitHub Enterprise hosts.

GitHub branch inventory emits only the five `GitHubBranchEvidence` fields.
Matching remote carriers store the four-field attachment at
`observed.githubBranch`; a remote-only carrier also stores `observed.refName`.
Attachment requires exact repository ID, ref name, and tip OID. Exact matches
add `github-branch-exact-head` plus either `github-branch-protected` or
`github-branch-unprotected`. Protected matches add blocker
`remote-branch-protected`.

An invalid branch OID records `github-branch-oid-invalid`; unavailable inventory
records `github-branches-unavailable`; truncation records `maxRefs-limit`; and a
local remote-tracking ref whose OID differs records `remote-tracking-drift`.

For remote-only GitHub branches, object availability is one strict batched
`git cat-file --batch-check=%(objectname) %(objecttype) %(objectsize)` process.
The analyzer deduplicates all validated tip OIDs and supplies them together.
Exact `<oid> commit <size>` output proves local availability. Exact
`<oid> missing` proves absence. Any missing, malformed, unknown, non-commit, or
unmatched response is unavailable and never treated as content proof.
Failure of the strict batch read or parser records
`remote-content-availability-unavailable` for the affected branch IDs.

Unavailable remote-only content is metadata-only with partial evidence, action
`keep`, `eligible: false`, recommendation `defer`, blocker and gap
`remote-content-unavailable`, blocker and gap
`isolated-acquisition-required`, and exactly one deterministic prerequisite ID.
The carrier records that ID as its sole acquisition `prerequisiteIds` entry.
Only OIDs proved present proceed to merge-base and change-unit collection, still
subject to `maxComparisons`. Acquisition remains a separately approved external
workflow followed by fresh analysis.

`GitHubRepositoryEvidence.id` is the immutable base repository identity. The
head repository fields identify its immutable head repository and sanitized
display names. A deleted or unavailable head repository is retained safely with
all three head repository fields null and cannot match a carrier. Names and refs
are untrusted strings, but exact `headRefName` is part of the closed PR join
identity. OIDs use the repository object format. Pull request
and check URLs must be sanitized HTTPS URLs without credentials, query, or
fragment. Nullable or empty workflow name, conclusion, timestamps, details URL,
and review decision normalize to null.

`checks` is the normalized check summary and contains at most 100 entries. More
than 100 check records, an unknown union member, an unknown status or
conclusion, or a malformed check makes the affected GitHub evidence unavailable
rather than silently truncating it. Failing conclusions are exactly
`ACTION_REQUIRED`, `CANCELLED`, `FAILURE`, `STALE`, `STARTUP_FAILURE`, and
`TIMED_OUT`. `hasFailingChecks` and `hasPendingChecks` are derived only from the
complete bounded array. `id` is stable over the head repository ID, PR number,
and exact head OID. Normalized, unjoined PR records carry
`exactHeadMatch: false`. Serialized PR evidence attached to a carrier carries
`exactHeadMatch: true`; no record with `false` may be attached.

A PR attaches to a branch carrier only when its non-null immutable
`headRepositoryId` equals the current `GitHubRepositoryEvidence.id`, its exact
`headRefName` equals the carrier ref name, and its exact `headOid` equals the
carrier tip OID. A repository display name, PR number, or commit message never
substitutes for those identities. A same-name or same-OID head from a fork with
a different immutable head repository ID is a collision and does not attach.

An attached PR adds carrier blocker code `pr-open` when open and `pr-draft` when
draft. It may add observations `github-pr-exact-head`, `pr-open`, `pr-draft`,
`pr-closed-unmerged`, `pr-merged-exact-head`, `pr-check-failure`,
`pr-check-pending`, `pr-review-approved`, `pr-review-changes-requested`,
`pr-review-review-required`, and exactly one of `pr-merge-state-behind`,
`pr-merge-state-blocked`, `pr-merge-state-clean`, `pr-merge-state-dirty`,
`pr-merge-state-draft`, `pr-merge-state-has_hooks`,
`pr-merge-state-unknown`, or `pr-merge-state-unstable`. These derived values are
carrier fields, not additional `PullRequestEvidence` fields. They reference the
carrier's stable subject ID and never make the PR a carrier or preservation
witness. Any malformed, partial, unknown, or over-budget required PR evidence
fails closed.

Pull request collection requests exactly `maxPullRequests + 1` records, never an
unbounded list. The extra record is a truncation sentinel. If present, the
analyzer retains at most `maxPullRequests`, marks pull request coverage partial,
adds a `maxPullRequests-limit` gap, and reports the sentinel as one skipped
record. It never presents that sentinel count as the exact number remaining.

The complete carrier record is:

```text
Carrier = {
  "id": string, "type": string, "displayName": string,
  "identity": <matching tagged identity>, "observed": object,
  "changeUnitIds": string[], "changeUnitsComplete": boolean,
  "evidence": "complete" | "partial" | "blocked",
  "durability": "durable" | "non-durable" | "unknown",
  "protection": "protected" | "unprotected" | "unknown",
  "protectionEvidence": "complete" | "partial" | "blocked",
  "identityCurrent": boolean, "survives": boolean,
  "observations": ObservationRef[], "action": <carrier action>,
  "eligible": boolean, "preservationWitnessIds": string[],
  "prerequisiteIds": string[], "blockerCodes": string[]
}
```

The five affirmative proof fields (`changeUnitsComplete`, `evidence`,
`protectionEvidence`, `identityCurrent`, and `survives`) fail closed. A missing
field never counts as complete, current, or surviving evidence and therefore
cannot establish a last-copy witness.

Work-item recommendation and carrier action are separate. For example,
`delete` may pair with `keep` on the retained branch and `drop-stash` on an
exact duplicate stash. `keep-save` may pair with `keep` plus a save
prerequisite for a non-durable dirty worktree. No renderer may infer one
carrier action from the disposition alone. A planner must construct, prove, and
display every destructive per-carrier action independently.

A destructive carrier action requires a `delete` recommendation, but a
`delete` recommendation does not require an immediately executable carrier
action. This permits an exact merged remote head to be identified as completed
work while its remote deletion remains withheld for a separately approved,
expected-OID handoff.

`analyze` always emits `actionPlan: null`. Only a stable `revalidate` may
return:

```text
ActionPlan = {
  "basedOnRunId": string, "selectedCarrierIds": string[],
  "revalidatedAt": RFC-3339 string, "authorized": false,
  "steps": [{
    "id": string, "carrierId": string, "action": <carrier action>,
    "executable": "git" | "gh" | "filesystem",
    "argv": string[], "expected": { <typed identity field>: string },
    "witnessIds": string[], "prerequisiteIds": string[],
    "approvalClass": string
  }]
}
DriftRecord = {
  "subjectId": string, "field": string,
  "expected": string | null, "observed": string | null, "code": string
}
CompatibilityProjection = {
  "high": string[], "medium": string[], "low": string[]
}
```

The guarded plan is still inert and carries no authorization. Its containing
plan always has `authorized: false`; no analyze or revalidate result grants
permission to execute a step.

Arrays are sorted by stable ID, except action steps, which are dependency
ordered, and stash drops, which are descending by revalidated selector index.

## Evidence and retention invariants

Evidence is categorical, not numerically scored. Weak observations cannot
outvote a blocker.

Carriers may share a work item only through an exact commit or tree OID, the
same complete change-unit set, an observed worktree/branch relationship, an
observed tracking relationship with OIDs, or a pull request relationship with
exact repository and head identity. Names, messages, subjects, path
similarity, age, and model similarity are hints only.

A pull request is evidence, not a carrier. It is never durable and never a
preservation witness. A merged pull request proves only the exact observed
head. Commits added after that head remain unique work.

### Default branch identity

Branch collection resolves the default exclusively from the locally observed
`refs/remotes/origin/HEAD` symbolic ref using
`git symbolic-ref --quiet refs/remotes/origin/HEAD`. The LF-terminated target
must be valid UTF-8, remain below `refs/remotes/origin/`, name a branch other
than `HEAD`, and match an exact inventoried remote target object. Its suffix is
mapped to `refs/heads/<name>` only for local default-branch protection. Its
remote target OID is the comparison base.

No `main`, `master`, other-remote, local-branch, or display-name fallback is
allowed. Missing, malformed, non-origin, non-UTF-8, or dangling identity adds
coverage gap `default-branch-identity`. Every ordinary local branch then has
`protection: "unknown"`, `protectionEvidence: "partial"`, and blocker
`default-branch-identity-unknown`, so no destructive action is eligible.
Explicit policy-protected refs remain `protected` with complete policy evidence
but still receive the default-identity blocker.

### Branch ancestry proof

Every local branch and locally available remote ref records:

```text
BranchAncestry = {
  "mergeBaseOid": string,
  "ahead": nonnegative integer,
  "behind": nonnegative integer,
  "state": "identical" | "ahead" | "behind" | "diverged",
  "mergedIntoDefault": boolean,
  "reachableFromDefault": boolean
}
```

The analyzer resolves `mergeBaseOid` with `git merge-base <default> <tip>`.
It obtains counts from
`git rev-list --left-right --count <default>...<tip>`: the left count is
`behind` and the right count is `ahead`. State is `identical` for zero/zero,
`ahead` for positive/zero, `behind` for zero/positive, and `diverged` when both
are positive. `mergedIntoDefault` and `reachableFromDefault` are true exactly
when `ahead` is zero.

Branch change units are the exact `mergeBaseOid` to tip diff. When `ahead` is
zero, the analyzer emits an empty unit set without diffing. Complete proof adds
`branch-no-unique-work` when `ahead` is zero and exactly one of
`branch-identical`, `branch-ahead`, `branch-behind`, or `branch-diverged`.

Merge-base failure records `branch-merge-base-unavailable`; count failure
records `branch-ancestry-unavailable`; diff failure records
`branch-change-units-unavailable`; and exhausting `maxComparisons` records
`branch-proof-limit`. Every branch-proof failure also adds blocker
`branch-proof-incomplete` and prevents destructive eligibility.

### Worktree observed state

The main worktree always has `protection: "protected"`, complete protection
evidence, and blocker `worktree-main`. Status counts are derived from the raw
porcelain-v2 records. Positive conflict, submodule, and intent-to-add counts add
`worktree-conflict`, `worktree-submodule-dirty`, and
`worktree-intent-to-add`. Existing dirty, locked, prunable, missing, and unknown
blockers continue to apply.

Ignored paths are counted only from NUL-framed `! ` records returned by
`git status --porcelain=v2 -z --ignored=matching --untracked-files=all`. Git
rejects this ignored query with `--untracked-files=no`; that combination is not
an allowed fallback. Names and payloads are neither retained nor read. A
positive count on a linked worktree adds `ignored-content-present`; unavailable
evidence emits null, blocker `ignored-state-unknown`, and gap
`ignored-state-unknown`.

Sparse state is read independently. Unavailable fields remain null and emit the
corresponding `sparse-enabled-unknown`, `sparse-cone-unknown`,
`sparse-index-unknown`, or `sparse-pattern-count-unknown` gap. A missing or
partial field never becomes a false or zero observation.

Before a destructive action is offered or revalidated, the selected set is
evaluated as a whole. For every selected carrier and every one of its change
units, at least one unselected, durable carrier must:

1. be retained by the same action plan;
2. contain the exact change unit or make it reachable from a retained ref;
3. have complete, current identity and protection evidence; and
4. survive all prerequisite and action steps.

These carriers are the unit's last-copy witnesses. A witness may not witness
itself, another selected carrier, a pull request, reflog-only reachability, or
an unverified/non-durable overlay. Missing even one witness blocks the entire
destructive selection.

## Disposition policy

| Disposition | Minimum basis | Authority and constraints |
|---|---|---|
| `delete` | Exact preservation or reachability, complete evidence, exact merged-PR corroboration when applicable, protection clear, last-copy witnesses | Mechanical and `proven` only; per-carrier destructive actions still require approval |
| `keep-save` | Unique non-durable work or a required save prerequisite | Mechanical or user judgment; saving is a separately approved prerequisite |
| `resume` | Unique carrier and viable base are mechanically known | Mechanical for location; intent assessment may be content review |
| `update-rebase` | Unique commits have diverged from the observed default tip | Mechanical for branch state, then user judgment; hand off to established workflow |
| `merge-as-is` | Clean isolated simulation plus bounded code review, repository policy, and passing tests | Content review and user judgment; simulation alone is insufficient |
| `open-pr` | Exact branch identity is ahead of the observed default tip and no open PR exists | Mechanical candidate only; content review is optional, and user approval precedes the PR workflow |
| `defer` | Partial, blocked, ambiguous, unsupported, over-budget, rate-limited, conflicted, or stale evidence | Safe fallback |

A local branch with zero commits ahead and complete reachability proof is a
mechanical deletion candidate when protection and checkout blockers are clear.
An exact live remote head attached to an exact merged PR head receives a
`delete` work recommendation, while the remote carrier remains inert until the
separate remote-deletion handoff. An open PR takes precedence over merged-PR
history at the same head and keeps the work active.

Item-level evidence for a cleanup recommendation is computed from the carriers
proposed for cleanup. Blockers on a retained canonical carrier remain visible
on that carrier but do not downgrade an independently safe worktree removal.
When worktree removal is the only blocker preventing later branch deletion, the
branch records those removable worktree IDs as staged prerequisites.

Normal interactive analysis must invoke a Git Clean style categorized report
through `ask_user`. A prose-only final response is invalid unless the request
used `--dry-run` or explicitly requested report-only output. The report contains
numbered **Safe to Remove**, **Needs Review**, **Keep**, and **Skipped**
sections. It shows at most ten rows per category and states the remaining count.
Every safe row includes its exact target, retained durable carrier, and
analyzer-supported reason. No choice may select a carrier that is not visible in
the same question. The complete categorized report, summary, remaining counts,
and no-authorization notice must be the `ask_user.question` body. They may not
be emitted separately from a context-free choice menu.

The selection choices are all visible safe rows, specific row numbers, review
of medium items, keep everything, and full evidence. A numbered safe selection
goes directly to exact command preview and final per-class approval. It does not
add a redundant per-carrier decision card. The report must state that selection
only builds a command preview and makes no change without separate approval.
Destructive execution remains capped at ten actions per batch.

Default decision cards must:

1. lead with one plain-language decision;
2. give no more than two facts that affect the decision;
3. name exactly one concrete next action;
4. translate internal disposition names rather than exposing them; and
5. name the carrier they concern and, for destructive actions, identify both
   what would be removed and what remains; and
6. keep purpose detail, changed-file paths, OIDs, coverage, proof mechanics,
   blockers, and diagnostics behind `Show full evidence`.

Mechanically proven duplicate cleanup does not require semantic content review
before it is shown or selected. If an accepted bounded review exists, the
dashboard may use its summary. Otherwise it describes the group as an exact
duplicate of the retained carrier. Selection remains intent only and does not
authorize cleanup.

For a dirty linked worktree, the default decision says not to delete it yet and
shows the shortest safe sequence: save the changes, remove the worktree, then
reconsider the branch. Every mutation retains separate approval and fresh
revalidation.

Age changes review priority only. Dirty, conflicted, locked, or unknown
worktrees cannot receive `remove-worktree`. Missing objects, truncation,
unsupported formats, skipped content, command failure, and remote uncertainty
prevent `delete`. Exact binary OIDs may prove identity; semantic review may not
make claims about binary payloads.

The compatibility projection is: HIGH only for `proven` mechanical evidence
with no blocker; MEDIUM for strong non-conclusive mechanical evidence or
complete user-judgment evidence; LOW for content review, incomplete evidence,
conflicts, or preservation uncertainty. Projection never changes policy.

## Review monotonicity

Semantic review enters policy only as
`applyReview(mechanicalResult, constrainedReview)`. The review input is
strictly validated as defined in
[Content review](../../../skills/git-tidy/references/content-review.md).

For each affected item, `applyReview` may preserve its state or:

- change the disposition only toward `keep-save`, `resume`, or `defer`;
- add blockers, risks, reasons, and preservation prerequisites;
- reduce confidence in the order `proven`, `strong`, `indicative`, `unknown`;
- reduce evidence from `complete` to `partial` or `blocked`; and
- turn a destructive carrier action into `keep` or `no-action`.

It may not add entities or identities, remove a blocker, add or strengthen a
destructive action, add a witness, change an observed fact, or increase
confidence or evidence completeness. Invalid review rejects the whole review;
the unchanged mechanical result remains authoritative.

### Review application adapter

The shipped adapter is invoked with no additional arguments:

```text
node scripts/apply-review.mjs
```

It performs no Git, GitHub, network, shell, model, or repository discovery. It
reads one UTF-8 JSON object capped at 20 MiB from stdin with the exact closed
shape:

```text
ReviewApplicationInput = {
  "result": <closed analyze 1.1.0 result with actionPlan: null>,
  "review": <strict review object>
}
ReviewDiagnostic =
  { "code": string, "path": string } |
  { "code": string, "path": string, "workItemId": string }
ReviewApplicationOutput = {
  "accepted": boolean,
  "result": <original or monotonically weakened result>,
  "diagnostics": ReviewDiagnostic[]
}
```

Unknown fields, malformed JSON, unsupported versions, and input beyond the
stdin bound fail closed. Rejection returns the unchanged mechanical result with
diagnostics. Acceptance returns no diagnostics and may only preserve or weaken
the result under `applyReview`. The adapter never creates or authorizes an
action plan, removes a blocker, adds a witness, or strengthens destructive
eligibility. Its output remains advisory and does not replace any selection,
approval, or revalidation gate.

## Limits

Analyzer-enforced proof budgets are 2,000 refs, 2,000 tags, 500 stashes, 100
worktrees, 500 retained pull request records using the limit-plus-one sentinel,
1,000 recovery artifacts, 20 reported large blobs, 20 MiB stdout and 2 MiB
stderr per command, 20,000 comparisons, and 50,000 change units.
Commands time out after 30 seconds and collection after 180 seconds.
Configured `maxPullRequests` values range from 0 through 9,999.

Analyzer-enforced untracked hashing budgets are 1,000 files, 64 MiB per file,
and 512 MiB total. Ignored files are not hashed without separate approval.

Analyzer-enforced review budgets are 20 work items, 25 text files and 2,000
changed lines per item, 200 KiB per file, and 1 MiB sanitized diff text per
run. A fixed parser bound accepts at most 100 normalized check records per pull
request; overflow makes GitHub evidence unavailable.

Crossing a budget records a coverage gap and blocks destructive action for the
affected work. It does not discard metadata or exact evidence already safely
collected.

## No-mutation boundary

Analysis and revalidation must leave target refs, reflogs, index, worktree
files and status, config, object count and IDs, and worktree registration
unchanged. They do not fetch, prune, checkout, switch, apply, pop, clean,
reset, create or update refs, rebase, merge, push, add/remove worktrees,
expire reflogs, run garbage collection, or invoke GitHub writes.

Remote refresh or acquisition is never an analyzer action. A separately
approved external workflow may refresh or acquire remote evidence, after which
the analyzer must start a new run; no prior result or approval survives that
state change. Ignored-content reading and an isolated merge-simulation helper
are optional orchestration actions outside the analyzer boundary. Each requires
exact, separate approval and an identified location before any write. The
simulation helper must use an isolated temporary Git directory and isolated
object directory with the target object databases exposed only as read-only
alternates, as specified in the command recipes. If that isolation cannot be
guaranteed, authoritative simulation is unavailable and the outcome is
`defer`. Approval for one action never authorizes another or cleanup.

## Revalidation and approval

`revalidate` receives a prior `1.x` result and selected carrier IDs through
stdin. It re-reads every selected and witness identity, local and remote OID,
stash selector-to-OID mapping, worktree status fingerprint, protection state,
pull request state, prerequisite result, and last-copy proof.

If nothing drifted, it emits a fresh guarded action plan. Any changed, missing,
newly protected, incomplete, or unqueryable value emits no action plan,
enumerates drift, and requires new analysis and approval. Revalidation never
fetches and never executes a plan.

Selecting a disposition, approving content access, approving a refresh, or
approving temporary analysis does not authorize recovery or cleanup. Every
mutation class and every GitHub write receives its own exact approval after
the command, identities, effects, ordering, recovery, and witnesses are shown.
Immediately before each action, revalidation runs again. See
[Approval flow](../../../skills/git-tidy/references/approval-flow.md).

## Compatibility

- Existing scopes and `--dry-run` remain valid.
- HIGH/MEDIUM/LOW remain a presentation projection, not the canonical schema.
- `metadata` remains available but cannot claim work-bearing deletion safety.
- Consumers support all `1.x` additive versions they understand and fail
  closed on unknown major versions.
- Legacy rows are never allowed to restore age-only stash deletion,
  name-only pull request joins, dirty-worktree removal, dead-remote guesses, or
  preselected recovery-destroying maintenance.

## Rollout requirements

1. Correct unsafe legacy classifications before freezing this contract.
2. Route the skill through the four focused references.
3. Require deterministic unit/integration safety tests, cross-platform CI,
   strict eval lint, capability thresholds, and no-mutation snapshots before
   release.
4. Keep `proof` as the default for work-bearing scopes only while those gates
   pass.
5. Keep `metadata` as an explicit compatibility mode and `review` as opt-in.
   Any default-on review requires a later proposal and production evidence.

No phase may loosen the last-copy invariant or approval separation.

## Acceptance criteria

1. Unique work is never a deletion candidate, regardless of age.
2. Exact duplicates may be deletable only when the selected batch leaves a
   durable last-copy witness.
3. Pull request evidence joins by repository identity, exact head ref name, and
   exact head OID and is never durable.
4. Every work item has one of seven user-requestable work outcomes; destructive
   operations exist only as independently proved per-carrier actions and are
   never inferred from `delete`.
5. Source-specific stash, branch, remote, worktree, and special-file semantics
   follow the evidence reference.
6. Partial, hostile, unsupported, over-budget, or drifted evidence fails
   closed.
7. `applyReview` is strict and monotone.
8. Analysis and revalidation do not mutate local Git or GitHub state and never
   perform remote refresh.
9. Optional analysis, recovery, each mutation class, and each GitHub write
   have separate approvals.
10. Node.js `>=22` is preflighted; missing or older Node limits orchestration to
    metadata and suppresses work-bearing destructive offers.
11. Existing scopes and compatibility presentation remain available through
    the staged rollout.
12. Normal interactive output uses a numbered Git Clean style report with safe,
    review, keep, and protected sections. Every visible safe row names its
    retained copy before selection, and internal outcomes and proof mechanics
    remain behind `Show full evidence`.
13. Dirty linked worktrees present the ordered preservation sequence before any
    deletion decision.

## Impact Scan

- Runtime impact is limited to the `git-tidy` analyzer, review adapter, and
  their Git and GitHub read boundaries.
- Contract impact covers schema `1.1.0`, skill orchestration, focused
  references, deterministic tests, capability evals, and catalog copy.
- Repository quality impact covers the shared Vally dependency, lint workflow,
  and catalog accessibility surfaces exercised by this change.
- There is no database, deployment, authentication, or public service API
  migration.

## Convention Discovery

- Runtime modules use Node.js ESM, dependency-free policy code, closed schemas,
  bounded byte-oriented parsing, and `node:test`.
- Git and GitHub commands use fixed argument arrays, trusted executable
  resolution, isolated configuration, bounded output, and no shell.
- Documentation lives under `docs/`, uses repository-relative links, and keeps
  public behavior aligned across the skill, references, evals, and catalog.
- Repository text uses LF line endings.

## Quality Gates

- All analyzer and integration tests pass with at least 80% line, branch, and
  function coverage.
- Skill and eval specifications pass strict Vally lint without warnings.
- The catalog tests and production build pass, with browser checks showing no
  console errors, failed requests, or horizontal overflow.
- Security, architecture, feature-surface, test-health, dependency, and
  adversarial reviews have no unresolved findings.
- `git diff --check` and the repository CI-equivalent skill test matrix pass.

## Gut-Check Results

- Greenfield: content-aware evidence and categorical proof remain the preferred
  design over age, naming, or score-based cleanup heuristics.
- Proportionality: typed inventories and one shared GitHub environment helper
  directly serve multiple current scopes and subprocess entry points.
- Sunk cost: compatibility is preserved only where it does not weaken
  last-copy proof, strict validation, or approval separation.

## Pre-Completion Interview

No open product or safety questions remain. The requested outcomes, supported
carrier types, decision vocabulary, proof depth, Vally comparison, and separate
approval boundaries were resolved during implementation. Unsupported or
incomplete evidence always resolves to `defer`.

## Done Definition

- Every supported scope returns bounded, typed, decision-ready evidence.
- Stashes, branches, worktrees, remotes, pull requests, tags, artifacts, blobs,
  and maintenance state have explicit keep, resume, update, merge, open, delete,
  inspect, or defer guidance as applicable.
- Destructive work remains inert until exact selection, fresh revalidation, and
  separate user approval.
- Tests, coverage, lint, build, documentation, accessibility, security, and
  adversarial gates pass with no errors or warnings.
- The certified skill is installed from the repository source without changing
  the repository under analysis.
