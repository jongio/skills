---
name: create-skill
description: >-
  **WORKFLOW SKILL** - Create and register a complete portable agent skill in a managed
  skills-repo.config.json repository or an existing skills repository. Produces focused
  instructions, documentation, deterministic tests, Vally evals, locked tooling, registration,
  and optional validated thumbnail art. USE FOR: create-skill, create a skill, add an agent skill,
  scaffold a portable skill, register a skill, add skill to managed repo, create skill in existing
  repo, generate an example skill from a fixture, add skill thumbnail art. DO NOT USE FOR:
  scaffolding a new marketplace collection from scratch (use
  create-skills-repo), editing one existing skill instruction without registration work (use
  skill-authoring), creating an agent persona.
---

> [!CAUTION]
> Read and follow the shared safety rules before any action. Preview local writes and obtain
> explicit approval. Git and GitHub writes require their own approval and are outside this skill.

# Create Skill

Create one complete skill and register every repository surface without guessing. The workflow
plans first, fails closed on ambiguous conventions, and applies one approved change set.

## Commands

| Command | Purpose |
| --- | --- |
| `create-skill <name>` | Create and register a new skill with deterministic placeholder art. |
| `create-skill art <name>` | Preview and create or ingest thumbnail art for an existing skill. |
| `create-skill register <name>` | Preview and register an existing complete skill without replacing its authored files. |
| `create-skill check <name>` | Validate the skill shape and thumbnail parity without writing. |
| `create-skill fixture --input <json> --repo-root <path>` | Deterministically create a validated fixture skill without interview prompts. |

Every mutating command starts with `--dry-run`. Apply the unchanged plan only after the user
approves its single-use hash.

## Workflow

### 1. Resolve the request

Collect only missing values:

1. Skill name in lowercase-dash form.
2. A one-sentence summary.
3. Specific `USE FOR` phrases that users will type.
4. Specific `DO NOT USE FOR` boundaries and the sibling workflow that should win.
5. Copyright holder, when repository conventions do not identify one.
6. Art choice: Azure OpenAI GPT Image 2, OpenAI Images, custom workflow, or placeholder.

Search installed and repository skills for overlapping triggers before creation. If another skill
already owns the same job, stop and propose extending it.

### 2. Discover the repository

Run from the target repository, not this installed skill directory.

1. Prefer the nearest `skills-repo.config.json`.
2. Validate managed identity and settings before deriving canonical repository paths.
3. Without managed config, discover the existing populated `skills/` directory and known
   registration surfaces.
4. Stop before any write when multiple skill roots or catalog surfaces are plausible.

See [repository discovery](references/repository-discovery.md) for the exact contract.

### 3. Preview creation

Invoke this script by absolute path while keeping the target repository as the working directory:

```text
node <skill-dir>/scripts/create-skill.mjs <name> \
  --summary "<summary>" \
  --use-for "<trigger phrases>" \
  --do-not-use-for "<boundaries>" \
  --author "<holder>" \
  --dry-run
```

Show the complete JSON preview and approval token. The preview includes every skill file and every
registration surface. Ask the user to approve that exact hash once.

### 4. Apply creation

Repeat the same command and replace `--dry-run` with `--approve <hash>`. Do not alter any input
between preview and apply. The tool rejects a stale hash, existing skill directory, symlinked
destination, missing locked Vally toolchain, ambiguous registration, or invalid PNG.

Creation includes:

- `SKILL.md` with only `name` and `description` frontmatter keys.
- `README.md`, `LICENSE`, `package.json`, and `package-lock.json`.
- `.vally.yaml`, deterministic tests, and `evals/<name>/eval.yaml`.
- `thumbnail.png` and a byte-identical catalog copy when the repository has a catalog.
- Marketplace, plugin, README, eval workflow, Dependabot, and catalog registration when present.
- Prompt and non-secret provenance in `docs/thumbnail-prompts.md` when present.

### 5. Choose art

The initial placeholder is deliberate and deterministic. Replace it only when requested.

#### Built-in providers

Preview the exact action:

```text
node <skill-dir>/scripts/create-skill.mjs art <name> \
  --provider azure-openai \
  --prompt "<exact prompt>" \
  --dry-run
```

Supported choices:

- `azure-openai`: Azure OpenAI GPT Image 2 at the exact configured
  `https://<resource>.openai.azure.com` origin.
