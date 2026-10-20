# Synthetic concurrent view changes

## Observations

At T1, view V_keep has URL ending /views/7, columns [Title, Status, Assignees],
and filter is:open. An approved plan would add Next action.
At T2, a collaborator changes columns to [Title, DRI, Release, Status] and the
filter to is:open milestone:Preview. The view version changed.
The selected API does not offer an atomic conditional write for this setting.
No approval allows deleting columns or overwriting the new filter.

## Request

Rehearse revalidation and explain the race/approval boundary. Preserve V_keep,
its URL and newer edits; do not apply the stale replacement configuration.
