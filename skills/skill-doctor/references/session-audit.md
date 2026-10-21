# Session discovery and incremental state

## Read history, not summaries

Use the host's available history API. Discover its schema before querying.
Stay within the signed-in user's personal scope; do not broaden to organization
history. If unavailable, request an authorized export and disclose partial coverage.
Never scan the whole disk or bypass denied access.

Freeze an inclusive start and exclusive end in UTC. Default to seven elapsed days
ending now. Accept a positive number of days or explicit zoned start/end; clarify
ambiguous natural-language dates. A wider range is explicit permission to widen
history discovery, not permission to publish its contents.

Discover sessions by **activity**, not creation date. With a SQL history tool,
page session IDs from turns/events in `[start, end)`, using stable time/ID cursors
and bounded results. Include tool-only activity where exposed. Fetch metadata for
those IDs separately. Do not filter by the target repository: application sessions
can expose failures in skills maintained elsewhere. Keep backend namespaces
separate; deduplicate cloud/local copies only with a verified shared identity.

The window selects sessions, not fragments to mark fully reviewed. For each
selected session, review its complete evidence through the fixed cutoff: actual
user turns, assistant responses, skill invocations, and relevant tool outcomes,
including earlier turns. This makes a completed revision reusable when the next
run widens or shifts its window. Paginate until exhausted; a result
limit, missing event stream, or assistant summary is not complete evidence.
Avoid unbounded text searches; first narrow by time and exact session IDs.
Do not query live history for synthetic eval scenarios.

## Cache protocol

### Independent terseness pass

Inventory canonical skills under the resolved target; do not limit this pass to
skills invoked in recent sessions. Read each skill and its instruction references.
Look for repeated rules, verbose setup, filler, duplicated examples, and obsolete
instructions whose redundancy can be proven against current source.

Map each deletion or rewrite to the retained rule. Preserve triggers, boundaries,
approval gates, exception handling, decision order, and examples needed to choose
correct behavior. Prefer deleting or rewriting to relocating text. Put genuinely
optional lookup detail in references only when it improves progressive disclosure;
report moved text separately, not as removed bloat.

Count words and nonblank lines before/after across all touched instruction files,
including references. Also show the loaded SKILL.md delta. Reject gains from
packing sentences onto one line, cryptic abbreviations, or deleting necessary
conditions. Recheck representative decisions and existing tests/evals. There is
no required reduction quota; skip already concise skills.

Cache this pass independently with the helper's same snapshot schema: set
`source` to `skill-source-v1`, `account` to `target-local`, `id` to the canonical
target-relative skill path, and `revision` to SHA-256 of its sorted relative paths
and exact instruction/reference contents. Adding, deleting, or editing an
instruction file must change the hash. Keep path separators and ordering stable.
Do not include mtimes, cache files, dependencies, or generated art.

These source snapshots go in the input's `sessions` array alongside, or separately
from, history snapshots. Their namespace prevents collisions. Mark them complete
only after the entire terseness pass; use the same pending/delivered receipts.
Unchanged source snapshots skip this pass even when session collection runs again.
Changed sources are reconsidered even if all historical sessions are unchanged.
New session findings may still require edits to a source cached as concise.
Missing history does not block this independent pass, but the overall report must
retain that coverage gap. Combine justified terseness and behavioral fixes into
the same PR, clearly separating behavior-preserving trims from new rules.

### Helper usage

The bundled helper requires Node 22.20+ and Git. It makes no network calls and
never changes the target repository. Resolve `<skill-dir>` from the loaded skill;
run the helper by absolute path. Adapt separators to the host OS.

```text
node <skill-dir>/scripts/cache.mjs plan --target <target> --input <snapshots.json>
node <skill-dir>/scripts/cache.mjs plan --target <target> --input <snapshots.json> --days 14
node <skill-dir>/scripts/cache.mjs plan --target <target> --input <snapshots.json> --since 2026-10-01T00:00:00Z --until 2026-10-08T00:00:00Z
node <skill-dir>/scripts/cache.mjs record --target <target> --input <results.json> --expected <token>
```

Call `plan` first with `{"sessions":[]}` to freeze its returned window and discover
pending receipts. Use that exact `--since` and `--until` for subsequent plans.
The default cache lives at `~/.cache/skill-doctor`; `--cache-dir` overrides it.
Keep it outside every repository, shared folder, or installed skill. The cache is
namespaced by canonical Git common directory and target-relative skills directory,
so separate worktrees share it but different targets do not.

Input is a local JSON object with a `sessions` array:

```json
{
  "sessions": [
    {
      "source": "cloud",
      "account": "personal-account-namespace",
      "id": "opaque-session-id",
      "revision": "authoritative-revision-or-content-sha256",
      "complete": true
    }
  ]
}
```

Use an authoritative full-session revision that changes for every new/edited turn
and tool outcome. A session `updated_at` is sufficient only if the provider
guarantees that property and precision; never use a date-only last-run marker.
Otherwise hash canonical, ordered evidence records, including tool outcomes.
Do not include retrieval time, the sliding window, or volatile usage counters
in the revision. Keep the same complete evidence scope across runs; when changing
the collector or coverage semantics, version the `source` namespace.

A revision probe may precede expensive content retrieval. Set `complete: true`
only after all evidence needed for the audit was actually read. `plan` will skip
an already-completed revision even on a metadata-only probe; a new incomplete
snapshot still needs reading and must not be recorded. If the session changes
during collection, refresh/retry that session or leave it unrecorded.

`plan` returns `audit`, `skip`, or `resume` per snapshot and lists **all** pending
receipts, including older revisions and sessions outside the requested window.
An unchanged completed session needs no new analysis. Changed sessions need new
analysis but not duplicate fixes: reconcile their lessons against existing
pending receipts, open PRs, and current source. A closed-unmerged PR is not a
landed fix; report it and ask whether to resume rather than silently reopening.

For `record`, add `status` to each completed snapshot:

- `no-change`: complete evidence review found no justified outstanding fix.
- `pending`: review completed but editing, checks, approval, or delivery remain.
- `delivered`: the intended PR was independently verified open at the right head.

`pending` requires `receipt`, an absolute path to a durable private JSON receipt
outside Git. `delivered` also requires `pr`, a verified HTTPS GitHub PR URL.
The receipt holds original snapshot descriptors (needed to resume recording),
sanitized lessons, source-file mapping, worktree/branch/base, progress, and PR/head
when known. These identifiers stay private. Do not put raw transcripts or secrets in it.
Update it as work progresses; preserve it while delivery is pending. Never mark
partial/failed reads `no-change`. A cache hit records past audit/delivery, not
proof of current PR state or that a change merged.

The helper stores only identity/revision hashes, status, checked timestamp, and
receipt/PR pointers, not raw session content or raw account/session identifiers.
Snapshot keys retain old pending revisions rather than overwriting their work.
Use the plan's `token` with `record` for optimistic concurrency; obtain the new
token after each write. On a stale token, replan and reconcile; do not overwrite.
Writes use an exclusive lock and atomic replacement. Lock contention, corruption,
permission failures, or missing receipts stop recording explicitly. Do not delete
locks or reset a cache automatically.

If cache access fails, report it and pause before repeating expensive analysis;
ask whether to proceed without caching. Never treat an unreadable cache as empty.
If no changes are justified, record the complete audits without creating a
worktree or empty PR. If changes are justified, persist pending state before PR
delivery, and advance it only on verified success. No last-run timestamp may
replace per-session coverage.
