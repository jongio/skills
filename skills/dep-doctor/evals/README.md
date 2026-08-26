# dep-doctor eval

A Vally capability eval for multi-package-manager dependency updates. Six
scenarios cover:

- **Scanning:** identifying every package manager present in a workspace.
- **No rollbacks:** fixing code to match a new dependency version rather than
  reverting the dependency.
- **The no-op gate:** treating "already up to date" as success, never
  manufacturing an empty branch, commit, or PR.
- **Security sequencing:** prioritizing CVE remediation over routine bumps.
- **Minimum release age (cooldown):** withholding versions published within
  the last few days unless they fix a CVE.
- **Bot coexistence:** avoiding duplicate work when Dependabot/Renovate is
  already configured and running.

From the skill root:

```sh
npm install
npm run eval:lint
npm test
npm run eval
```

`npm test` is the deterministic cross-surface registration check and needs no
dependencies. The full eval drives a real agent and is intended for on-demand
or nightly use.
