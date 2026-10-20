# Synthetic shared field reuse

## Observations

Organization fields: Field_Dri (person, accountable owner), Field_Health
(owner-assessed), Field_Urgency (Critical/Normal), Field_Global (delivery state).
Project fields: Field_Order (Now/Next/Later planning order), Field_Status
(Todo/Doing/Done local workflow).
example-org/planning#91 "Retry export" has Field_Dri=contributor-a,
Field_Health=null, Field_Urgency=Normal, Field_Global=Awaiting qualification,
Field_Order=Next, Field_Status=Doing.
Unrelated release metadata is {target:"candidate-window", channel:"preview"}.
The only requested proposal is a source-grounded Next action.

## Request

Inspect definitions and values, propose lean reuse, and preserve all unrelated
values. Do not create duplicate DRI/health fields or align incompatible statuses.
