# go

Plan, test, and implement the current context, then hand verified changes to pr for delivery and merge.

## Install

```sh
npx skills add jongio/skills --skill go --skill test-doctor --skill pr
```

Invoke `/go <context>` with an issue, conversation, code, or error.
`go` plans, tests with Test Doctor, implements, and reviews/fixes; `pr` reuses
valid preflight evidence and owns Git, remaining checks, CI, reviews, and merge.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

The deterministic test checks the portable skill shape. The Vally capability eval verifies that
the agent follows the workflow.

## License

MIT. See [LICENSE](LICENSE).
