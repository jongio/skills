---
name: create-canvas-app
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

# Create Canvas App

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
extension.mjs   ── the ONLY file that imports the Copilot SDK (thin adapter; also wires host AI)
canvas.mjs      ── your canvas: id, schema, state load/save, action handlers (SDK-free)
canvas-kit/     ── the kit (copied in verbatim; do not edit)
web/index.html  ── shell: loads /kit/theme.css and ./app.mjs
web/app.mjs     ── your Preact view
```

- **State is shared and durable.** It's keyed by a *domain id* resolved from the
  open input (`resolveDomainId`), **not** by `instanceId` — open the same domain
  in two panels and they show the same data. Persistence goes through
  `userStore(extName, file)` → `$COPILOT_HOME/extensions/<name>/artifacts/<domain>.json`.
  Two more tiers exist in `kit/storage.mjs` for non-durable/scoped state:
  `sessionStore(sessionId, extName, file)` (per-session scratch, discarded with
  the session) and `workspaceStore(workspacePath, file)` (rooted at the session
  workspace). All three write atomically (temp + rename) and **serialize
  concurrent saves to the same file**, so a racing agent + UI save can't corrupt
  or `EPERM` the durable file.
- **Shared, multiplayer state (optional).** For a board multiple *people* edit,
  swap the local tier for `githubStore({ owner, repo, path })` from
  `kit/github-store.mjs`: it persists the same JSON to a file in a (private) repo
  via the GitHub Contents API, so every collaborator with push access edits ONE
  document — GitHub is both the store and the access control. Wire it as
  `loadState`/`saveState`, and add `syncState: () => store.poll()` +
  `syncIntervalMs` so the runtime polls for other people's edits (cheap ETag `304`
  when unchanged) and adopts them live — but only while a panel is being viewed.
  Writes are optimistic-locked by blob SHA (a conflicting commit re-reads +
  retries; last-writer-wins by default, or pass a `merge(remote, mine)`). Token
  comes from `GH_TOKEN`/`GITHUB_TOKEN` or `gh auth token` and is only ever sent as
  an `Authorization` header.
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

### Action results & errors — how failures surface

Both callers (agent and UI) hit the same handler, and the runtime wraps every
invocation in the same envelope, so model failures deliberately:

- **Return** a small plain object for success (`{ id, status }`, `{ count }`).
  `POST /action` answers `{ ok: true, result }`.
- **Throw** for a hard failure (bad input, missing id). The runtime answers
  `{ ok: false, code, message }` — HTTP **400** for a known kit error (e.g. an
  unknown action) and **500** for a handler `throw` — and `mountCanvas`'s
  `invoke` **rejects** with a `CanvasActionError` carrying that `code`/`message`,
  so a button handler can `try/catch` it. On the agent side, `extension.mjs` maps
  the same error to a `CanvasError`. A throw is *surfaced*, never a crash.
- For an **expected, transient** failure (a flaky upstream fetch on a background
  poll), don't throw — capture it into `state.error` and **return** so the error
  card shows while the poll stays quiet (see the data template's `refresh`).

### Input & state are schema-validated at the boundary

An action's `inputSchema` is **enforced by the runtime**, not just declared: a
payload that violates it (wrong type, missing required field, out-of-enum value,
or an unexpected property under `additionalProperties: false`) is rejected with
an `invalid_input` error (**HTTP 400**) *before* your handler runs — from the
agent side too. So `inputSchema` is your typed contract; write it precisely and
your handler only sees well-shaped input. **Business rules still live in the
handler** (a schema-valid but empty `"   "` title reaches the handler, which
throws → 500). Open input is validated against `config.inputSchema` the same way.

Optionally set `config.stateSchema` (same JSON-Schema subset, `kit/validate.mjs`)
to guard the **durable shape**: if a handler produces state that violates it, the
mutation is rolled back and the action fails loud (500) instead of persisting
corrupt state. It's opt-in — omit it and any state shape is allowed.

## Icons — official GitHub Lucide, always

The kit vendors the **exact Lucide set github-app ships** (`lucide-react@1.23.0`,
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

**The formatters are locale-aware** — `relativeTime` ends in a
`toLocaleDateString()`, and `compactNumber`/`percent` go through
`Number.prototype.toLocaleString`, so their output depends on the host locale
(`"1.5K"` vs `"1,5 K"`, `2025-01-31` vs `31/01/2025`). Keep the **raw** values in
durable state (an ISO string, a `Number`) and format **in the view**. Never store
a formatted string and never parse one back — formatting is a presentation
concern, and a value formatted under one locale can't be reliably re-read under
another.

**`Fragment` is NOT exported.** To return sibling nodes without a wrapper, use
htm's built-in empty-tag syntax — `` html`<><${A} /><${B} /></>` `` — or just
return an array of vnodes. Don't `import { Fragment }`; it isn't there.

## External-data canvases — fetch + auto-refresh

Most real canvases aren't user-entered CRUD lists; they pull from the network and
refresh. The shape:

1. **`fetch()` lives in the action handler (or a helper it calls), never in the
   view.** Use the kit's **`safeFetch`** — it SSRF-guards the URL and applies a
   hard timeout, so a caller-influenced source can't reach the internal network
   and a slow upstream can't hang the panel:

   ```js
   import { safeFetch } from "./canvas-kit/net.mjs";

   async function fetchItems(url) {
     const res = await safeFetch(url, { headers: { Accept: "application/json" } });
     if (!res.ok) throw new Error(`HTTP ${res.status}`);
     return mapItems(await res.json());
   }
   ```

   `safeFetch` runs server-side on the loopback runtime, so it enforces an **SSRF
   guard** (`kit/net.mjs`): it allows only `http`/`https` to a **public** host and
   rejects loopback, link-local (incl. cloud metadata), and private ranges —
   including every address the hostname resolves to — then fetches with an
   `AbortSignal.timeout`. `assertPublicUrl(url)` / `isBlockedAddress(ip)` are also
   exported if you need the check without the fetch. Anything you feed back to the
   agent (e.g. via `list_items`) is still attacker-influenced text, so keep the
   source one *you* choose and treat fetched content as untrusted (render it as
   text, never `innerHTML`).

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

## Build a canvas — fastest path

1. **Stamp it** (one working canvas, kit already nested, a smoke test included):
   ```
   node scripts/new-canvas.mjs <name> --dir <target> --title "Display Name"
   ```
   Target `.github/extensions/<name>` for an in-repo extension (committed, shared
   with the team), `$COPILOT_HOME/extensions/<name>` for a personal one (local to
   you), or `$COPILOT_HOME/session-state/<sessionId>/extensions/<name>` for a
   throwaway canvas scoped to just the current session — it's discovered like the
   others (its `extensionId` is `session:<sessionId>:<name>`) and disappears when
   the session does. Add `--template data` for an external-data canvas (fetch +
   `refresh` + visibility-gated polling), or `--template ai` for a host-AI canvas
   (`ctx.ai` silent generation + `ctx.askAgent` handoff), instead of the default
   user-entered list.
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

## Keeping your vendored kit in sync

A shipped extension vendors the kit **verbatim** as `canvas-kit/` — there's no npm
package or build step, so nothing tells you whether the copy you shipped matches
the current `kit/`. The kit is version-stamped to close that gap: `kit/version.mjs`
exports `KIT_VERSION` (re-exported from `/kit/client.mjs`), and two scripts keep
vendored copies honest.

- **Re-sync after a kit change.** Bump `KIT_VERSION` when you change any kit file,
  then refresh each vendored copy:
  ```
  node scripts/sync-kit.mjs <extension-dir>
  ```
  This makes `<extension-dir>/canvas-kit/` an exact mirror of `kit/` —
  overwriting changed files **and pruning stale ones** (a file removed upstream
  won't linger) — and records the version into
  `<extension-dir>/canvas-kit/.kit-version.json`.

- **Gate drift in CI (offline).** Fail the build if any vendored kit has drifted
  from `kit/` — by file set, by file contents, or by recorded version:
  ```
  node scripts/check-kit-freshness.mjs <extensions-dir>
  ```
  Point it at a folder of extensions (e.g. `.github/extensions`), a single
  extension dir, or a `canvas-kit/` dir. Exit 0 = all fresh; exit 1 = drift, with
  the offending files listed. It runs no network and needs no dependencies.

The `.kit-version.json` marker is metadata, **not** a kit file — the byte-parity
test (`test/kit-parity.test.mjs`) and the freshness check both treat it as
out-of-band, so it never counts against `kit/` ↔ `canvas-kit/` parity.

- **Re-vendor the Lucide glyphs (rare).** `kit/vendor/lucide.mjs` is
  AUTO-GENERATED to match the exact `lucide-react` release the Copilot host app
  ships, so canvases render the same glyphs the host does. When the host bumps its
  Lucide version, regenerate the file deterministically rather than hand-editing:
  ```
  node scripts/vendor-lucide.mjs <version>
  ```
  Then bump `KIT_VERSION` and re-sync vendored copies. Pass `--icons-dir <path>`
  to vendor from an existing install instead of fetching one.

## Validate visually — don't claim done without looking

A canvas isn't done because the server boots. Verify the UI:

1. Run the standalone HTTP test to prove the runtime contract:
   `node test/http.test.mjs` (and `node test/client.test.mjs`,
   `node test/kit-parity.test.mjs`,
   `node test/generator.test.mjs`, `node test/tooling.test.mjs`,
   `node test/vendor-lucide.test.mjs`, `node test/kit-runtime.test.mjs`). A stamped canvas
   ships its own `test/smoke.test.mjs` — run it from the canvas folder
   (`node test/smoke.test.mjs`) to prove its actions over real HTTP.
2. Open the canvas and **look at it** (Playwright or the browser canvas):
   navigate to the panel, assert key text/controls render, take a screenshot.
3. Drive an action from the UI **and** invoke the same action as the agent;
   confirm both update the panel live (SSE) without losing input focus.
4. Only then report it as working.

## Reference + tests (study these)

- `reference/decision-log/` — a complete, working canvas in the exact installed
  shape (kit nested as `canvas-kit/`). Best example of every contract above —
  including the host model: a `summarize` action (silent `ctx.ai`) and a
  `hand_to_agent` action (`ctx.askAgent`), each capturing model errors into state.
  It also demonstrates every deep-link builder: a `set_repo` action, a per-decision
  "Open in session" link, and an "Open in github-app" card (Chats, new automation,
  issue/PR, open-by-session-id, and a hosted-launcher web-links toggle).
- `reference/deeplinks.md` — the deep-link schema reference: routes, parameters, the
  validation the builders apply, the webview mechanism, and how to add a route.
- `kit/` — the canonical kit you copy in. Source of truth.
- `test/http.test.mjs` — boots the SDK-free runtime over real HTTP and checks
  `/state`, `/events`, `/action`, static serving, path-traversal safety, and the
  host-model actions (offline-error capture + a wired-host stub).
- `test/client.test.mjs` — unit-tests the DOM-free client transport
  (`connectCanvas`): the initial `/state` fetch, SSE state pushes + connected flag,
  and `invoke` → `POST /action` (result + `CanvasActionError` on failure), with
  stubbed `fetch`/`EventSource` (no browser needed).
- `test/kit-parity.test.mjs` — guarantees `kit/` and the reference's bundled
  `canvas-kit/` stay byte-identical.
- `test/deeplinks.test.mjs` — checks the `ghapp://` builders: input validation
  (matching github-app), param encoding, injection resistance, and the launcher wrapper.
