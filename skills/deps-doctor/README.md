# deps-doctor

Audit, update, and secure dependencies across common package managers without
creating empty maintenance work.

## What it does

`deps-doctor` detects every dependency surface in the current workspace, finds
outdated packages, checks for unused and undeclared dependencies, applies
updates, and handles compatibility migrations without rolling versions back.

It covers npm, pnpm, Yarn, pip, Pipenv, Poetry, uv, Go modules, Cargo, Bundler,
Composer, NuGet, Maven, Gradle, Swift Package Manager, pub, and Hex, plus the
surfaces no language package manager owns: Docker base images, GitHub Actions
versions, Terraform providers, dev container features, and pre-commit hooks.

Beyond version bumps it prioritizes vulnerabilities by exploitation evidence
rather than by severity label alone, screens supply-chain signals such as
typosquatting, install hooks, non-registry sources, licenses, and registry
provenance, withholds releases that are too new to have been vetted, resolves
peer dependency conflicts without forcing an unsupported install, and offers
scoped override paths for transitive advisories.

Where Dependabot or Renovate already covers a repository, it works around that
scope instead of opening competing pull requests.

The workflow stops cleanly when no dependency-bearing file needed a meaningful
change. It does not create empty branches, commits, or pull requests.

## Install

```sh
npx skills add jongio/skills --skill deps-doctor -g --agent github-copilot
```

Or install it from the Copilot plugin marketplace:

```sh
copilot plugin marketplace add jongio/skills
copilot plugin install deps-doctor@jongio-skills
```

Reload with `/skills reload`, then invoke:

```text
/deps-doctor
Update dependencies and fix security patches
Audit outdated and unused packages
```

## Dependency update contract

1. Detect every dependency surface in the workspace, and report any manager that
   could not be audited as blocked rather than omitting it.
2. Defer to any update bot that already owns part of that scope.
3. Reconcile declared packages against project imports, keeping dependencies
   that are reached only through configuration or runtime loading.
4. Update through each manager's native command, resolving with lifecycle
   scripts disabled and reviewing the resolved graph before installing for real.
5. Hold back releases inside the minimum release age window, and weigh any
   vulnerability-driven exception on exploitation evidence rather than bypassing
   the window automatically.
6. Run vulnerability audits and supply-chain checks, ranking by exploitation
   evidence.
7. Fix breaking changes and transitive vulnerabilities forward for supported
   releases, never by downgrading and never with a force flag.
8. Validate with a frozen-lockfile clean-room install plus the project's own
   checks.
9. Make repository writes only after a meaningful change to a dependency-bearing
   file and explicit user approval.

## Evaluation

```sh
npm install
npm test          # deterministic cross-surface registration parity
npm run eval:lint # eval spec schema validation
npm run eval      # capability evaluation against a real agent
```

The `overrides` block in `package.json` pins `@opentelemetry/sdk-logs` and
`@azure/monitor-opentelemetry-exporter` forward, past two moderate advisories
that the eval CLI's own dependency range would otherwise resolve into this tree.
It follows the same transitive-override rule this skill teaches. Remove it once
the eval CLI ships a release that resolves those packages at or above the pinned
versions on its own.

## License

MIT. See [LICENSE](LICENSE).
