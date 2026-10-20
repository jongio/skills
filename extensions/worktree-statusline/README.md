# Branch and Worktree Statusline

A grouped, multiline Copilot CLI footer showing session work outside Copilot's
own checkout, with its full path first and its live branch in brackets. When
enabled, the compositor groups related PRs and issues on that checkout's row by
default, with one overall subagent summary on an unlabeled row.

![Illustrative blue branch/worktree pills leading checkout rows, with related PRs, issues, and one overall subagent summary](../../site/public/screenshots/statusline-worktree-grouped.svg)

```text
C:\code\.worktrees\my-project\feat-login [⎇ feat/login*+% origin/feat/login↑1↓2 origin/main↓3]  PR #119  Issue #42
C:\code\.worktrees\my-project\release-check [⎇ release/check origin/main↓2]  Issue #44
Issue #43  2 starting  20 in PR  1 merged
```

Each checkout gets a separate row in `statusline-compose.mjs`, ordered as
checkout, PR pills, then issue pills. A single overall subagent summary appears
on an unlabeled fallback row. Missing categories are omitted. Checkout pills are always
leftmost when shown. Paths are shown in full. Checkout labels are not links;
use `/session-worktree` to inspect the session's directories. No Nerd Font is required.
The native `⎇` branch indicator uses `*` for unstaged changes, `+` for staged
changes, and `%` for untracked files, always in that order. Clean branches have
no markers. A file can have both staged and unstaged changes.

## Upstream and base divergence

The pill keeps local file markers and commit comparisons separate:

| Signal | Meaning |
|---|---|
| `origin/feat/login↑1` | One local commit is not in the configured upstream. |
| `origin/feat/login↓2` | Two upstream commits are missing locally. |
| `origin/feat/login↑1↓2` | Both sides have unique commits: the branch has diverged. |
| `origin/main↓3` | Three commits from the selected base are missing locally. |
| `origin/main?` | The target is known, but its comparison is unavailable. |
| `base?` | A matched PR's base identity is incomplete or conflicting; no other base is substituted. |

Upstream counts compare `HEAD` with its configured tracking ref. Base counts
show only missing commits, not all the feature commits ahead of the base.
The base comes from a uniquely matched tracked PR's target branch/repository,
or, when no PR matches, a locally verified remote default branch. A matched PR
with incomplete or conflicting base metadata shows `base?`, not a default-branch
fallback. Without a matched PR, the remote is the configured upstream's remote,
otherwise `origin`, otherwise the sole configured remote. Its local remote-default
symbolic ref must be valid; no known default means no base indicator. Fork PRs must use the
target repository's remote, not a same-named branch in the fork. The target ref
is always labeled; two comparisons to the same target are not duplicated.
Zero counts and an unconfigured upstream are omitted. Detached or unborn HEADs,
missing refs, and ambiguous metadata never imply an up-to-date branch.

All comparisons use **locally fetched refs**. The footer never fetches or
contacts GitHub for commit counts; fetch through your normal workflow to update
those refs. It never pulls, rebases, merges, or changes branches. Behind does not
mean rebase is mandatory: integrating the base is a separate workflow decision.
Git does not reliably record a branch's historical creation point, so this is a
comparison with its current upstream and selected base, not its "parent branch."

Newlines are preserved in both plain and colored grouped output. The standalone
`render(payload, options)` exports still return strings for standalone use.
Disabling the worktree extension retains the legacy horizontal
compositor. Disabled extensions never render or contribute entries.

## Association rules

- PRs match a unique checkout using their cached head repository URL and head
  branch, compared with that checkout's `origin` URL and live branch. SSH and
  HTTPS GitHub URLs normalize to the same identity, including the hostname.
  A branch name alone is never enough. Multiple matching clones/checkouts are
  ambiguous and stay session-wide.
- An unmatched tracked PR can discover its registered linked worktree from an
  already-known repository with the same head repository identity. Discovery
  requires the exact full branch and live checkout origin to match. Only the
  PR's matching checkout is added, not unrelated entries from the inventory.
  Forks, duplicate matches and unavailable metadata retain the fallback row.
- Issues follow explicit closing-issue links on tracked PRs or linked PR URLs
  from the issue collector. Conflicting or unresolved associations stay on the
  fallback row. Issue numbers or titles are not interpreted as branch mappings.
- Merged PRs and settled subagent counts stay visible until the next real user
  message after their merge/settlement is detected. Polls don't reset that
  boundary. Dismissal also hides now-empty historical rows, even after the last
  grouped PR disappears, while retaining current external working checkouts.