- `test/generator.test.mjs` — stamps the list, data, and ai templates, runs their
  smoke tests, and checks the kit API surface (format helpers, poll helper, theme
  primitives, host-model wiring).
- `test/tooling.test.mjs` — exercises the version stamp (`kit/version.mjs`),
  `scripts/sync-kit.mjs`, and the offline `scripts/check-kit-freshness.mjs` drift gate.
- `test/vendor-lucide.test.mjs` — checks the Lucide vendoring generator
  (`scripts/vendor-lucide.mjs`): sorting, `key`-strip, alias mapping, determinism.
- `test/kit-runtime.test.mjs` — exercises the runtime hardening: `kit/validate.mjs`
  input/`stateSchema` validation (incl. prototype-key safety), the `kit/net.mjs`
  SSRF guard (`assertPublicUrl`/`safeFetch`, IPv4-mapped-IPv6 forms), concurrency-safe
  `kit/storage.mjs` saves + `sessionStore`, the `kit/github-store.mjs` shared store
  (mocked fetch: load/decode, ETag `304` poll, `409` re-read+retry, `404` fallback)
  and the server's `syncState` adopt-and-broadcast loop, prototype-safe
  `kit/icons.mjs` name resolution, and the server's bounded SSE subscriber cap.

## Footguns

