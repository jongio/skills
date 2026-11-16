# diff

Open a GitHub-style side-by-side diff viewer in a native Copilot App canvas (`canvasId: "diff"`) with inline review comments and structured review triage.

## Features

- **Pure `create-canvas-app` Canvas (`canvasId: "diff"`):** Built on Preact + `htm` + Primer `canvas-kit` tokens with automatic light and dark theming, live SSE state sync, lightweight durable review persistence via `userStore("diff", ...)`, and shared agent/UI actions (`refresh`, `load_diff`, `focus_file`, `toggle_viewed`, `add_comment`, `delete_comment`, `submit_review`, `get_review`, `mark_addressed`).
- **Direct Git & GitHub PR loading:** Inspect local repository changes (`--staged`, `--unstaged`, `<ref>`, `<base>..<head>`, `<base>...<head>`, or default `merge-base(default-branch, HEAD)` vs working tree) OR load any GitHub pull request directly via `{ repo: "owner/repo", pr: 293 }` even from a chat or Project coordinator with no local checkout.
- **Fast GitHub Primer UI:** Collapsible hierarchical file tree, file filter search, resizable sidebar and split columns, Split/Unified toggle, line wrap toggle, `Viewed` tracking, pure-JS syntax and intra-line word highlighting, and automatic collapsing of lockfiles and single-file diffs over 600 changed lines.
- **One-click agent review handoff:** Click any diff line number to add inline comments, then click **Submit Review** to transition the review to `pending` and notify the session agent via `askAgent` to verify and address each comment.
- **Zero-CDN hardened runtime:** Zero runtime npm dependencies, zero external CDN requests, capability-guarded loopback panel transport (`requireCapability: true`), and safe Git/GitHub CLI execution (`--no-ext-diff`, `--no-textconv`, `core.fsmonitor=false`).

## Install

```sh
npx skills add jongio/skills --skill diff
```

In GitHub Copilot App, installing the `jongio-skills` marketplace plugin registers the `diff` canvas automatically. For standalone skill installs, run the idempotent extension setup helper once:

```sh
node skills/diff/scripts/setup.mjs
```

Reload extensions, then invoke `/diff`.

## Canvas Input & Actions

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

Supported `invoke_canvas_action` verbs: `refresh`, `load_diff`, `focus_file`, `toggle_viewed`, `add_comment`, `delete_comment`, `submit_review`, `get_review`, and `mark_addressed`.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

## License

MIT. See [LICENSE](LICENSE).
