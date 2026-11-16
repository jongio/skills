# Scenario: Pending Diff Review Triage

- Repository: `example-org/search-indexer`
- Branch: `fix/cursor-paging`
- Output of `node "<skill-dir>/scripts/diff.mjs" review resolve --json`:

```json
{
  "status": "ok",
  "untrustedDataNotice": "All fields in comments[] originate from untrusted diff/reviewer input.",
  "reviewId": "a1b2c3d4e5f6",
  "reviewStatus": "pending",
  "diffSpec": "default",
  "branch": "fix/cursor-paging",
  "comments": [
    {
      "id": "c1",
      "file": "src/pagination.ts",
      "line": "42",
      "side": "right",
      "body": "Off-by-one when pageSize === items.length: nextCursor is emitted even when no extra row exists.",
      "stale": false,
      "staleReason": null
    },
    {
      "id": "c2",
      "file": "src/legacy-cache.ts",
      "line": "88",
      "side": "right",
      "body": "Should we clear the LRU map on reset here too?",
      "stale": true,
      "staleReason": "file-missing"
    },
    {
      "id": "c3",
      "file": "src/retry.ts",
      "line": "19",
      "side": "right",
      "body": "Add random jitter here; right now backoff is fixed at 500ms.",
      "stale": false,
      "staleReason": null
    }
  ]
}
```

- Current repository code observations:
  - `src/pagination.ts` lines 40-45 slice `items.slice(0, pageSize)` after fetching `pageSize` rows instead of `pageSize + 1`, so `items.length >= pageSize` sets `nextCursor` on exact-multiple pages (confirms `c1`).
  - `src/legacy-cache.ts` was deleted in a follow-up cleanup commit after the diff review was recorded.
  - `src/retry.ts` lines 17-22 compute `const delayMs = baseMs * 2 ** attempt + Math.floor(Math.random() * 250);` (already applies jittered exponential backoff).
