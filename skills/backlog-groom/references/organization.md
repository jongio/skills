# Organization and views

## Adapt existing semantics

Inventory native types, labels, milestone commitments, relationship conventions,
project fields and shared organization fields, including definitions and populated values.
Resolve bindings by scope, type and meaning, not name alone. Shared fields may
not apply to every repository, owner or item type: an unavailable value is not
automatically unassigned. Discover support on the authenticated host.

- Distinguish parentage (scope) from dependency (ordering). Check the affected
  graph for cycles, contradictory ownership and existing canonical trackers
  before proposing relationships. Do not impose initiative/epic/workstream
  levels on every repository or move shared dependencies under a new parent.
- Preserve all collaborators in Assignees. An existing shared DRI/owner field
  can identify one confirmed accountable person without replacing collaborators.
  A PR author is not automatic owner authority. Ask before selecting between
  shared assignees or assigning unowned work, including unowned epics.
- Prioritize by demonstrated dependencies, commitments and impact. Do not
  invent urgency, effort, dates, health or sprint cadence.
- Milestones are scoped delivery commitments, not decorative copies of epics;
  optional backlog is not automatically part of a release.

## Fields and preserved values

Reuse existing shared DRI/health/effort/date fields when meanings and applicability
fit. Do not create a parallel project field just because it is easier to write.

Project Now/Next/Later ordering may differ from organization urgency. Project
Status may differ from shared Global Status. Map vocabulary only with evidence
and user policy; do not synchronize similarly named fields blindly.

Keep fields lean: a confirmed DRI, source-grounded Next action, owner-assessed
health and useful Updated/Closed metadata are candidates, not requirements.
Blank health means unassessed, not on track.

Preserve existing dates and release metadata. An existing target is not
automatically a confirmed commitment when the user says no dates are committed.
Surface the distinction, ask which meaning applies, and neither erase the target
nor silently promote it to a commitment.

Review redundant type/status/priority labels only within approved scope; do not
delete organization-standard definitions or break unrelated integrations.

## Without a Project

Use existing native issue types, parents/sub-issues, blocking relationships,
labels and milestones where available. Document queries scoped to each selected
repository and the user's actual labels/state semantics. Return triage,
dependencies, remaining acceptance and actionable next decisions even if
Project creation is declined or permissions are repository-only.

Do not use a closed-issue query as a proxy for Shipped. If existing metadata
cannot distinguish delivered scope, report that limitation and propose a
reviewable classification rather than silently relabeling the backlog.

## With a Project

Inspect exact membership and existing view identities before reconciling. Reuse
present items; relevant PRs can appear as issue evidence without importing every
PR as a new item. Preserve existing URLs, links and unrelated configuration.

Propose/adapt only views that help actual decisions:

| View | Decision and verification |
| --- | --- |
| Backlog | Active hierarchy and work. Check completion filters on nested children, not only roots. |
| Triage / Needs Owner | Missing canonical accountability or another explicit quality gap; distinguish unsupported fields from empty values. |
| Daily Standup | Status, people, source-grounded next action, PRs and blockers. Diagnose shared-assignee groups and person slicing before concluding people/cards are missing. |
| Delivery Overview | High-level outcomes with detailed work and truthful rollups of actual remaining scope. |
| Shipped | Completed implementation with drill-down. Exclude research/duplicate/not-planned closures through confirmed evidence/classification, not brittle title exclusions. |
| Release Readiness | Actual milestone gates, qualification and owner decisions; optional backlog is not a release gate. |
| Roadmap | Date/iteration timeline only with credible scheduling evidence; otherwise explicit unscheduled or continuous-flow planning. |

For each view record its ID, current configuration, purpose, filters, expected
population and observed population. Verify nested descendants independently.
An active-only open parent with only closed children legitimately expands to
no rows. Do not reopen children, alter parentage or add fake children to fill it.

Successful configuration writes do not prove rendered hierarchy, expand/collapse,
field visibility or person slicing. Use native UI only if authorized, available
and not occupied by another session; otherwise list the exact manual check.
Read current configuration immediately before updates and preserve newer edits.
