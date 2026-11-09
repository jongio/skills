# secops-doctor

Audit repository and application security across OWASP/STRIDE, secrets, workflows, containers, and Cloudflare with Public Repo Stealth Mode.

## Install

```sh
npx skills add jongio/skills --skill secops-doctor
```

Reload your agent skills, then invoke `/secops-doctor`.

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
