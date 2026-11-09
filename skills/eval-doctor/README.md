# eval-doctor

Audit, author, and harden AI skill and prompt evaluations with Vally, github/evals, deterministic graders, and safe github/evals-action CI workflows.

## Install

```sh
npx skills add jongio/skills --skill eval-doctor
```

Reload your agent skills, then invoke `/eval-doctor`.

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