- **Never** repaint with `innerHTML`; render through Preact so pushes don't eat
  keystrokes.
- **Never** key state by `instanceId` — key by domain so panels stay in sync.
- **Never** hand `open_canvas` an `instanceId` outside `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`
  — ≤128 chars, an alphanumeric first character, then only `A-Za-z0-9._-`. A malformed
  handle (leading `-`/`_`, spaces, over-long) is rejected by the runtime with
  `Invalid canvas instance ID` before your canvas ever opens.
- **Never** hand-roll or CDN-load icons — use `/kit/client.mjs`'s `Icon`.
- **Never** put SDK imports outside `extension.mjs`.
- **Never** pass `strokeWidth` to `Icon` or invent pixel sizes off the scale.
- **Never** `fetch()` in the view — network I/O belongs in an action handler,
  always with `AbortSignal.timeout(...)`.
- **Never** hand-roll a polling `setInterval` — use `pollWhileVisible` so a
  hidden panel stops hammering the network.
- **Never** `import { Fragment }` — it isn't exported; use htm's `<>…</>`.
- **Never** reach for the model with `fetch`/API keys or a `client.createSession()`
  sub-session (it hangs from an extension) — use `ctx.ai(...)` for silent
  generation, `ctx.askAgent(...)` to drive the main agent.
- **Never** hand-build a `ghapp://` URL, and never omit `target="_blank"` on a
  deep-link anchor. Use the kit builders (`buildSessionDeepLink`, …) and render a
  `target="_blank"` link so the canvas webview routes it into the app.
