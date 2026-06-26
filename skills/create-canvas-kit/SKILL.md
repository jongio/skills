---
name: create-canvas-kit
description: >-
  Build a GitHub Copilot App canvas extension the right way, fast. Use when the
  user wants to create, scaffold, or improve an interactive canvas (a side-panel
  UI the agent can open and drive) — dashboards, editors, trackers, boards,
  document/preview surfaces. Provides a no-build Preact + htm kit with live SSE
  state, durable per-user storage, Primer theming, and the official GitHub
  Lucide icon set, plus a generator that stamps a working canvas in one command.
  Do NOT use for non-canvas extensions (plain agent tools) or for shipping web
  apps unrelated to Copilot canvases.
---

# Create Canvas Kit

A batteries-included way to build **Copilot App canvas extensions**. It exists
because hand-rolled canvases keep hitting the same walls: an `innerHTML` repaint
loop that eats keystrokes, state that lives only in one panel, ad-hoc styling
that ignores the host theme, and inconsistent icons. The kit fixes all four.

## What a canvas is (and when to build one)

A canvas is an interactive surface the agent opens in a side panel via
`open_canvas`. Both the **agent** and the **user** act on the **same state**
through the **same action handlers**. Reach for a canvas when chat text or a diff
isn't enough: live dashboards, editors, spreadsheets, trackers, kanban/board
views, document previews, tool-specific workflows.

If the user just needs a non-visual agent tool, build a normal extension tool
instead — not a canvas.

## Rendering tier — decide first

| Tier | Use when | How |
| --- | --- | --- |
| **Static HTML string** | Read-only or near-static content; no inputs to protect | The runtime's vanilla scaffold (`extensions_manage scaffold kind:canvas`). |
| **Preact + htm + this kit** | Anything interactive: inputs, live updates, lists, forms, shared state | This kit. **Default choice for real canvases.** |

The single most important reason to use the kit: **Preact diffs the DOM**, so a
live state push from the agent does **not** clobber focus, caret position, or
half-typed text in an input. The `innerHTML = ...` pattern most early canvases
use repaints the whole tree and loses keystrokes on every push. Don't do that.

## The model (read this before coding)

```
extension.mjs   ── the ONLY file that imports the Copilot SDK (thin adapter)
canvas.mjs      ── your canvas: id, schema, state load/save, action handlers (SDK-free)
canvas-kit/     ── the kit (copied in verbatim; do not edit)
web/index.html  ── shell: loads /kit/theme.css and ./app.mjs
web/app.mjs     ── your Preact view
```

- **State is shared and durable.** It's keyed by a *domain id* resolved from the
  open input (`resolveDomainId`), **not** by `instanceId` — open the same domain
  in two panels and they show the same data. Persistence goes through
  `userStore(extName, file)` → `$COPILOT_HOME/extensions/<name>/artifacts/<domain>.json`.
- **Agent and UI share handlers.** An action invoked by the agent and the same
  action invoked from a button run the identical handler and produce the identical
  state mutation. Write the logic once, in `canvas.mjs`.
- **Live updates are automatic.** The kit serves `GET /state`, `GET /events`
  (SSE), and `POST /action`. `mountCanvas` wires them up; every state change fans
  out to all open panels.
- **`server.mjs` is SDK-free** so the whole runtime is testable with plain Node
  HTTP (see `test/http.test.mjs`). Keep SDK calls in `extension.mjs` only.

### Two kinds of state in the view — keep them separate

- **Shared domain state** arrives via SSE and is re-rendered on every push. Treat
  it as read-only in the view; change it only by calling `invoke(action, input)`.
- **Local UI state** (a draft input value, the active tab/filter) lives in
  `useState` and must never be pushed to the server until the user commits it.

## Icons — official GitHub Lucide, always

The kit vendors the **exact Lucide set github-app ships** (`lucide-react@1.14.0`,
byte-identical). Use it for *every* icon; do not hand-write SVGs or pull a CDN.

