# PR Statusline

A composable GitHub Copilot CLI status line that tracks the pull requests **this session** is actively working on across repositories and worktrees, rendering live, color-coded status pills with fully-qualified clickable web links (`owner/repo#number`), CI check progress (`passed/total`), review approvals (`approved/requested`), and review comment resolution (`resolved/total`). Coexists side-by-side with [`issue-statusline`](../issue-statusline) and [`subagent-statusline`](../subagent-statusline) via `~/.copilot/statusline-compose.mjs`.

![PR Statusline in isolation](screenshots/azure-dev-statusline.png)

![Composed PR, Issue, and Subagent statusline](screenshots/statusline-composed.png)

## Install (Windows, macOS, and Linux)

### Option 1: Install as a Copilot Plugin or Interactive Script (Recommended)

Install via the `jongio/skills` Copilot plugin (auto-registers the statuslines on session start), or run the interactive setup script to choose whether you want **Pull Requests**, **GitHub Issues**, and/or **Subagents**:

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
```

### Option 2: Ask Copilot (App or CLI)

```text
set up the copilot statusline from jongio/skills and ask me whether I want PRs, issues, and/or subagents
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

`setup-statusline.mjs` and `install.ps1` copy the runtime files (`extension.mjs`, `collector.mjs`, `tracker.mjs`, `github.mjs`, `render.mjs`, `compose.mjs`, `copilot-extension.json`) into `$HOME\.copilot\extensions\pr-statusline`, install the shared `~/.copilot/statusline-compose.mjs` compositor, save your selection to `~/.copilot/statusline-config.json`, and configure `statusLine` (`padding: 0`, `refreshInterval: 2`) and `footer.showCustom` in `$HOME\.copilot\settings.json`.

### Option 4: Manual setup (macOS / Linux / Windows)

1. Copy `extensions/pr-statusline/*.mjs` and `copilot-extension.json` to `~/.copilot/extensions/pr-statusline/`, and copy `compose.mjs` to `~/.copilot/statusline-compose.mjs`.
2. Add the following to `~/.copilot/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/Users/you/.copilot/statusline-compose.mjs\"",
    "padding": 0,
    "refreshInterval": 2
  },
  "footer": {
    "showCustom": true
  }
}
```

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
| ` x/y` (`U+F252`) | Checks currently running or queued (`x` passed so far / `y` total) |
| ` x/y` (`U+F057`) | One or more checks failed (`x` passed / `y` total) |
| ` x/y` (`U+F164`) | Review approvals received (`x`) out of total reviewers requested or opinionated (`y`) |
| ` x/y` (`U+F075`) | Review comment threads resolved (`x`) out of total review threads (`y`) |
| `` (`U+F071`) | Merge conflicts (`mergeStateStatus === "DIRTY"`) |
| `` (`U+F440`) | Changes requested (`reviewDecision === "CHANGES_REQUESTED"`) |

### Attention-level badge colors

- **Green (All Clear):** All checks passing, no conflicts, and all review threads resolved (` #4812  14/14  2/2  3/3`).
- **Amber (In Progress / Needs Attention):** Checks are running (``), approvals are still pending (` 1/2`), or review threads remain unresolved (` 2/4`).
- **Red (Critical):** One or more checks failed (``), the PR has merge conflicts (``), or changes were requested (``).
- **Purple (Merged):** When a tracked PR merges during the session, its pill turns GitHub Merged purple (` #4810 Merged`) so you can see it landed, and automatically dismisses itself as soon as you submit your next prompt in that session.
- **Slate (Neutral):** Draft PR (``).

## How PRs are discovered and refreshed

1. **Session-scoped transcript tailing (`tracker.mjs`):**
   `render.mjs` incrementally reads new bytes from the active session's `events.jsonl` transcript (from a persisted `transcriptOffset` in `$COPILOT_HOME/pr-statusline/<session_id>.json`) plus `workspace.yaml`. It extracts PRs from:
   - User prompts and attached GitHub PR references
   - Active branch / `pr-review-*` worktree metadata in `workspace.yaml`
   - Targeted `gh pr` commands (`view`, `checks`, `create`, `edit`, `review`, `comment`, `merge`, `close`, `reopen`, `ready`), `gh api repos/<owner>/<repo>/pulls/<number>`, and GitHub MCP PR tools
   - Scheduled watch prompts (`manage_schedule`)
   It ignores `gh pr list`/`search` output, exploratory subagents, skill-injected examples, and other sessions' transcripts.
2. **Single-query GraphQL status + shared cache (`github.mjs`):**
   Live PR status is fetched via `gh api graphql` (falling back across secondary logged-in `gh auth` accounts when a PR lives in another organization) and cached across sessions in `$COPILOT_HOME/pr-statusline/pr-cache.json` (10s TTL while checks are running, 15s TTL when settled, with in-flight deduplication locks). It does **not** use Copilot AI model requests or touch Copilot's internal databases.
3. **Automatic cleanup & manual controls:**
   Closed or merged PRs are automatically removed from the statusline. When the SDK extension (`extension.mjs`) is loaded, you can also manage the list manually:

```text
/session-prs list
/session-prs add Azure/azure-dev#4812
/session-prs remove Azure/azure-dev#4812
/session-prs clear
```

## Validate

```powershell
node .\extensions\pr-statusline\test\smoke.test.mjs
node .\scripts\validate-extensions.mjs
node .\scripts\lint.mjs
```

To disable the custom footer at any time, run `copilot config footer.showCustom off`.
