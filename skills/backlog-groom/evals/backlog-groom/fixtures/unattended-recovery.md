# Synthetic unattended restart, budgets and mutex

## Observations

For this offline rehearsal only, assume separately supplied valid policy permits
private checkpoint storage and has a 240-second deadline, 10 issue, 20 write,
40 page and three read/reconciliation attempt budgets. It requires daily
reconciliation and deduplicated repeated failure notifications.

Case A: another process owns the atomic per-automation lock. Its deadline has
expired, but there is no evidence the writer stopped.
Case B: this run owns the lock, but its stored pending-plan policy digest differs
from current approved policy. A timed-out membership operation is directly
confirmed present even though the aggregate list omits the item.
Case C: page 1 completed with durable accounted issue IDs/versions. Page 2 failed
with Retry-After beyond the remaining run deadline. Nested candidate pages and
existing-open-issue backfill are incomplete. Several updates share a timestamp.
The checkpoint has reached its size limit and contains unknown operations.
The first permission-denied failure has not been reported; later identical
failures fall inside failureQuietHours.

## Request

Rehearse each case without actual checkpoint or network writes. State safe lock
handling, revalidation, direct-state idempotency, watermark/cursor progression,
budget/deadline behavior, storage limits, failure dedup and future reconciliation.
Do not treat incomplete coverage or quieted errors as success.
