# session-statusline

Manage only the current session's active statusline pills and clear entries without deleting work or changing enabled components.

## Install

```sh
npx skills add jongio/skills --skill session-statusline
```

Included in the `jongio-skills` plugin and available as an individual skill.
The statusline extensions must be loaded to execute its session-bound tools.
Ask "clear the footer pills" or "remove the PR pill for owner/repo#123".

| Request | Extension command |
| --- | --- |
| Clear this session's pills | `/session-statusline clear` |
| Clear only PRs / issues / agents | `/session-prs clear` / `/session-issues clear` / `/session-subagents clear` |
| Remove one PR / issue | `/session-prs remove owner/repo#123` / `/session-issues remove owner/repo#123` |
| Remove one agent | `/session-subagents list`, then `/session-subagents remove <agent-id>` |
| Refresh tracked data | `/session-statusline refresh` |

Clearing dismisses tracking only: no PRs or issues are closed, agents stopped,
worktrees deleted, transcripts removed, or component selections changed.
References, lookups, and other sessions' work do not automatically create pills.
Explicitly add read-only review/watch targets when the session takes them on.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

The deterministic tests check skill shape, controls, and active-work policy.
The Vally capability eval checks routing and dismissal boundaries.

## License

MIT. See [LICENSE](LICENSE).
