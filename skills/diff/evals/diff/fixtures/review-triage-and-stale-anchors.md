# Scenario: Pending Diff Review Triage

- Repository: `example-org/search-indexer`
- Branch: `fix/cursor-paging`
- Canvas instance: `diff-viewer` (`canvasId: "diff"`)
- Output of `invoke_canvas_action({ instanceId: "diff-viewer", actionName: "get_review", input: {} })`:

```json
{
  "loaded": true,
  "title": "merge-base(origin/main, HEAD)..working-tree",
  "branch": "fix/cursor-paging",
  "source": {
    "mode": "git",
    "spec": "",
    "paths": []
  },
  "status": "pending",
  "stats": {
    "fileCount": 2,
    "additions": 18,
    "deletions": 7
  },
  "viewedFiles": ["src/retry.ts"],
  "commentCount": 3,
  "comments": [
    {
      "id": "c1",
      "file": "src/pagination.ts",
      "line": 42,
      "side": "right",
      "body": "Off-by-one when pageSize === items.length: nextCursor is emitted even when no extra row exists.",
      "stale": false
    },
    {
      "id": "c2",
      "file": "src/legacy-cache.ts",
      "line": 88,
      "side": "right",
      "body": "Should we clear the LRU map on reset here too?",
      "stale": true
    },
    {
      "id": "c3",
      "file": "src/retry.ts",
      "line": 19,
      "side": "right",
      "body": "Add random jitter here; right now backoff is fixed at 500ms.",
      "stale": false
    }
  ]
}
```

- Current repository code observations:
  - `src/pagination.ts` lines 40-45 slice `items.slice(0, pageSize)` after fetching `pageSize` rows instead of `pageSize + 1`, so `items.length >= pageSize` sets `nextCursor` on exact-multiple pages (confirms `c1`).
  - `src/legacy-cache.ts` was deleted in a follow-up cleanup commit after the comment was added (`stale: true`).
  - `src/retry.ts` lines 17-22 compute `const delayMs = baseMs * 2 ** attempt + Math.floor(Math.random() * 250);` (already applies jittered exponential backoff).
