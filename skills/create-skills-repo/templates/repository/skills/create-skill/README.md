# create-skill

Create and register a complete portable agent skill without missing tests, evals, catalog entries,
or thumbnail provenance.

## Install

```sh
npx skills add jongio/skills --skill create-skill -g --agent github-copilot
```

Reload skills, then invoke:

```text
/create-skill release-notes-helper
/create-skill art release-notes-helper
/create-skill check release-notes-helper
```

Repository generators can use the stable fixture contract:

```sh
node scripts/create-skill.mjs fixture --input fixture.json --repo-root ./target --dry-run
node scripts/create-skill.mjs fixture --input fixture.json --repo-root ./target --approve HASH
```

Fixture mode is noninteractive and accepts the documented version 1 payload in
[references/fixture-mode.md](references/fixture-mode.md).

## Guarantees

- Managed `skills-repo.config.json` paths are authoritative.
- Existing repository conventions are discovered and ambiguous registration fails closed.
- Every mutation has a zero-write dry-run. Art actions use a persisted single-use approval token.
- Azure OpenAI and OpenAI use exact origins, disabled redirects, and zero retries.
- Custom art may use any approved provider and delivery workflow.
- Every image passes complete PNG, CRC, raster, metadata, dimension, and size validation.
- Skill thumbnails are the tracked source; catalog builds generate public copies from frontmatter.
- Prompt and non-secret provenance are recorded when the repository supports that surface.

## Development

New skills include `metadata.version: "1.0.0"` in `SKILL.md`. Registration
preserves that version (or the existing marketplace version for legacy skills).
In repositories with `scripts/version-skills.mjs`, use its `bump` command for
releases and `check` before publishing. Skill releases are separate from
private npm development-tooling versions.

```sh
npm ci --ignore-scripts
npm test
npm run eval:lint
```

Tests are deterministic. They use temporary repositories, injected clients, and local PNG buffers.
They never perform a real network request or billed image generation.

Generated skills pin `@microsoft/vally-cli` to `0.20.0` and reuse a matching
repository Vally tool lockfile. They carry a scoped Copilot SDK override to Zod
`4.6.7`. The source lock must already resolve that override; otherwise generation
stops before writing files. Update older repository tooling before authoring.

## License

MIT. See [LICENSE](LICENSE).
