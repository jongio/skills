# release-doctor

Verify post-merge release readiness, unreleased commits, semver recommendations, and cross-manifest version parity before cutting a release.

## Install

```sh
npx skills add jongio/skills --skill release-doctor
```

Reload your agent skills, then invoke `/release-doctor`.

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
