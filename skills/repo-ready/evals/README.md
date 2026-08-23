# repo-ready eval

A [Vally](https://aka.ms/vally) **capability** eval for the `repo-ready` skill.

The unit tests in `../test/` already cover the deterministic script layer:
stack detection, gap scanning, and file generation. This eval covers the layer
those tests cannot reach, which is the agent's judgment: whether it resolves
repository visibility from authoritative data instead of guessing, whether it
composes multiple detected stacks correctly, whether update mode stays limited
to real gaps, and whether a stated licensing intent maps to the right SPDX
identifier.

It is **not** a per-PR gate. It drives a real LLM agent (the built-in
`copilot-sdk` executor), so it costs tokens and time. Run it **on demand** or on
the **nightly** schedule. The per-PR gate is the fast static `vally lint` plus
`npm test`.

## Layout

- `../.vally.yaml`: project config; wires this skill into the executor
  (`paths.skills: "."`) and points at `evals/`.
- `repo-ready/eval.yaml`: the spec: four analysis-only stimuli.

## Run it

From the skill root (`skills/repo-ready`):

```sh
npm ci --ignore-scripts   # one-time: pulls @microsoft/vally-cli (dev only)

# Static validation (fast, no agent, no tokens). This is the CI gate.
npm run eval:lint

# Full run (drives the agent and grades the result; needs Copilot auth).
npm run eval

# Just one stimulus (cheaper):
npx vally eval --eval-spec evals/repo-ready/eval.yaml --skill-dir . --tag scenario=visibility
```

Results land in `vally-results/` (git-ignored).

## Stimulus design

Every stimulus is deliberately answerable **without** running a command,
touching the network, or writing a file. That keeps runs fast and lets
`diff-empty` and `tool-calls` act as hard gates.

Each prompt also asks for at least one fact that cannot be inferred from
general knowledge of GitHub conventions, such as the exact templates that are
always added to every `.gitignore`, or the audience default that follows from a
private repository. An agent that answers from general knowledge without
opening the skill will miss those, so the `skill-invocation` grader stays
meaningful rather than passing by luck.

## Graders

Per stimulus:

- `prompt`: an LLM rubric scored on a 1 to 5 scale. Vally normalizes this as
  `(raw - 1) / 4`, so the `0.75` threshold means a 4 or a 5 passes and a 3 or
  below fails. Setting it any higher would demand a perfect judge score on
  every run.
- `skill-invocation`: the `repo-ready` skill was actually loaded.
- `diff-empty`: the workspace was left untouched.
- `tool-calls`: no network command and no web tool was used.
