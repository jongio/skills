# Synthetic multi-repository source interview

## Observations

Issue sources are example-org/planning and sample-team/support.
example-org/planning#41 "Export job" spans an API and web client.
sample-team/support#41 "Retry export" may share the API implementation.
Code sources are example-org/service-api (default branch trunk) and
sample-team/web-client (default branch stable; release/export also exists).
The user has not selected the web-client ref or confirmed the second mapping.
The current checkout is an unrelated documentation repository.
API trunk resolves to synthetic revision api-a; stable to web-a and
release/export to web-b. These are fixture labels, not real Git object IDs.
Observation labels T1 and T2 are synthetic, not actual timestamps.

## Request

Start a read-only grooming interview without assuming a Project or code mapping.
Show the known scope, unresolved questions and how each selected revision will
be pinned independently. Ask only for missing decisions, with issue context.
