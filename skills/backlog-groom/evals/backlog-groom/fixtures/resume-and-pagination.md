# Synthetic paginated restart and uncertain mutation

## Observations

Issue repository A page 1 returns #111 and hasNextPage=true with cursor c1.
Page 2 is rate-limited with Retry-After=120; repository B is inaccessible.
Nested field values also have an unread next page. There is no complete inventory.
An approved field-create operation was pending when the process stopped.
On resume, the direct field record Field_New exists with the intended scope/type.
An approved membership add timed out, but direct item Item_AbC confirms
example-org/planning#111 "Export retry" is present with the intended values.
The aggregate project listing still omits it. The private checkpoint contains
only scope, before-state, pending operations and approval identities.

## Request

Rehearse the resumed plan with bounded recovery and explicit incomplete coverage.
Do not duplicate the field or item, treat access failure as empty, or replay
the campaign. No checkpoint write or external action is authorized in this exercise.
