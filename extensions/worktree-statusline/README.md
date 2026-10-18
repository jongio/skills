# Branch and Worktree Statusline

A grouped, multiline Copilot CLI footer showing session work outside Copilot's
own checkout, with its full path first and its live branch in brackets. When
enabled, the compositor groups related PRs, issues and subagent counts on that
checkout's row by default.

```text
C:\code\.worktrees\my-project\feat-login [feat/login]  PR #119  Issue #42
C:\code\.worktrees\my-project\release-check [release/check]  Issue #44
Issue #43  2 starting  20 in PR  1 merged
```

Each checkout gets a separate row in `statusline-compose.mjs`, ordered as
checkout, PR pills, then issue pills. A single overall subagent summary appears
on an unlabeled fallback row. Missing categories are omitted. Checkout pills are always
leftmost when shown. Each pill
has horizontal padding inside its background and no terminal hyperlink, avoiding
hyperlink underlining. Paths are not shortened or truncated, and no Nerd Font is
required. There is no colon between the path and branch.

Newlines are preserved in both plain and colored grouped output. The standalone
`render(payload, options)` exports still return strings with their previous
formatting. Disabling the worktree extension retains the legacy horizontal
compositor. Disabled extensions never render or contribute entries.

### Association rules

- PRs match a unique checkout using their cached head repository URL and head
  branch, compared with that checkout's `origin` URL and live branch. SSH and
  HTTPS GitHub URLs normalize to the same identity, including the hostname.
  A branch name alone is never enough. Multiple matching clones/checkouts are
  ambiguous and stay session-wide.
- Issues follow explicit closing-issue links on tracked PRs or linked PR URLs
  from the issue collector. Conflicting or unresolved associations stay on the
  fallback row. Issue numbers or titles are not interpreted as branch mappings.
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
  At most 16 tracked directories are queried per refresh, plus the payload's
  current checkout lookup. Larger sets rotate through a separate
  `<session_id>.contexts.json` snapshot cache, retaining already discovered
  checkout rows. Discovery, branch changes and removal beyond that budget
  appear on subsequent refreshes.
- Hides Copilot's own checkout and shows the root session's external checkout
  first, then other external checkouts used during the session. Deduplicates checkout roots, including subdirectories of
  the same checkout. It does not list unrelated worktrees from other sessions.
  Switching branches in a checkout updates its existing pill rather than
  retaining an obsolete branch. Checkouts remain listed for this session unless
  removed from disk; non-Git directories are omitted.
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
node --test .\extensions\worktree-statusline\test\smoke.test.mjs .\extensions\worktree-statusline\test\grouping.test.mjs .\extensions\worktree-statusline\test\compact.test.mjs
```

When updating an existing install, copy every runtime file listed in
`scripts/setup-statusline.mjs`'s `EXTENSION_CATALOG` to
`$COPILOT_HOME/extensions/<id>/`, including the new
`worktree-statusline/grouping.mjs` and `pr-statusline/provenance.mjs`.
Copy `pr-statusline/compose.mjs` to
`$COPILOT_HOME/statusline-compose.mjs` too. Preserve existing
`statusline-config.json` and `settings.json`; no dependency install is required.
Restart Copilot after copying to reload any already-running collector modules.
