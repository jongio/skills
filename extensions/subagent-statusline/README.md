# Subagent Statusline

A composable GitHub Copilot CLI status line that tracks **subagent state counts** (`starting`, `exploring`, `in PR`, `merged`, and `failed`) for the active session, with a clickable OSC 8 link to your repository's pull requests page. Coexists side-by-side with [`pr-statusline`](../pr-statusline) and [`issue-statusline`](../issue-statusline) via `~/.copilot/statusline-compose.mjs`.

![Subagent Statusline in isolation](screenshots/subagent-statusline.png)

## Install (Windows, macOS, and Linux)

### Option 1: Install as a Copilot Plugin or Interactive Script (Recommended)

Install via the `jongio/skills` Copilot plugin, or run a single command to choose whether you want **Pull Requests**, **GitHub Issues**, and/or **Subagents**:

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

### Option 2: Ask Copilot

```text
set up the copilot statusline from jongio/skills and ask me whether I want PRs, issues, and/or subagents
```

### Option 3: Standalone extension installer

```powershell
# Windows (PowerShell)
& .\extensions\subagent-statusline\install.ps1
```

```bash
# macOS & Linux (Bash)
./extensions/subagent-statusline/install.sh
```

`setup-statusline.mjs` and the standalone installers copy the extension into `$HOME/.copilot/extensions/subagent-statusline`, configure the shared `~/.copilot/statusline-compose.mjs` compositor, merge `"subagent-statusline"` into `~/.copilot/statusline-config.json`, and enable `footer.showCustom` in `~/.copilot/settings.json`.

## What appears in the pill

- `   1 starting  1 exploring  1 in PR  1 merged ` (Amber: subagents actively starting or exploring)
- `   3 in PR  1 merged ` (Green: all active subagents have open PRs)
- `   1 in PR  1 failed ` (Red: at least one subagent exited with an error)
- `   4 merged ` (Purple: all subagent PRs merged; dismisses on your next prompt)

- **Auto-hides when idle:** Outputs nothing (0 lines) when the session has no active or merged subagents.
- **Clickable link:** The pill links via OSC 8 (`https://github.com/<owner>/<repo>/pulls`) to your repository's pull requests page, and you can run `/tasks` in the Copilot CLI console at any time to inspect individual subagent timelines.
- **State lifecycle:**
  - ` N starting` (`U+F252`): Implementation subagents currently running that have not opened a PR yet.
  - ` N exploring` (`U+F422` / Unicode `◎`): Read-only `explore` and `research` subagents currently investigating.
  - ` N in PR` (`U+E726`): Subagents that have opened or worked on an open pull request.
  - ` N merged` (`U+E727`): Subagents whose pull requests have merged.
  - ` N failed` (`U+F057`): Subagents that failed with an error.
- **Merged dismissal:** Each settled contribution remains visible until the next
  real user message after its settlement is detected. Other active agents don't
  keep old merged counts visible. Active PRs and ongoing agents remain; an agent
  still running after its merged count is dismissed returns to its running count.
  Cache polls don't reset the observation time. Legacy settled caches without a
  reliable boundary get one fresh observation boundary on load.

## Validate

```powershell
node .\extensions\subagent-statusline\test\smoke.test.mjs
node .\scripts\validate-extensions.mjs
node .\scripts\lint.mjs
```