- Subagent-only PR details collapse into one overall subagent summary by
  default when both the PR and subagent extensions are enabled. Counts use
  the existing tracker states (starting, exploring, in PR, merged and failed),
  not one pill per agent or PR. Root-worked PRs keep detailed pills even if an
  agent also references them. Unknown provenance stays detailed, including
  older cached PRs whose full ownership history cannot be proved.
  Delegating a task alone is not direct root PR work. Compaction requires an
  explicit live agent PR association and never hides PRs when the subagent
  extension is disabled or its summary is dismissed. No numeric item cap is used.
- Structured PR entries retain their metadata even when their detailed pills
  are compacted, so linked issues still group under the correct checkout.
  Agent directory history can disambiguate multiple otherwise matching
  checkouts only when the PR's head repository and branch already match.
  An agent that visited multiple checkouts is never assigned exclusively to
  its latest cwd. Its overall count is emitted once, not repeated per checkout.
- Unassigned items and opaque third-party renderer output are retained once on
  a separate unlabeled fallback row. Multiline third-party output keeps its own newlines.
  Copilot's current checkout label remains hidden, but its PRs, issues and
  agents still appear on the fallback row. No empty fallback row is emitted.

GitHub metadata comes from the existing cached collectors, not new compositor
network calls. Existing active PR/issue entries gain metadata on normal status
refresh, or immediately when it is already available in the shared cache.
Old settled entries without provable associations stay session-wide.

## Performance measurements

Run `node scripts/benchmark-statuslines.mjs` from the repository root. An optional
integer argument selects the sample count (at least three). The benchmark reports
median and p95 timings for all four renderers, cold transcript replay, the combined
footer, and command-line invocation including Node startup. It also reports Git
subprocess counts for one directory and 16 directories in the same checkout.
Fixtures and GitHub caches are isolated in a temporary directory and removed
afterward; results do not include live GitHub API latency.

### PR regression gate

The **Statusline performance** workflow runs on every PR, but only runs expensive
measurements when statusline runtime, tests, manifests, installation scripts or
the gate itself change. Documentation, screenshots and site-only changes get an
explicit successful no-op. Maintainers can require the stable
**Statusline performance result** check in branch protection; this does not
configure branch protection automatically.

On both Windows and Linux, correctness tests finish before any measurement.
The candidate's common harness runs against the PR event's exact base commit and
GitHub test-merge commit, in separate processes on the same runner. The contributor
head is recorded as provenance. The base does not need its own benchmark script.
All four statuslines and the combined footer are measured, including warm caches,
cold transcript replay, and Node CLI startup.

Seven-sample medians block only when slower by **both more than 20% and more than
25 ms**. Initially failing timing cases get exactly one fresh confirmation, in
reverse order (candidate then base); persistent breaches block, non-reproducing
ones are marked unstable. p95 is diagnostic only. Git calls must not increase
against base and must stay within candidate ceilings of **4** for one directory
and **19** for 16 directories in one checkout. Functional, subprocess, malformed
report, missing-baseline and cancelled-job failures do not receive timing retries.

Each OS publishes a summary and explicitly named JSON metric artifacts retained
for three days. These contain raw samples, median/p95, case IDs, revisions,
harness digest, Node/Git versions and decisions, including confirmation evidence.
Synthetic caches are isolated, and direct or shell-wrapped `gh` commands fail
instead of contacting GitHub. This guard is not a general-purpose network sandbox.
No dependencies, secrets, PR-comment permissions or cache service are needed.

For a local comparison, prepare a separate base checkout and run:

```powershell
node .\scripts\compare-statusline-performance.mjs --baseline-root C:\path\to\base --candidate-root . --output-dir C:\path\to\metrics
```

Local comparisons default revision labels to each checkout's HEAD; commit or
otherwise account for working-tree changes when interpreting them. CI checks
exact revision labels and checkout HEADs. One local OS pass does not establish
hosted Windows/Linux qualification.

Git context reads are shared only within a single render. Different directories
still resolve their checkout roots independently, so nested repositories are not
conflated. Branch, remote configuration and file-status reads are reused for the
same checkout, including the payload's current directory. The next render reads
live Git state again; no cross-refresh TTL hides file or branch changes.

Terminal footer support for multiple lines still requires testing in the actual
Copilot CLI host. Tests verify emitted text, not the host's presentation,
wrapping or available footer height.

The current working directory comes from Copilot's statusline payload (`cwd`),
not the last tool's directory or the compositor process. Directories within the
same Git checkout count as the same location, so launching Copilot in a
subdirectory does not create a redundant pill. If `cwd` is unavailable, known
session checkouts are shown rather than guessing which one to hide.

## Enable

Run `/statusline-setup` and select **Branch and Worktree**, or use
`/statusline-setup prs issues subagents worktrees` to enable all four.
Existing saved selections are preserved until you opt in.

From a checkout:

```powershell
node .\scripts\setup-statusline.mjs --worktrees --merge
```

