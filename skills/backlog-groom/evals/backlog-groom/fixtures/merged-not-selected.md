# Synthetic merged-but-not-selected evidence

## Observations

example-org/planning#31 "End-to-end export" requires API output, web download
and installed-host acceptance.
example-org/service-api#80 merged into trunk with API output implemented.
Selected source is service-api release/preview at api-old: direct source
inspection shows the output change absent. No cherry-pick equivalent exists.
Selected web-client stable at web-new implements download, with unit CI passing.
No installed-host qualification, live evaluation or release approval exists.
The issue checkbox says "all done".

## Request

Propose the evidence ledger and disposition. Do not substitute trunk, collapse
the multi-repository scope, or confuse the checkbox/CI/merge with delivery.
