# naming-is-hard eval

A [Vally](https://aka.ms/vally) **capability** eval for the `naming-is-hard` skill.
It checks that, given a request to name something and check availability, the agent
engages the skill's flow (brief, diverse candidate deck, availability, a report with
verdict tiers) and that an obvious famous-brand collision is flagged as a Deal
Breaker.

It is **not** a per-PR gate. It drives a real LLM agent (the built-in `copilot-sdk`
executor), so it costs tokens and time. Run it **on demand** or on a **nightly**
schedule. The per-PR gate is the fast static `vally lint` (plus `npm test`).

## Layout

- `../../.vally.yaml`: project config; wires this skill into the executor
  (`paths.skills: "."`) and points at `evals/`.
- `naming-is-hard/eval.yaml`: the spec: two stimuli with deterministic file graders
  and LLM rubrics.

## Run it

From the skill root (`skills/naming-is-hard`):

```bash
npm install                 # one-time: pulls @microsoft/vally-cli (dev only)

# Static validation (fast, no agent, no tokens). This is the CI gate.
npm run eval:lint

# Full run (drives the agent and grades the result; needs Copilot auth).
npm run eval

# Just one stimulus (cheaper):
npx vally eval --eval-spec evals/naming-is-hard/eval.yaml --skill-dir . --tag scenario=deal-breaker
```

Results land in `vally-results/` (git-ignored). `npx vally serve vally-results`
opens the analytics dashboard.

## Graders

Deterministic (no LLM):

- `file-exists`: the run's `naming-state.json` was created.
- `file-contains`: the persisted state carries a `brief` and `candidates`.

LLM rubric (`prompt`): the agent wrote a brief, generated varied names, presented
availability with verdict tiers, and correctly flagged a famous brand as a Deal
Breaker.