- `openai`: OpenAI Images at the exact `https://api.openai.com` origin.
- `placeholder`: deterministic local PNG with no network or billed call.

The placeholder and check commands run on bare Node. Before a network provider, run
`npm ci --ignore-scripts` in the installed `create-skill` directory so its locked SDKs are
available.

Show provider, exact endpoint, model, prompt, targets, billing status, one attempt, and no fallback.
Ask for approval of the single-use action hash. Then repeat with `--approve <hash>`.

Built-in requests disable redirects and SDK retries. Never retry automatically. Never switch
providers after a timeout, redirect, rate limit, service error, invalid response, or rejected PNG.
Report the failure and ask the user what to do.

#### Custom provider or delivery workflow

Ask: "Describe any provider and delivery workflow you want me to use for the thumbnail."

The answer is open-ended. It may name an API, MCP tool, browser flow, local application, uploaded
attachment, shared storage location, human handoff, or another delivery mechanism. Never reduce
the choice to a local command.

Convert the answer into an exact action preview containing:

1. Provider and destination.
2. Exact prompt and non-secret data sent.
3. Exact tool calls, API origin, browser actions, or human handoff steps.
4. Billing or external side effects.
5. One attempt and no fallback.
6. How the final PNG will arrive in the target repository workspace.
7. The skill and catalog paths that will receive the validated bytes.

Show that preview and obtain explicit single-use approval before taking the custom action. Execute
only the approved steps once. Never place credentials in the preview or provenance.

After delivery, save the result as a repository-relative regular file and ingest it:

```text
node <skill-dir>/scripts/create-skill.mjs art <name> \
  --provider custom \
  --custom-description "<approved provider and delivery steps>" \
  --custom-provider "<provider name>" \
  --custom-model "<model or method>" \
  --delivery "<delivery method>" \
  --input "<repository-relative PNG>" \
  --dry-run
```

Approve the displayed hash, then repeat with `--approve <hash>`. The CLI never executes a custom
command. It accepts the delivered PNG only after the same strict validation used for built-in art.
See [art and provenance](references/art-and-provenance.md).

### 6. Validate

Run:

```text
node <skill-dir>/scripts/create-skill.mjs check <name>
npm test
npm run eval:lint
```

Run `devx skills doctor`, strict skill checking, routing, and overlap checks when those tools are
available in the target repository. Do not run the full capability eval unless the user accepts
its agent usage.

### 7. Generate a deterministic fixture

Repository generators may create functional example skills through the stable fixture contract:

```text
node <skill-dir>/scripts/create-skill.mjs fixture \
  --input "<fixture.json>" \
  --repo-root "<target-repository>" \
  --dry-run
```

Parse the JSON preview, obtain or propagate approval for its `hash`, then repeat the unchanged
command with `--approve <hash>`. Fixture mode is always noninteractive. It accepts only the version
1 schema, deterministic built-in placeholder art, and the normal repository registration path.
It never bypasses dry-run, approval, validation, atomic writes, or provenance.

Read [fixture mode](references/fixture-mode.md) for the exact payload and exit contract.

Repository generators use `create-skill register create-skill --dry-run`, followed by the
unchanged command with `--approve <hash>`, after catalog staging. This registers the bundled
authoring skill through the same atomic path without rewriting its skill files.

## Safety Invariants

1. Dry-run never writes files or calls an image provider.
2. Approval binds the exact inputs and target paths. Changed inputs require a new preview.
3. Provider requests make one attempt with no retry, redirect, or fallback.
4. Custom workflows require an exact preview and approval before any external action.
5. Provider output is untrusted until the complete PNG validator accepts it.
6. Skill and catalog thumbnails are written from the same validated buffer and verified equal.
7. Secrets never enter prompts, previews, logs, generated files, or provenance.
8. Existing files are preserved when planning fails. Apply uses staged sibling files and rollback.
9. No git staging, commit, push, issue, pull request, or repository setting change is part of this
   skill.

## Exit Criteria

- The skill has every required file and only portable SKILL.md frontmatter keys.
- Every discovered or configured registration surface includes the skill.
- Skill and catalog thumbnails are byte-identical and pass strict PNG validation.
- Prompt and non-secret provenance are recorded when that repository surface exists.
- Deterministic tests and Vally lint pass.
- The final report lists exact changed files, commands, results, and any blocked work.
