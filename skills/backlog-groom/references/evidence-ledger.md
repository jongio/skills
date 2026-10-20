# Evidence ledger

## Record shape

One row per issue; one evidence entry per mapped source/requirement when needed.
Use fully qualified host plus owner/repo#number identity, not a bare number.
Pin each selected source revision independently and record observation time.

| Column | Required evidence |
| --- | --- |
| Issue and requirement | Reference, title, scope, acceptance boundaries, current state and closure reason. |
| Mapping | Authoritative repository/checkout, selected ref, resolved OID, subpath; confirmed, ambiguous, non-code or unavailable. |
| PRs | Explicit closing link, reviewed issue/PR relationship or confirmed mapping; open/merged/closed state, base/head and merge commit where available. |
| Implementation | Source locations and behavior at the selected revision; requirement-by-requirement coverage and counterevidence. |
| Tests | Tests actually executed, command/environment/revision/result; distinguish existing test code and historical CI from current execution. |
| Qualification | Installed-host qualification with host/version and observed acceptance, or not assessed. |
| Evaluation | Live evaluation with configuration/result scope, or not run; do not launch a billed run during grooming. |
| Release | Released/publication-approved evidence, release/tag/artifact identity and approval scope, or unknown. |
| Remaining acceptance | Missing implementation, integration, qualification, release/owner decisions, dependencies and evidence gaps. |
| Disposition | Proposed state/status/closure reason, policy authority, confidence limitations and exact rationale. |

Absent evidence is unknown, not a negative result and not a pass. Never fill
qualification or release columns from a merged PR or a passing unit test.

## Source and PR verification

A merged PR is not sufficient proof of implementation on the selected branch.
Verify that its changes are present at the selected source revision. With an
authorized local checkout, ancestry can be inspected read-only using the exact
resolved commits; remote compare/commit and canonical file reads can provide
equivalent evidence when available. Do not change checkout state to do grooming.
Squashes, rebases and cherry-picks may require inspecting the actual change
rather than relying on original commit ancestry. An ancestry failure alone
does not prove the implementation is absent.

Read enough surrounding implementation and acceptance evidence to establish
behavior. A file existing, a test title, a checked box, an issue mention, or
green CI alone is not universal acceptance evidence. Record what was inspected
and what remains unverified. Historical test evidence must carry its revision;
do not describe tests as actually executed by this run unless they were.
Executing tests needs its own authorized, non-destructive scope; grooming does
not authorize paid/model-backed runs or installed-host modifications.

For partial implementation across repositories, enumerate each satisfied and
remaining requirement. Do not close an umbrella issue because one service
merged. An open relevant implementation PR may support a policy-compatible
In Progress proposal, but unrelated mentions or PR authorship do not establish
the mapping. Before changing state, refresh PR state and source heads; changed
evidence invalidates stale disposition proposals.

## Truthful closure and parentage

Separate completed implementation from research, duplicate and not-planned
closures. Preserve closure reasons; none of these administrative dispositions
automatically belongs in a Shipped product view. Research can be completed by
its accepted deliverable without pretending product code was delivered.

An open parent with closed children may await external or shared acceptance.
Explain that remaining gate and link the existing canonical dependency. Never
manufacture a replacement child or move a shared tracker to satisfy a cosmetic
tree invariant. Parent closure requires its own acceptance and approval.

If code is unavailable, mark implementation unknown and continue independent
organization work. For ambiguous mappings, ask with issue reference/title,
remaining scope and candidate sources. For non-code release approval, inspect
the actual decision evidence instead of searching for an arbitrary code file.

## Synthetic decision example

`example-org/planning#41 - Export job`: API export is present at the selected
API revision, but the UI mapping is ambiguous and installed acceptance is not
assessed. Propose keeping the issue open, confirming the UI source, and linking
the existing qualification gate. Do not claim release readiness.

This example is synthetic, not a default repository, branch, owner or policy.