The root PowerShell installer also accepts `-Worktrees`; the shell installer
accepts `--worktrees`. Use `--no-worktrees` in the Node/shell installer to exclude
this item. `/session-worktree` lists the session's checkout paths and branches.

## How directory tracking works

- Replays only the active session's transcript, using `session.start`,
  `session.resume`, and `session.context_changed` working-directory metadata.
- Follows successful root-session and subagent shell calls with explicit `cwd`, `workdir`,
  or `workingDirectory` arguments, literal leading `Set-Location`, `cd`,
  `pushd`, or `git -C`. Relative paths resolve against that agent's last known directory.
- Waits for tool completion and ignores failed calls. Subagent checkouts appear
  without replacing the root session's current directory.
  It never executes transcript commands or scrapes paths from prose/tool output.
- Uses the payload's `cwd` only as a fallback when no transcript directory is
  known. A stale launch directory cannot overwrite newer session evidence.
- Reads the branch and checkout from Git on each refresh, including detached
  HEADs and linked worktrees. It does not fetch, change branches, or contact GitHub.
  At most 16 directory/inventory slots are used per refresh, plus the payload's
  current checkout lookup. With PR grouping enabled, four slots are reserved
  for linked checkout discovery: at most two repository inventory queries and
  four candidate checks, sharing those four slots. Each directory check reads
  Git context and one porcelain status, with a 1.5-second timeout per command.
  Repository inventories are cached for 30 seconds in
  `<session_id>.worktrees.json`; candidate verification rotates within the
  remaining budget and expires after 30 seconds. Larger sets rotate through a separate
  `<session_id>.contexts.json` snapshot cache, retaining already discovered
  checkout rows. Discovery, branch changes and removal beyond that budget
  appear on subsequent refreshes.
- Each refreshed, visible checkout adds at most one upstream graph comparison,
  one selected-base graph comparison, and one remote-default symbolic-ref lookup.
  PR-base selection skips the default lookup; identical targets reuse counts.
  Cached checkouts outside the current refresh budget show unavailable comparisons
  rather than reusing stale counts. Git commands retain 1.5-second timeouts,
  bounded output, and disabled lazy fetching, so rendering never downloads objects.
- Hides Copilot's own checkout and shows the root session's external checkout
  first, then other external checkouts used during the session. Deduplicates checkout roots, including subdirectories of
  the same checkout. It does not list unrelated worktrees from other sessions.
  Switching branches in a checkout updates its existing pill rather than
  retaining an obsolete branch. Once PR grouping exists, empty historical rows
  are hidden unless they are the root's current working checkout or a potentially
  working agent's latest checkout. Without grouped PRs, observed checkout labels
  retain their existing behavior. Removed and non-Git directories are omitted.
  `/session-worktree` still lists all session checkouts for inspection.
- Caches the transcript byte offset and pending tool calls under
  `$COPILOT_HOME/worktree-statusline/<session_id>.json`. Reads at most 4 MiB per
  refresh and shows a syncing label while catching up with larger transcripts.
  It waits for incomplete JSONL records and resets on transcript replacement
  or truncation. Schema 1 and 2 caches automatically replay into schema 3 to
  recover the session's checkouts and complete agent directory history.

Only explicit directory evidence is tracked. Dynamically computed shell paths,
later directory changes inside compound scripts, and file paths in editing
tools are not inferred. A later context event or explicit shell directory
restores the authoritative location. Non-Git directories produce no pill;
unexpected filesystem/Git errors are reported by the standalone renderer.

## Validate

```powershell
node --test --test-concurrency=1 .\extensions\worktree-statusline\test\*.test.mjs
```

Run Git-backed test files sequentially, as CI does, so parallel fixture processes
do not compete with the renderer's unchanged 1.5-second Git command budget.
This does not change assertions, benchmark thresholds, or production timeouts.

When updating an existing install, copy every runtime file listed in
`scripts/setup-statusline.mjs`'s `EXTENSION_CATALOG` to
`$COPILOT_HOME/extensions/<id>/`, including the new
`worktree-statusline/grouping.mjs`, `worktree-statusline/worktrees.mjs` and
`pr-statusline/provenance.mjs`, plus `pr-statusline/lifecycle.mjs` and
`subagent-statusline/settlement.mjs`.
Copy the shared `extensions/state-lock.mjs` to
`$COPILOT_HOME/extensions/state-lock.mjs`.
Copy `pr-statusline/compose.mjs` to
`$COPILOT_HOME/statusline-compose.mjs` too. Preserve existing
`statusline-config.json` and `settings.json`; no dependency install is required.
Restart Copilot after copying to reload any already-running collector modules.
For plugin installs, update the same extension assets and
`scripts/setup-statusline.mjs` in every installed plugin source copy too.
Registration reads those source assets at module startup and can otherwise
replace updated runtime files with older copies.
