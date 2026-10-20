# Synthetic nested filters and shared-assignee groups

## Observations

Project view V_active has an active-only filter. Open parent
example-org/planning#71 "Export rollout" has only closed children #72 and #73.
Its expansion returns no visible rows; direct relationships are intact.
A nested closed grandchild #74 still appears in a different unfiltered view.
Daily Standup groups example-org/planning#75 "Retry tuning" under the combined
assignees contributor-a and contributor-b. A person slice for contributor-a
has not been inspected. API configuration reads succeeded; native UI is unavailable.

## Request

Diagnose the empty expansion, nested filtering and apparently missing person/card.
Preserve hierarchy and assignees. Separate data findings from UI-only verification.
