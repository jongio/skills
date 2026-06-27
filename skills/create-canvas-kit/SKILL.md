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

**Badges are generic.** Use the semantic variants `ck-badge-success`,
`ck-badge-accent`, `ck-badge-muted`, `ck-badge-danger`, `ck-badge-attention` and
map *your* statuses to them in the view (the reference does
`open → success, decided → accent, parked → muted`). Don't add app-specific
status class names to the shared theme.

**Loading & error primitives** (don't hand-roll these):

- `ck-spinner` — spin animation; pair with a Lucide loader, e.g.
  `html\`<\${Icon} name="loader-circle" class="ck-spinner" />\``.
- `ck-skeleton` — shimmering placeholder block for content that's still loading.
- `ck-callout` / `ck-callout ck-error` — an inline notice / error surface for a
  failed fetch, e.g. `html\`<div class="ck-callout ck-error"><\${Icon} name="circle-x" size=\${16} /><span>\${state.error}</span></div>\``.

**Motion safety is global.** `theme.css` already ships a
`@media (prefers-reduced-motion: reduce)` guard that neutralizes *all* animations
and transitions (kit spinners/skeletons and any you add). You do **not** repeat
it per canvas — but do keep motion decorative, never the only signal.

## View API — hooks, helpers, fragments

`/kit/client.mjs` re-exports the full vendored Preact hook set, not just
`useState`: `useEffect`, `useRef`, `useMemo`, `useCallback`, `useReducer`,
`useContext`, `useLayoutEffect`, `useImperativeHandle`. Call hooks
unconditionally at the top of a component — **before** any early `return`
(e.g. the `if (!state) return …` loading branch comes after your hooks).

It also exports formatting + id helpers so you stop reinventing them:

```js
import { nid, relativeTime, compactNumber, percent } from "/kit/client.mjs";
nid();                       // "lq3k9f2a" — short unique id
relativeTime(iso);           // "5m ago" / "3h ago" / "2d ago" / a date
compactNumber(2_300_000);    // "2.3M"
percent(1.25);               // "+1.25%"
```

`nid` is also importable server-side in `canvas.mjs` via
`import { nid } from "./canvas-kit/format.mjs"` (the generator does this).

**`Fragment` is NOT exported.** To return sibling nodes without a wrapper, use
htm's built-in empty-tag syntax — `` html`<><${A} /><${B} /></>` `` — or just
return an array of vnodes. Don't `import { Fragment }`; it isn't there.

## External-data canvases — fetch + auto-refresh

Most real canvases aren't user-entered CRUD lists; they pull from the network and
refresh. The shape:

1. **`fetch()` lives in the action handler (or a helper it calls), never in the
   view.** Always bound it with a timeout so a slow upstream can't hang the panel:

   ```js
   async function fetchItems(url) {
     const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
     if (!res.ok) throw new Error(`HTTP ${res.status}`);
     return mapItems(await res.json());
   }
   ```

   The fetch runs server-side on the loopback runtime, so a caller-set
   `sourceUrl` is an **unrestricted server-side fetch** (it can reach internal
   hosts), and anything you feed back to the agent (e.g. via `list_items`) is
   attacker-influenced text. That's acceptable for a local dev tool you point at
   a source *you* choose — but don't let an untrusted party set the URL, and
   treat fetched content as untrusted (render it as text, never `innerHTML`).

2. **Expose a `refresh` action** that fetches and writes the result into shared
   state. Capture failures into `state.error` and *return* (don't throw) so a
   background poll tick stays quiet while the error card shows. Capture the input
   **before** the `await`, and write back with a **functional `set`** so a
   concurrent action (another poll, a `set_source`) isn't clobbered:

   ```js
   refresh: {
     inputSchema: { type: "object", properties: {}, additionalProperties: false },
     handler: async ({ state, set }) => {
       const sourceUrl = state.sourceUrl;          // capture before await
       try {
         const items = await fetchItems(sourceUrl);
         set((cur) => cur.sourceUrl !== sourceUrl  // drop a stale response
           ? cur
           : { ...cur, items, error: null, lastRefresh: new Date().toISOString() });
         return { count: items.length };
       } catch (err) {
         set((cur) => ({ ...cur, error: `Couldn't load: ${err.message}`, lastRefresh: new Date().toISOString() }));
         return { ok: false, error: String(err.message) };
       }
     },
   },
   ```

3. **Poll with the kit, not a raw `setInterval`.** `pollWhileVisible(tick,
   seconds)` runs `tick` on an interval **only while the panel is visible** (so a
   backgrounded canvas stops hitting the network) and returns a cleanup function —
   a drop-in `useEffect` return:

   ```js
   import { pollWhileVisible } from "/kit/client.mjs";
   // interval bound to durable state; rebuilds when it changes:
   useEffect(() => pollWhileVisible(() => invoke("refresh"), state.autoRefreshSec || 0),
             [state.autoRefreshSec]);
   ```

   For a fixed interval you can skip the effect entirely:
   `mountCanvas({ view, poll: { action: "refresh", seconds: 60, immediate: true } })`.

Stamp this whole shape with `node scripts/new-canvas.mjs <name> --template data`.

## Domain strategy — shared board vs personal profile

State is keyed by the domain id `resolveDomainId` returns. Two intents, identical
machinery (`fileFor` sanitizes the id to a filename — copy it verbatim):

- **Shared board** (most canvases): key off a topic the agent and user both name.
  `resolveDomainId: (input) => (input?.domain ? String(input.domain) : "default")`.
  Anyone who opens `domain: "tech"` sees the same board.
- **Personal store**: key off an identity, not a topic.
  `resolveDomainId: (input) => (input?.profile ? String(input.profile) : "default")`,
  with the input schema property named `profile`. Use this for per-learner /
  per-user data that shouldn't bleed across topics.

Pick the noun (`domain` vs `profile`) deliberately — it's the whole contract for
who shares what.

## Patterns & limitations (know these)

- **Bundled catalog.** For curated seed data (courses, presets), ship a separate
  `catalog.mjs`: plain data plus a `buildCourse(...)`-style builder that assigns
  **deterministic positional ids** (`es-u1-l2`) so the same catalog always
  produces the same ids. Keep the bulk data terse with tiny constructor helpers.
- **`statusLine` is computed once, at open.** The panel's status string is set on
  `openInstance` and is **not** re-pushed when an action mutates state, so a
  count in `statusLine` goes stale. Show live counts **inside** the canvas body
  (which re-renders on every SSE push), and treat `statusLine` as an
  open-time-only summary.
- **Rich-payload actions.** If the UI needs to hand the agent's handler a whole
  object (e.g. the article being saved) rather than scalar fields, set
  `additionalProperties: true` on that action's `inputSchema` (the generator
  defaults to `false`). Denormalize what you need into durable state in the
  handler.
- **Install layout / SDK resolution.** A shipped extension folder contains only
  `copilot-extension.json` (`{ "name", "version": 1 }` — no `package.json`),
  `extension.mjs`, `canvas.mjs`, `web/`, and the nested `canvas-kit/`. The host
  resolves `@github/copilot-sdk/extension` for you; `extension.mjs` is the only
  file that imports it. Don't add a `package.json` or a build step.

## Build a canvas — fastest path

1. **Stamp it** (one working canvas, kit already nested, a smoke test included):
   ```
   node scripts/new-canvas.mjs <name> --dir <target> --title "Display Name"
   ```
   For an in-repo extension, target `.github/extensions/<name>`. For a personal
   one, target `$COPILOT_HOME/extensions/<name>`. Add `--template data` for an
   external-data canvas (fetch + `refresh` + visibility-gated polling) instead of
   the default user-entered list.
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
   `node test/http.test.mjs` (and `node test/kit-parity.test.mjs`,
   `node test/generator.test.mjs`). A stamped canvas ships its own
   `test/smoke.test.mjs` — run it from the canvas folder
   (`node test/smoke.test.mjs`) to prove its actions over real HTTP.
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
- `test/generator.test.mjs` — stamps both templates, runs their smoke tests, and
  checks the kit API surface (format helpers, poll helper, theme primitives).

## Footguns

- **Never** repaint with `innerHTML`; render through Preact so pushes don't eat
  keystrokes.
- **Never** key state by `instanceId` — key by domain so panels stay in sync.
- **Never** hand-roll or CDN-load icons — use `/kit/client.mjs`'s `Icon`.
- **Never** put SDK imports outside `extension.mjs`.
- **Never** pass `strokeWidth` to `Icon` or invent pixel sizes off the scale.
- **Never** `fetch()` in the view — network I/O belongs in an action handler,
  always with `AbortSignal.timeout(...)`.
- **Never** hand-roll a polling `setInterval` — use `pollWhileVisible` so a
  hidden panel stops hammering the network.
- **Never** `import { Fragment }` — it isn't exported; use htm's `<>…</>`.
