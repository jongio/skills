# doc-doctor

Check changed documentation against code and fix material gaps.

## Install

```sh
npx skills add jongio/skills --skill doc-doctor
```

Reload your agent skills, then invoke `/doc-doctor`.

Checks the current diff and affected documentation by default, including missing
updates to unchanged docs. Compares documented behavior with code and validates
local references, examples, and repository-specific frontmatter rules. A full
repository audit requires an explicit request; external links are reported as
unchecked unless verified.

Fixes material gaps within scope while preserving unrelated work and approval
boundaries. Reports evidence and checks actually performed, including why no
documentation changes are needed when applicable.

`pr` owns this check during preflight; `go` delegates it to `pr` rather than
running it separately. Matching passing evidence is reused until invalidated.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

Deterministic tests enforce the ten-line instruction limit (excluding the two
release-metadata lines), scope/safety rules,
registration, and single-owner pipeline contract. Synthetic Vally scenarios cover
documentation drift and verification honesty; linting is not a behavioral run.

## License

MIT. See [LICENSE](LICENSE).
