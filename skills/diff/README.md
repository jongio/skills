# diff

Open a GitHub-style side-by-side diff viewer in a browser or Copilot App canvas with inline review comments and structured review triage.

## Features

- **Flexible Git & PR diffs:** Compare uncommitted + branch changes against `merge-base(default-branch, HEAD)` by default, or inspect `--staged`, `--unstaged`, `<ref>`, `<base>..<head>`, `<base>...<head>`, `pr [<number>]`, and `-- <paths...>`.
- **GitHub Primer UI:** Collapsible hierarchical file tree, resizable sidebar and split columns, Split/Unified toggle, line wrap toggle, syntax highlighting, and keyboard navigation (`[`, `]`, `b`, `Cmd/Ctrl+Enter`).
- **Inline review loop:** Click `+` on any diff line to add, edit, or delete comments, click **Submit Review** to persist a private review file under `${COPILOT_HOME:-~/.copilot}/diff-reviews`, and run `/diff review` to verify and address each comment.
- **Hardened local runtime:** Zero runtime npm dependencies, `127.0.0.1` loopback binding with DNS-rebinding `Host` check, capability-cookie + `X-Diff-Token` CSRF defense, strict nonce-based CSP, pinned SHA-384 SRI assets, and `0700`/`0600` atomic storage.

## Install

```sh
npx skills add jongio/skills --skill diff
```

Reload your agent skills, then invoke `/diff`.

## CLI Usage

```sh
node skills/diff/scripts/diff.mjs                     # Default branch + working-tree diff
node skills/diff/scripts/diff.mjs --staged            # Staged index diff
node skills/diff/scripts/diff.mjs main..HEAD          # Branch or commit comparison
node skills/diff/scripts/diff.mjs pr 42               # Pull request diff via gh CLI
node skills/diff/scripts/diff.mjs --no-open --json    # Machine-readable server bootstrap for canvases
node skills/diff/scripts/diff.mjs --static            # Private static HTML snapshot fallback
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
