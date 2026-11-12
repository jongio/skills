# create-gh-pages-site eval

A [Vally](https://aka.ms/vally) **capability** eval for the `create-gh-pages-site`
skill. It checks that, given a site creation request, the agent produces a working
GitHub Pages site with the correct base path, deploy workflow, and real content
derived from the target repo.

It is **not** a per-PR gate. It drives a real LLM agent (the built-in `copilot-sdk`
executor), so it costs tokens and time. Run it **on demand** or on a **nightly**
schedule, not on every push. The deterministic file/parse graders are the backbone;
the `prompt` rubric adds judgement.

## Layout

- `../../.vally.yaml` - project config; wires this skill into the executor
  (`paths.skills: "."`) and points at `evals/`.
- `create-gh-pages-site/eval.yaml` - the spec: stimuli with deterministic graders
  and an LLM rubric.

## Run it

From the skill root (`skills/create-gh-pages-site`):

```bash
npm install                 # one-time: pulls @microsoft/vally-cli (dev only)

# Static validation (fast, no agent, no tokens). This is the CI gate.
npm run eval:lint           # = vally lint --eval-spec evals/create-gh-pages-site/eval.yaml --strict

# Full run (drives the agent and grades the result; needs Copilot auth).
npm run eval                # = vally eval --eval-spec evals/create-gh-pages-site/eval.yaml --skill-dir .

# Just one stimulus (cheaper):
npx vally eval --eval-spec evals/create-gh-pages-site/eval.yaml --skill-dir . --tag template=astro
```

Results land in `vally-results/` (git-ignored). `npx vally serve vally-results`
opens the analytics dashboard.

## Graders

Deterministic (no LLM):

- `skill-invocation` / `tool-calls` - `create-gh-pages-site` is invoked and remote repository/Pages mutations remain blocked.
- `file-exists` - the deploy workflow, index page, and config files were created.
- `file-contains` - base path is correctly injected, workflow uses `actions/deploy-pages` / `actions/upload-pages-artifact`.
- `file-not-contains` - no leftover `__SENTINEL__` placeholders or sample copy remain.

LLM rubric (`prompt`): site content references the repo name, description is not
generic demo text, and the structure matches the chosen template type.
