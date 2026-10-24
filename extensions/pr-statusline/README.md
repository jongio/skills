# PR Statusline

A composable GitHub Copilot CLI status line that tracks the pull requests **this session** is actively working on across repositories and worktrees, rendering live, color-coded status pills with fully-qualified clickable web links (`owner/repo#number`), CI check progress (`passed/total`), review approvals (`approved/requested`), and review comment resolution (`resolved/total`). Composes with [`issue-statusline`](../issue-statusline), [`subagent-statusline`](../subagent-statusline), and [`worktree-statusline`](../worktree-statusline) via `~/.copilot/statusline-compose.mjs`.

![Pull request pill examples and their status meanings](../../site/public/screenshots/pr-statusline.svg)

![Illustrative checkout-grouped footer with branch/worktree pills, related PRs and issues, and one subagent summary](../../site/public/screenshots/statusline-worktree-grouped.svg)

## Compact subagent PRs

With both PR and subagent statuslines enabled, positively identified
subagent-only PRs contribute to one overall subagent summary instead of
individual detailed PR pills. PRs directly worked on by the main session remain
detailed, even if an agent also references them. Explicitly owned entries whose
root/agent provenance cannot be proved stay detailed. Unowned legacy entries
are dropped. Disabling or
dismissing the subagent summary restores those PR details; no arbitrary item
limit drops PRs or issues. Standalone PR rendering remains detailed.

