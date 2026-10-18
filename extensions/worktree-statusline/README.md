# Branch and Worktree Statusline

A single-row, composable Copilot CLI footer showing session work outside
Copilot's own checkout, with its full path first and its live branch in brackets.
It outputs nothing when all work is in Copilot's current checkout.

```text
C:\code\my-project [main]
C:\code\.worktrees\my-project\feat-login [feat/login]
C:\code\.worktrees\my-project\release-check [detached@a1b2c3d]
```

Each checkout gets a blue pill beside the others and composes with PRs, issues,
and subagents using the existing `statusline-compose.mjs`. Each single-line pill
has horizontal padding inside its background and no terminal hyperlink, avoiding
hyperlink underlining. Paths are not shortened or truncated, and no Nerd Font is
required. There is no colon between the path and branch.

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
  or truncation. Older single-checkout caches automatically replay to recover
  the session's other checkouts.

Only explicit directory evidence is tracked. Dynamically computed shell paths,
later directory changes inside compound scripts, and file paths in editing
tools are not inferred. A later context event or explicit shell directory
restores the authoritative location. Non-Git directories produce no pill;
unexpected filesystem/Git errors are reported by the standalone renderer.

## Validate

```powershell
node --test .\extensions\worktree-statusline\test\smoke.test.mjs
```
