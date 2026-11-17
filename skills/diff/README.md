# diff

Open a GitHub-style side-by-side diff viewer in a Copilot App canvas or local browser with inline review comments and structured review triage.

## Features

- **Cross-harness, single codebase:** Runs natively as a Copilot App side-panel canvas (`canvasId: "diff"`) via `open_canvas`, and opens the exact same Preact + `htm` + Primer `canvas-kit` viewer in the system browser for Copilot CLI, Claude Code, Cursor, Codex, Windsurf, and terminal workflows via `scripts/cli.mjs` - with zero duplicate UI, server, or storage code.
- **Pure `create-canvas-app` Runtime:** Automatic Primer light and dark theming, live SSE state sync, domain-isolated durable review persistence via `userStore("diff", ...)`, and shared agent/UI actions (`check_updates`, `refresh`, `focus_file`, `toggle_viewed`, `add_comment`, `edit_comment`, `delete_comment`, `submit_review`, `reopen_review`, `get_review`, `mark_addressed`).
- **Direct Git & GitHub PR loading:** Inspect local repository changes (`--staged`, `--unstaged`, `<ref>`, `<base>..<head>`, `<base>...<head>`, or default `merge-base(default-branch, HEAD)` vs working tree including untracked non-ignored files) OR load any GitHub pull request directly via `{ repo: "owner/repo", pr: 293, account? }` even from a chat or Project coordinator with no local checkout.
- **Live context-change detection & smart refresh:** Background `check_updates` probes detect local Git edits, staging/unstaging, untracked files, commit advances, and GitHub PR updates (`gh pr view` metadata without re-downloading large diffs), surfacing a live update banner with draft-safe **Auto-refresh**, a responsive toolbar **Refresh** button (`R` shortcut) that preserves scroll position, and smart per-file `Viewed` invalidation when a file's hunks change.
- **Fast GitHub Primer UI:** Collapsible hierarchical file tree with Expand/Collapse all, file filter search, resizable sidebar and split columns, Split/Unified toggle, line wrap toggle, `Viewed` tracking, language-scoped syntax and intra-line word highlighting, and automatic collapsing of lockfiles and single-file diffs over 600 changed lines.
- **Multi-round agent review handoff:** Click or press `Enter`/`Space` on any diff line number to add or edit inline comments, then click **Submit Review** to transition the review to `pending` and hand off directly to the agent (`askAgent` in Copilot App, or instant one-shot stdout JSON via `cli.mjs serve --wait --json` in CLI harnesses). Start follow-up rounds anytime via **New Review Round** (`reopen_review`) or automatic reopen when refreshed hunks change.
- **Zero-CDN hardened runtime:** Zero runtime npm dependencies, zero external CDN requests, capability-guarded loopback panel transport (`requireCapability: true` with capability tokens redacted from CLI output by default), and safe Git/GitHub CLI execution (`--no-ext-diff`, `--no-textconv`, `core.fsmonitor=false`).

## Install

```sh
npx skills add jongio/skills --skill diff
```

In GitHub Copilot App, installing the `jongio-skills` marketplace plugin registers the `diff` canvas automatically. For standalone Copilot App skill installs, run the idempotent extension setup helper once:

```sh
node skills/diff/scripts/setup.mjs
```

In Copilot CLI, Claude Code, Cursor, Codex, and Windsurf, no extension setup is required - `scripts/cli.mjs` starts the loopback viewer directly.

## Copilot App Canvas Input & Actions

Open with `open_canvas({ canvasId: "diff", instanceId: "diff-viewer", input })`:

```json
{
  "repo": "jongio/skills",
  "pr": 293,
  "focusFile": "skills/diff/runtime/canvas.mjs"
}
```

Or for a local Git checkout:

```json
{
  "spec": "--staged",
  "paths": ["src/router.ts", "src/auth.ts"]
}
```

To switch an open `diff` panel to a different PR, branch, or repository, call `open_canvas` again with the same `instanceId` and the new `input` (preserving domain isolation across targets). Use `refresh` to reload the current domain in place.

Supported `invoke_canvas_action` verbs: `check_updates`, `refresh`, `focus_file`, `toggle_viewed`, `add_comment`, `edit_comment`, `delete_comment`, `submit_review`, `reopen_review`, `get_review`, and `mark_addressed`.

## Cross-Harness CLI (`scripts/cli.mjs`)

```sh
# Open local working-tree/branch diff in system browser and wait for Submit Review
node skills/diff/scripts/cli.mjs serve --wait --json

# Open a GitHub PR diff without a local checkout
node skills/diff/scripts/cli.mjs serve --repo example-org/service --pr 42 --wait --json

# Inspect, address, or reopen saved durable reviews across sessions
node skills/diff/scripts/cli.mjs list --status pending --json
node skills/diff/scripts/cli.mjs review --domain pr__example-org__service__42 --json
node skills/diff/scripts/cli.mjs address --domain pr__example-org__service__42 --json
node skills/diff/scripts/cli.mjs reopen --clear-comments --domain pr__example-org__service__42 --json
```

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

## License

MIT. See [LICENSE](LICENSE).
