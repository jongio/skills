# diff

Open a GitHub-style side-by-side diff viewer in a native Copilot App canvas (`canvasId: "diff"`) or standalone local browser fallback with inline review comments and structured review triage.

## Features

- **Native Copilot App Canvas (`canvasId: "diff"`):** Built on Preact + `htm` + Primer `canvas-kit` tokens with automatic light/dark theming, live SSE state sync, shared agent/UI actions (`get_review`, `load_diff`, `focus_file`, `toggle_viewed`, `add_comment`, `delete_comment`, `submit_review`, `mark_addressed`), and coordinator-friendly `diff prepare` handoff.
- **Flexible Git & PR diffs:** Compare uncommitted + branch changes against `merge-base(default-branch, HEAD)` by default, or inspect `--staged`, `--unstaged`, `<ref>`, `<base>..<head>`, `<base>...<head>`, `pr [<number>]`, and `-- <paths...>`.
- **GitHub Primer UI:** Collapsible hierarchical file tree, file filter search, resizable sidebar and split columns, Split/Unified toggle, line wrap toggle, `Viewed` tracking, and pure-JS syntax + intra-line word highlighting.
- **Inline review loop:** Click any diff line number to add or delete comments, click **Submit Review** to persist a private review file under `${COPILOT_HOME:-~/.copilot}/diff-reviews`, and run `/diff review` to verify and address each comment.
- **Zero-CDN hardened runtime:** Zero runtime npm dependencies and zero external CDN requests, capability-guarded loopback servers (`127.0.0.1`), per-session SDK lease isolation, and `0700`/`0600` atomic symlink-safe storage.

## Install

```sh
npx skills add jongio/skills --skill diff
```

In GitHub Copilot App, installing the `jongio-skills` marketplace plugin registers the `diff` canvas automatically. For standalone skill installs, preview and approve the extension loader once:

```sh
node skills/diff/scripts/setup.mjs --dry-run
node skills/diff/scripts/setup.mjs --approve <hash>
```

Reload extensions/skills, then invoke `/diff`.

## CLI Usage

```sh
node skills/diff/scripts/diff.mjs prepare --json      # Prepare durable patch + review JSON for native canvas
node skills/diff/scripts/diff.mjs                     # Standalone 127.0.0.1 browser fallback
node skills/diff/scripts/diff.mjs --staged            # Staged index diff
node skills/diff/scripts/diff.mjs main..HEAD          # Branch or commit comparison
node skills/diff/scripts/diff.mjs pr 42               # Pull request diff via gh CLI
node skills/diff/scripts/diff.mjs --static            # Private zero-CDN static HTML snapshot
node skills/diff/scripts/diff.mjs review resolve      # Match pending review for current diff
node skills/diff/scripts/diff.mjs review list --all   # List saved reviews
node skills/diff/scripts/diff.mjs review address <id> # Mark review addressed
```

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

## License

MIT. See [LICENSE](LICENSE).