Enabling the worktree statusline also groups PRs and linked issues by checkout
on separate rows. Its branch pill compares the configured upstream (`↑` local
only, `↓` missing locally) and the matched PR's target branch (`↓` missing base
commits), using locally fetched refs. The target repository is respected for
fork PRs; ambiguous or unavailable comparisons are not reported as current.
See [divergence indicators](../worktree-statusline/README.md#upstream-and-base-divergence)
and [association rules](../worktree-statusline/README.md#association-rules).

## Install (Windows, macOS, and Linux)

### Option 1: Install as a Copilot Plugin or Interactive Script (Recommended)

Install via the `jongio/skills` Copilot plugin (auto-registers the statuslines on session start), or run the interactive setup script to choose **Pull Requests**, **GitHub Issues**, **Subagents**, and/or **Branch and Worktree**:

**Copilot CLI Plugin:**

```bash
copilot plugin install jongio/skills
```

**Windows (PowerShell):**

```powershell
# One-liner (no clone required)
irm https://raw.githubusercontent.com/jongio/skills/main/install-statusline.ps1 | iex

# Or from a clone
.\install-statusline.ps1
```

**macOS & Linux (Bash / Zsh):**

```bash
# One-liner (no clone required)
curl -fsSL https://raw.githubusercontent.com/jongio/skills/main/install-statusline.sh | bash

# Or from a clone
./install-statusline.sh
```

**Cross-platform Node.js CLI (with optional non-interactive flags):**

```bash
node ./scripts/setup-statusline.mjs
node ./scripts/setup-statusline.mjs --prs --issues --subagents
node ./scripts/setup-statusline.mjs --all
```

### Option 2: Ask Copilot (App or CLI)

```text
set up the copilot statusline from jongio/skills and ask me which of PRs, issues, subagents, and worktrees I want
```

### Option 3: Standalone extension installer

```powershell
# Windows (PowerShell)
& .\extensions\pr-statusline\install.ps1
```

```bash
# macOS & Linux (Bash)
./extensions/pr-statusline/install.sh
```

`setup-statusline.mjs` and the installers copy runtime files listed in `scripts/setup-statusline.mjs`'s `EXTENSION_CATALOG` into `$COPILOT_HOME/extensions/<id>/` (default `~/.copilot`), plus the common assets in `SHARED_RUNTIME_FILES`. These include the bundled Octokit runtime, license notices, and async refresh helpers. PR installs include sibling runtime dependencies because the unified SDK entry point exposes their commands; only your selected footer items are enabled. Setup installs the shared `statusline-compose.mjs`, saves selections to `statusline-config.json`, and configures `statusLine` (`padding: 0`, `refreshInterval: 5`) and `footer.showCustom` in `settings.json`.

### Option 4: Manual setup (macOS / Linux / Windows)

1. Copy every runtime file in `EXTENSION_CATALOG` for all four packages to `~/.copilot/extensions/<id>/`, preserving package directories. This includes the unified PR entry point's sibling dependencies. Copy every common asset in `SHARED_RUNTIME_FILES` into `~/.copilot/extensions/`, and `extensions/pr-statusline/compose.mjs` to `~/.copilot/statusline-compose.mjs`.
2. Add the following to `~/.copilot/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/Users/you/.copilot/statusline-compose.mjs\"",
    "padding": 0,
    "refreshInterval": 5
  },
  "footer": {
    "showCustom": true
  }
}
```

3. To enable only PR pills, create `~/.copilot/statusline-config.json`:

```json
{
  "version": 1,
  "enabled": ["pr-statusline"],
  "iconMode": "auto"
}
```

## Windows Terminal attention alerts

These are **extension slash commands, not skills**; they do not appear in
`/skills`. SDK extensions require experimental features. Enable them once with
`/settings experimental on`, then run `/restart` in each existing CLI window
before using `/session-attention`. Installing the plugin alone does not enable
the SDK extension loader.

Window alerts are **off by default**. The live extension can pulse a colored
border, a translucent background wash, or both around the Terminal window that
owns this session. This is independent of which footer components are visible:
hiding or clearing footer rows does not disable window alerts.

```text
/session-attention both
/session-attention preview
/session-attention preview question
/session-attention status
/session-attention off
```

| Command | Effect |
| --- | --- |
| `/session-attention on` | Enable alerts using the saved appearance. |
| `/session-attention off` | Disable alerts and remove any active window effect. |
| `/session-attention border` | Enable only the pulsing border. |
| `/session-attention background` | Enable only the translucent wash. |
| `/session-attention both` | Enable both effects. |
| `/session-attention preview [approval \| question \| ready \| error]` | Pulse until you click/type in the terminal or switch away and return. No timeout; does not enable alerts. Defaults to approval. |
| `/session-attention status` | Show the enabled state, appearance, verified window binding, or helper error. |

Alerts and previews have **no timeout**. Focusing the window acknowledges its current
alert and removes the effect; switching away does not restart it. Only a new
attention event re-arms the pulse. If an alert starts while the window already
has focus, it keeps pulsing until a subsequent key press, click or scroll in
that terminal, or until you switch away and return. Mouse movement alone and
interaction with another window do not acknowledge it. Acknowledgment does not
answer a question or approve a permission request.
Acknowledgment uses the exact bound Terminal window, not the shared
`WindowsTerminal.exe` process or another window's ownership chain. Switching to
or opening another terminal leaves the alert active. Focus must settle on the
bound window; transient activation and window-switching keyboard shortcuts do
not dismiss it.

An unresolved input request keeps pulsing through background activity and
working/status refreshes. If the request is resolved and Copilot can continue
without you, its alert clears. A response-ready alert also clears if Copilot
resumes working on its own. Disabling attention or closing the session removes
the effect.

| Session event | Default appearance |
| --- | --- |
| Permission or plan approval needed | Amber |
| Question or elicitation dialog needs an answer | Purple |
| Root session finishes its response and becomes idle | Green |
| Root session reports an error | Red |

Green means **response ready**, not proof that the requested task succeeded.
Working and compacting do not flash. Historical replay, hook-resolved approval
requests, scheduled response completions, and background-agent completions do
not create alerts. Real input requests raised by background agents can still
need your attention.

Preferences are saved separately in
`$COPILOT_HOME/statusline-attention.json` (default
`~/.copilot/statusline-attention.json`) and reloaded by running sessions.
Colors can be customized with `#RRGGBB` values:

```json
{
  "version": 1,
  "enabled": true,
  "style": "both",
  "colors": {
    "approval": "#FFBB24",
    "question": "#B48CFF",
    "ready": "#5BD463",
    "error": "#EF5F5F"
  }
}
```

The Windows-only helper binds through this session's console ownership, never
the currently foreground window or a shared Terminal process ID. Its surfaces
are click-through and non-activating, follow the window's position, size and
DPI, hide while minimized, and disappear when the extension exits. Focus
acknowledgment is **window-wide, not tab-specific**: use a separate Terminal
window for each Copilot session when you need independent alerts.
The extension supplies its CLI host PID rather than its own forked-process
console. An attachable classic console or an unowned pseudoconsole is rejected
without falling back to an ancestor's Terminal, even if it inherited
`WT_SESSION`.

No shell profile changes, global hooks, system service, or AI requests are
needed. On first use, the bundled C# source is compiled with Windows' .NET
Framework compiler and cached under
`$COPILOT_HOME/statusline-attention/bin/`; no .NET SDK or package installation
is required. The helper starts only for an attention event or preview and
receives presentation metadata, not prompts or tool output. An unsupported
host, missing compiler, or unverified window binding is reported without
selecting another window or preventing the statusline from working. macOS,
Linux, WSL, and other terminal hosts do not run this Windows helper.

After upgrading the plugin or standalone runtime, start a new Copilot session
to load the new `/session-attention` command.

## What appears in each pill

Using `Azure/azure-dev` as an example checkout:

- `  Azure/azure-dev#4812  14/14  2/2  3/3 ` (Green: all checks passing, approvals granted, threads resolved)
- `  Azure/azure-dev#4815  6/14  1/2  1/4 ` (Amber: checks running or reviews/threads pending)
- `  Azure/azure-dev#4819  11/14   0/2  0/3 ` (Red: checks failing or merge conflict)
- `  Azure/azure-dev#4810 Merged ` (Purple: merged during this session; dismisses on your next prompt)

- **Fully-qualified clickable links:** Every pill includes an OSC 8 hyperlink (`Ctrl+click` or `Cmd+click`) on `owner/repo#number` that opens the pull request web page directly on GitHub.
- **Zero-line auto-hide:** When a session has no tracked open PRs (or after merged PRs are dismissed on your next input), `render.mjs` outputs nothing and `padding: 0` ensures the status line takes **zero rows**.
- **Single-line compact pills:** Each pill renders on a single terminal row with horizontal padding so the statusline sits flush below the CLI status bar with no blank lines above or below.

### Nerd Font Icons & Metrics (`x/y`)

| Token | Meaning |
| --- | --- |
| `` (`U+E726`) | Open pull request (`nf-dev-git_pull_request`) |
| ` Merged` (`U+E727`) | Pull request merged (`nf-dev-git_merge`) |
| `` (`U+F4DD`) | Draft pull request (`nf-oct-git_pull_request_draft`) |
| ` x/y` (`U+F058`) | All checks completed with none failing (`x` passed / `y` total, including required branch-protection checks waiting to report) |
| ` x/y` (`U+F252`) | Checks currently running or queued (`x` passed so far / `y` total); `(n failed)` appears if other checks have completed with failures |
| ` x/y` (`U+F057`) | No checks are active and one or more checks failed (`x` passed / `y` total) |
| ` x/y` (`U+F164`) | Review approvals received (`x`) out of total reviewers requested or opinionated (`y`) |
| ` x/y` (`U+F075`) | Review comment threads resolved (`x`) out of total review threads (`y`) |
| `` (`U+F071`) | Merge conflicts (`mergeStateStatus === "DIRTY"`) |
| `` (`U+F440`) | Changes requested (`reviewDecision === "CHANGES_REQUESTED"`) |

### Attention-level badge colors

- **Green (All Clear):** All checks passing, no conflicts, and all review threads resolved (` #4812  14/14  2/2  3/3`).
- **Amber (In Progress / Needs Attention):** Checks are running or queued (``), including reruns after failure, approvals are still pending (` 1/2`), or review threads remain unresolved (` 2/4`). Active CI takes precedence over completed check failures; a mixed result shows progress plus `(n failed)` without implying the rerun has succeeded.
- **Red (Critical):** CI has no active checks and one or more failed (``), the PR has merge conflicts (``), or changes were requested (``). Conflicts and requested changes remain red even while CI is running.
- **Purple (Merged):** A merged PR remains visible until the next real user message
  after this session detects the merge, then disappears. GitHub's merge time and
  later cache polls don't move that first-observed boundary. Scheduled prompts,
  skill injections and subagent messages don't dismiss it. Older merged caches
  without an observation time conservatively start a fresh boundary on first
  load. Dismissal survives collector saves; explicit re-add starts a new
  tracking revision.
- **Slate (Neutral):** Draft PR (``).

## How PRs are enrolled and refreshed

1. **Session-scoped transcript tailing (`tracker.mjs`):**
   Add PRs through the loaded `session_prs` tool or `/session-prs add` command
   only when this session takes on implementation, review, repair, or active
   monitoring. All PR enrollment is explicit. Shell commands, GitHub writes and
   responses, references, attachments, workspace/branch names, remote metadata,
   schedules, delegated prompts/results, and historical control-call attempts
   never enroll PRs. `render.mjs` tails the active session's transcript for
   activity and dismissal metadata, not to infer new ownership.
   Explicit ownership persists across restarts. On upgrade, unowned legacy
   entries are dropped; explicitly re-add any work this session still owns.
   A lost or corrupt ownership cache likewise requires explicit re-enrollment.
   Existing tracked PRs continue refreshing normally.
2. **Single-query GraphQL status + shared cache (`github.mjs`):**
   Live PR status is fetched through Octokit GraphQL (falling back across secondary logged-in `gh auth` accounts when a PR lives in another organization) and cached across sessions in `$COPILOT_HOME/pr-statusline/pr-cache.json` (20s TTL while checks are running, including mixed running/failed checks, 45s TTL when settled, with in-flight deduplication locks). A restarted check's active status takes precedence over a leftover conclusion; the pill changes on the next successful refresh, not optimistically when a rerun command is issued. It does **not** use Copilot AI model requests or touch Copilot's internal databases.
3. **Automatic cleanup & manual controls:**
   Closed PRs are removed automatically. Merged PRs remain until the next real user message after this session detects the merge. When the SDK extension (`extension.mjs`) is loaded, you can also manage the list manually:

```text
/session-prs list
/session-prs add Azure/azure-dev#4812
/session-prs remove Azure/azure-dev#4812
/session-prs clear
```

## Session recovery and setup

The unified SDK extension provides a separate command from Copilot's built-in
`/statusline` and `/footer`, which are left untouched:

| Command | Effect |
| --- | --- |
| `/session-statusline refresh` | Immediately re-query tracked PRs, issues, agent-linked PRs, and Git checkout/worktree data, bypassing status TTLs and applicable shared/in-flight caches. Keeps tracking and component selections; reports incomplete refreshes and individual failures explicitly. |
| `/session-statusline clear` | Dismiss this session's current PR, issue, subagent, and worktree entries. Does not delete transcripts, affect other sessions, or change component selections. |
| `/session-statusline setup` | Open the component picker. Optional selections such as `all`, `none`, or `prs issues` also work. `/statusline-setup` remains a compatibility alias. |

The `session-statusline` skill in the `jongio-skills` plugin maps natural-language
requests such as "clear the footer pills" to the session-bound `session_statusline`,
`session_prs`, `session_issues`, and `session_subagents` tools. Per-component clear
is available through `/session-prs clear`, `/session-issues clear`, and
`/session-subagents clear`; `/session-subagents remove <agent-id>` dismisses one
agent without stopping it. Use `/session-subagents list` to find tracked IDs.

**Clear is not refresh or hide.** Clear saves a session-specific replay boundary,
so old transcript events, unchanged workspace metadata, and collector saves do
not immediately restore dismissed entries. PRs and issues require a new explicit
add; actual new agent launches remain automatic. A new successful
shell command or directory context can restore the current worktree entry.
Root and subagent directory context is retained for resolving new relative
commands without making those dismissed directories visible again.
Re-indexing restarts from that clear-time context, not the latest directory.
If bounded worktree replay is still catching up, clear reports a retry instead
of discarding unread directory changes or committing a dismissal boundary.
Each component retains its own consumed transcript cursor; validation of the
worktree EOF does not skip records that other components have not processed.
Worktree replay excludes all directory events included in its baseline without
advancing the PR, issue, or subagent activity boundaries.
Existing per-component list/add/remove/clear commands remain available.

Use **setup** to hide a component without dismissing its tracked items. Hidden
components can be enabled again later; hiding does not clear their history.
Refresh keeps entries tracked even when GitHub reports them closed or missing;
normal subsequent collector refreshes still apply the existing lifecycle rules.
Remote observations are applied to the latest locked tracking state, preserving
activity and dismissals recorded while those queries run.
Git comparisons use local refs; refresh does not fetch remote Git branches.

After installing updated runtime files, **restart Copilot** to reload an
already-running SDK collector and register the new command. Clear and refresh
themselves require no restart once the updated extension is loaded. Recovery
commands are registered by the unified PR SDK entry point; PR installs include
its sibling runtime dependencies even when those footer components are hidden.
The installer keeps one unified SDK controller to avoid duplicate tool names.
Existing standalone sibling entry points are preserved as
`extension.mjs.disabled-*` backups, not loaded alongside the unified controller.
Toggling footer components does not remove the installed unified controls.
Plugin startup also handles existing standalone installations: it preserves
their entrypoints as backups, retires only those statusline SDK controllers in
the current session, and then claims the unified tool names. Work agents and
saved component selections are unchanged.
This handover uses live registrations even if another session has already moved
the shared entrypoint files; an already-moved backup does not block startup.
Legacy inferred tracking is dropped on first load; explicitly re-add any work
this session still owns. Ownership is never reconstructed from shell history,
workspace names, or remote metadata.
Legacy migration reads the complete available history in 1 MiB I/O chunks,
reassembling records that cross chunk boundaries. Saved dismissals survive
old and new shell reopen commands; only an explicit add can resume tracking.
State writes and worktree replay use per-session, cross-process locks. A lock
timeout reports its exact path rather than overwriting potentially active state.
If a process crashed while holding a lock, stop the session's collectors before
removing only that reported `.lock` directory, then restart Copilot.

## Async GitHub refresh and offline rendering

Footer rendering and workspace/branch discovery read local state only. The
SDK collector performs asynchronous Octokit refreshes with host/credential-scoped
caches. A cold footer can show tracked links before remote metadata arrives;
failed refreshes keep last-known observations marked stale rather than claiming
new success or merge state. Git comparisons still use bounded local Git reads.
Local controls initialize before the first background poll finishes, so a slow
GitHub response does not block tracking or clearing this session.
Live session events remain authoritative while activity/GitHub requests are
pending. Invalidated PR and issue metadata is marked stale immediately.
Workspace hints do not trigger a duplicate branch lookup; owned PRs refresh
directly by their tracked references.

`/session-statusline refresh` awaits a real refresh and reports partial failures.
For standalone installs without a running SDK collector, refresh explicitly:

```powershell
node "<COPILOT_HOME>\extensions\refresh-github.mjs" --session <session-id> --prs --issues
```

Choose only `--issues` for an issue-only installation. All files in
`SHARED_RUNTIME_FILES` must accompany manually copied runtime packages; no
end-user npm install is required.

The SDK host filters sensitive environment variables. `gh` credential discovery
is the default for collectors. If you intentionally use environment-token-only
authentication, set `COPILOT_STATUSLINE_TOKEN_ENV` to the required token variable
name before starting Copilot, for example `GH_TOKEN`. Comma-separated selections
from `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and
`GITHUB_ENTERPRISE_TOKEN` are supported. The extension then requests approval for
those exact names through the host; tokens are never sent through notification
files. Standalone headless refresh uses its ordinary process environment.
For enterprise environment tokens, also set `GH_HOST` to the intended server.
An unrelated hostname discovered in a link cannot inherit that server's token;
host-specific `gh` keystore lookup is the fallback instead.
This also applies to `GH_TOKEN`/`GITHUB_TOKEN` when `GH_HOST` selects a
`*.ghe.com` tenant: another tenant or github.com requires its own credential.
Secondary-account choices are retained per target within the running client,
so healthy cached observations do not repeat account discovery on every tick.

The optional daemon notification bridge is separate from footer selection.
Install it with `node scripts\setup-statusline.mjs --notifications`, then use
`/daemon-notifications subscribe <watcher>` and pass its returned file to a daemon
with `--events-file`. It logs progress only and never prompts a model or starts
repairs. See `extensions\daemon-notifications\README.md`.

## Validate

```powershell
node --test .\extensions\pr-statusline\test\smoke.test.mjs
node --test .\extensions\worktree-statusline\test\entrypoints.test.mjs
```

To disable the custom footer at any time, run `copilot config footer.showCustom off`.