```js
import { Icon } from "/kit/client.mjs";
html`<${Icon} name="circle-check" size=${16} />`
```

Contract: names are **kebab-case** (`circle-check`, `trash-2`, `list-todo`).
`viewBox` is fixed `0 0 24 24`, `stroke-width` is `2` — **never** pass
`strokeWidth`. Use sizes `12 · 14 · 16 · 20 · 24 · 32`. Match github-app's own
glyph choices when there's an obvious mapping (e.g. open=`circle-dot`,
done=`circle-check`, bookmark=`bookmark`). `iconNames()` / `hasIcon(name)` are
available if you need to validate.

## Theme — Primer tokens, with fallbacks

Link `/kit/theme.css` and build on its `ck-*` classes (`ck-card`, `ck-btn`,
`ck-btn-primary`, `ck-input`, `ck-badge`, `ck-tabs`, `ck-status`, `ck-empty`, …).
They map to the Primer tokens the runtime injects onto the canvas document, each
with a hardcoded GitHub-dark fallback, so a canvas looks right even if a token is
missing. Add canvas-specific CSS on top; don't restyle the primitives.

## Build a canvas — fastest path

1. **Stamp it** (one working list canvas, kit already nested):
   ```
   node scripts/new-canvas.mjs <name> --dir <target> --title "Display Name"
   ```
   For an in-repo extension, target `.github/extensions/<name>`. For a personal
   one, target `$COPILOT_HOME/extensions/<name>`.
2. **Reload + open.** Run `extensions_reload`, then `open_canvas` with
   `canvasId: "<name>"`. The list canvas works immediately.
3. **Shape your data.** In `canvas.mjs`, edit `createInitialState`, the action
   handlers (rename/replace `add_item`/`toggle_item`/`remove_item`/`list_items`),
   and `statusLine`. Keep each handler pure: read `state`, call `set(next)`,
   return a small result.
4. **Shape the view.** In `web/app.mjs`, render the shared state and call
   `invoke("<action>", input)` from controls. Keep drafts in `useState`.
5. **Add an action both sides use.** Give the agent a verb (e.g. `add_item`) and
   wire the same verb to a button — one handler, two callers.

If you prefer to hand-assemble instead of using the generator: copy `kit/` into
your extension as `canvas-kit/`, then copy `reference/decision-log/extension.mjs`
verbatim and adapt `canvas.mjs` + `web/` from the reference.

## Validate visually — don't claim done without looking

A canvas isn't done because the server boots. Verify the UI:

1. Run the standalone HTTP test to prove the runtime contract:
   `node test/http.test.mjs` (and `node test/kit-parity.test.mjs`).
2. Open the canvas and **look at it** (Playwright or the browser canvas):
   navigate to the panel, assert key text/controls render, take a screenshot.
3. Drive an action from the UI **and** invoke the same action as the agent;
   confirm both update the panel live (SSE) without losing input focus.
4. Only then report it as working.

## Reference + tests (study these)

- `reference/decision-log/` — a complete, working canvas in the exact installed
  shape (kit nested as `canvas-kit/`). Best example of every contract above.
- `kit/` — the canonical kit you copy in. Source of truth.
- `test/http.test.mjs` — boots the SDK-free runtime over real HTTP and checks
  `/state`, `/events`, `/action`, static serving, and path-traversal safety.
- `test/kit-parity.test.mjs` — guarantees `kit/` and the reference's bundled
  `canvas-kit/` stay byte-identical.

## Footguns

- **Never** repaint with `innerHTML`; render through Preact so pushes don't eat
  keystrokes.
- **Never** key state by `instanceId` — key by domain so panels stay in sync.
- **Never** hand-roll or CDN-load icons — use `/kit/client.mjs`'s `Icon`.
- **Never** put SDK imports outside `extension.mjs`.
- **Never** pass `strokeWidth` to `Icon` or invent pixel sizes off the scale.
