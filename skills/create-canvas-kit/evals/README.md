# create-canvas-kit eval

A [Vally](https://aka.ms/vally) **capability** eval for the `create-canvas-kit`
skill. It checks that, given a build request, the agent produces a canvas
extension that honours the kit contract.

It is **not** a per-PR gate — it drives a real LLM agent (the built-in
`copilot-sdk` executor), so it costs tokens and time. Run it **on demand** or on a
**nightly** schedule, not on every push. The deterministic file/parse graders are
the backbone; the `prompt` rubric adds judgement.

## Layout

- `../../.vally.yaml` — project config; wires this skill into the executor
  (`paths.skills: "."`) and points at `evals/`.
- `eval.yaml` — the spec: two stimuli (a kanban board canvas; a data canvas that
  fetches + auto-refreshes), each with deterministic graders and an LLM rubric.

## Run it

From the skill root (`skills/create-canvas-kit`):

```bash
npm install                 # one-time: pulls @microsoft/vally + @microsoft/vally-cli (dev only)

# Static validation — fast, no agent, no tokens. This is the gate that must pass.
npm run eval:lint           # = vally lint --eval-spec evals/create-canvas-kit/eval.yaml

# Full run — drives the agent and grades the result (LLM cost/time; needs Copilot auth).
# --skill-dir . loads this skill (via paths.skills in .vally.yaml) into the executor.
npm run eval                # = vally eval --eval-spec evals/create-canvas-kit/eval.yaml --skill-dir .

# Just one stimulus (cheaper):
npx vally eval --eval-spec evals/create-canvas-kit/eval.yaml --skill-dir . --tag canvas=kanban
```

Results land in `vally-results/` (git-ignored). `npx vally serve vally-results`
opens the analytics dashboard.

## Graders

Deterministic (no LLM):

- `file-exists` — the canvas, the view, and the vendored `canvas-kit/` were created.
- `file-contains` / `file-not-contains` / `file-not-matches` — SDK import only in
  `extension.mjs`; the view uses `mountCanvas`; `canvas.mjs` uses the kit `nid`;
  no `el.innerHTML =` repaint (the kit's `dangerouslySetInnerHTML` for SVG icons
  is fine); the data canvas uses `pollWhileVisible` and `AbortSignal.timeout`, no
  `fetch(` in the view.
- `run-command` — `node --check` parses every generated `*.mjs` source.
- `output-matches` — the agent's summary mentions refresh/poll (data stimulus).

LLM rubric (`prompt`): kebab-case Lucide icons, `ck-*` theming, domain-keyed shared
state, and the documented data-template contract.
