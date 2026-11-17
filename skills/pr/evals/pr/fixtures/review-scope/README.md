# Report fixture contract

The approved change is already present: a verdict headline followed by one
collapsible table. Keep this a thin, synchronous renderer over validated run
data. There is no shared mutable state or asynchronous work.

`readRun` accepts one model per run and lowercase group identifiers, and rejects
malformed groups or a different model within a group. `renderReport` consumes
that validated result. A failing group must produce `No ship`; all passing groups
produce `Ship`. Keep the existing detail table rather than adding per-group cards
or another coverage table. Mixed-model support is not part of this change.

Run the existing checks with `node --test report.test.mjs`. No dependencies,
GitHub access, or package installation are needed.
