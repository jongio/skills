---
name: create-canvas-app
description: >-
  Build a GitHub Copilot App canvas extension the right way, fast. Use when the
  user wants to create, scaffold, or improve an interactive canvas (a side-panel
  UI the agent can open and drive) - dashboards, editors, trackers, boards,
  document/preview surfaces. Provides a no-build Preact + htm kit with live SSE
  state, durable per-user storage, Primer theming, and the official GitHub
  Lucide icon set, plus a generator that stamps a working canvas in one command.
  Do NOT use for non-canvas extensions (plain agent tools) or for shipping web
  apps unrelated to Copilot canvases.
metadata:
  version: "1.1.0"
---

# Create Canvas App

## What a canvas is (and when to build one)

A canvas is an interactive surface the agent opens in a side panel via
`open_canvas`. Both the **agent** and the **user** act on the **same state**
through the **same action handlers**. Reach for a canvas when chat text or a diff
isn't enough: live dashboards, editors, spreadsheets, trackers, kanban/board
views, document previews, tool-specific workflows.

If the user just needs a non-visual agent tool, build a normal extension tool
instead - not a canvas.

## Rendering tier - decide first

| Tier | Use when | How |
| --- | --- | --- |
| **Static HTML string** | Read-only or near-static content; no inputs to protect | The runtime's vanilla scaffold (`extensions_manage scaffold kind:canvas`). |
| **Preact + htm + this kit** | Anything interactive: inputs, live updates, lists, forms, shared state | This kit. **Default choice for real canvases.** |

For the static tier, use the vanilla scaffold as generated and keep the HTML in
its single extension module. Do not copy `canvas-kit/` into that extension. Move
to a generated Preact template as soon as the canvas needs inputs, shared state,
agent actions, or live updates. A one-file interactive counter is not the upgrade
path because it duplicates action logic and keeps state per panel.

The single most important reason to use the kit: **Preact diffs the DOM**, so a
live state push from the agent does **not** clobber focus, caret position, or
half-typed text in an input. The `innerHTML = ...` pattern most early canvases
use repaints the whole tree and loses keystrokes on every push. Don't do that.

## The model (read this before coding)

```text
extension.mjs   ── the ONLY file that imports the Copilot SDK (thin adapter; also wires host AI)
canvas.mjs      ── your canvas: id, schema, state load/save, action handlers (SDK-free)
canvas-kit/     ── the template's feature-scoped kit (do not edit)
web/index.html  ── shell: loads /kit/theme.css and ./app.mjs
web/app.mjs     ── your Preact view
```

- **State is shared and durable.** It's keyed by a *domain id* resolved from the
  open input (`resolveDomainId`), **not** by `instanceId` - open the same domain
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
  document - GitHub is both the store and the access control. Wire it as
  `loadState`/`saveState`, and add `syncState: () => store.poll()` +
  `syncIntervalMs` so the runtime polls for other people's edits (cheap ETag `304`
  when unchanged) and adopts them live - but only while a panel is being viewed.
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
- **Loopback origin guards & optional capability.** Every panel server checks
  `Host`, `Origin`, `Sec-Fetch-Site` (allowing initial `GET` HTML `iframe`/`document`
  navigation from the host while rejecting cross-site data, action, and subresource
  requests), `X-Content-Type-Options: nosniff`, and `Content-Type: application/json`
  on `POST /action`. Set `requireCapability: true` in the canvas config for private
  plans or reports so `/state`, `/events`, and `/action` also require a per-panel
  capability token; preserve that URL's query string and never publish or persist
  it as evidence.
- **`server.mjs` is SDK-free** so the whole runtime is testable with plain Node
  HTTP (see `test/http.test.mjs`). Keep SDK calls in `extension.mjs` only.

### Two kinds of state in the view - keep them separate

- **Shared domain state** arrives via SSE and is re-rendered on every push. Treat
  it as read-only in the view; change it only by calling `invoke(action, input)`.
- **Local UI state** (a draft input value, the active tab/filter) lives in
  `useState` and must never be pushed to the server until the user commits it.

### Action results & errors - how failures surface

Both callers (agent and UI) hit the same handler, and the runtime wraps every
invocation in the same envelope, so model failures deliberately:

- **Return** a small plain object for success (`{ id, status }`, `{ count }`).
  `POST /action` answers `{ ok: true, result }`.
- **Throw** for a hard failure (bad input, missing id). The runtime answers
  `{ ok: false, code, message }` - HTTP **400** for a known kit error (e.g. an
  unknown action) and **500** for a handler `throw` - and `mountCanvas`'s
  `invoke` **rejects** with a `CanvasActionError` carrying that `code`/`message`,
  so a button handler can `try/catch` it. On the agent side, `extension.mjs` maps
  the same error to a `CanvasError`. A throw is *surfaced*, never a crash.
- For an **expected, transient** failure (a flaky upstream fetch on a background
  poll), don't throw - capture it into `state.error` and **return** so the error
  card shows while the poll stays quiet (see the data template's `refresh`).

### Input & state are schema-validated at the boundary

An action's `inputSchema` is **enforced by the runtime**, not just declared: a
payload that violates it (wrong type, missing required field, out-of-enum value,
or an unexpected property under `additionalProperties: false`) is rejected with
an `invalid_input` error (**HTTP 400**) *before* your handler runs - from the
agent side too. So `inputSchema` is your typed contract; write it precisely and
your handler only sees well-shaped input. **Business rules still live in the
handler** (a schema-valid but empty `"   "` title reaches the handler, which
throws → 500). Open input is validated against `config.inputSchema` the same way.

Optionally set `config.stateSchema` (same JSON-Schema subset, `kit/validate.mjs`)
to guard the **durable shape**: if a handler produces state that violates it, the
mutation is rolled back and the action fails loud (500) instead of persisting
corrupt state. It's opt-in - omit it and any state shape is allowed.

## Icons - official GitHub Lucide, always

The kit vendors the **exact Lucide set github-app ships** (`lucide-react@1.23.0`,
byte-identical). Use it for *every* icon; do not hand-write SVGs or pull a CDN.

```js
import { Icon } from "/kit/icons.mjs";
html`<${Icon} name="circle-check" size=${16} />`
```

Contract: names are **kebab-case** (`circle-check`, `trash-2`, `list-todo`).
`viewBox` is fixed `0 0 24 24`, `stroke-width` is `2` - **never** pass
`strokeWidth`. Use sizes `12 · 14 · 16 · 20 · 24 · 32`. Match github-app's own
glyph choices when there's an obvious mapping (e.g. open=`circle-dot`,
done=`circle-check`, bookmark=`bookmark`). `iconNames()` / `hasIcon(name)` are
available if you need to validate.

## Theme - Primer tokens, with fallbacks

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

- `ck-spinner` - spin animation; pair with a Lucide loader, e.g.
  `html\`<\${Icon} name="loader-circle" class="ck-spinner" />\``.
- `ck-skeleton` - shimmering placeholder block for content that's still loading.
- `ck-callout` / `ck-callout ck-error` - an inline notice / error surface for a
  failed fetch, e.g. `html\`<div class="ck-callout ck-error"><\${Icon} name="circle-x" size=\${16} /><span>\${state.error}</span></div>\``.

**Motion safety is global.** `theme.css` already ships a
`@media (prefers-reduced-motion: reduce)` guard that neutralizes *all* animations
and transitions (kit spinners/skeletons and any you add). You do **not** repeat
it per canvas - but do keep motion decorative, never the only signal.

## View API - hooks, helpers, fragments

`/kit/client.mjs` re-exports the full vendored Preact hook set, not just
`useState`: `useEffect`, `useRef`, `useMemo`, `useCallback`, `useReducer`,
`useContext`, `useLayoutEffect`, `useImperativeHandle`. Call hooks
unconditionally at the top of a component - **before** any early `return`
(e.g. the `if (!state) return …` loading branch comes after your hooks).

It also exports formatting + id helpers so you stop reinventing them:

```js
import { nid, relativeTime, compactNumber, percent } from "/kit/client.mjs";
nid();                       // "lq3k9f2a" - short unique id
relativeTime(iso);           // "5m ago" / "3h ago" / "2d ago" / a date
compactNumber(2_300_000);    // "2.3M"
percent(1.25);               // "+1.25%"
```

`nid` is also importable server-side in `canvas.mjs` via
`import { nid } from "./canvas-kit/format.mjs"` (the generator does this).

**The formatters are locale-aware** - `relativeTime` ends in a
`toLocaleDateString()`, and `compactNumber`/`percent` go through
`Number.prototype.toLocaleString`, so their output depends on the host locale
(`"1.5K"` vs `"1,5 K"`, `2025-01-31` vs `31/01/2025`). Keep the **raw** values in
durable state (an ISO string, a `Number`) and format **in the view**. Never store
a formatted string and never parse one back - formatting is a presentation
concern, and a value formatted under one locale can't be reliably re-read under
another.

**`Fragment` is NOT exported.** To return sibling nodes without a wrapper, use
htm's built-in empty-tag syntax - `` html`<><${A} /><${B} /></>` `` - or just
return an array of vnodes. Don't `import { Fragment }`; it isn't there.

## External-data canvases - fetch + auto-refresh

Most real canvases aren't user-entered CRUD lists; they pull from the network and
refresh. The shape:

1. **`fetch()` lives in the action handler (or a helper it calls), never in the
   view.** Use the kit's **`safeFetch`** - it SSRF-guards the URL and applies a
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
   rejects loopback, link-local (incl. cloud metadata), and private ranges -
   including every address the hostname resolves to - then fetches with an
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
   backgrounded canvas stops hitting the network) and returns a cleanup function -
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

## Workflow

1. **Stamp it** (one working canvas, kit already nested, a smoke test included):
   ```sh
   node scripts/new-canvas.mjs <name> --dir <target> --title "Display Name"
   ```
   Target `.github/extensions/<name>` for an in-repo extension (committed, shared
   with the team), `$COPILOT_HOME/extensions/<name>` for a personal one (local to
   you), or `$COPILOT_HOME/session-state/<sessionId>/extensions/<name>` for a
   throwaway canvas scoped to just the current session - it's discovered like the
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
   wire the same verb to a button - one handler, two callers.

If you prefer to hand-assemble instead of using the generator: copy `kit/` into
your extension as `canvas-kit/`, then copy `reference/decision-log/extension.mjs`
verbatim and adapt `canvas.mjs` + `web/` from the reference.

## Keeping your vendored kit in sync

A generated extension vendors only the canonical files and icons required by its
built-in template. `canvas-kit/.kit-features.json` records that exact selection.
Older extensions without the manifest remain full-kit consumers. The kit version is still exported by `kit/version.mjs`, `/kit/core-client.mjs`,
and the backward-compatible full-kit `/kit/client.mjs` barrel.

- **Re-sync after a kit change.** Bump `KIT_VERSION` when you change any kit file,
  then refresh each vendored copy:
  ```sh
  node scripts/sync-kit.mjs <extension-dir>
  ```
  For a generated scoped kit, this regenerates the files and icon names recorded
  in `.kit-features.json`, overwrites changes, and prunes stale files. For an
  older extension without that manifest, it preserves compatibility by writing
  the complete kit. Both paths record the version in
  `<extension-dir>/canvas-kit/.kit-version.json`.

- **Gate drift in CI (offline).** Fail the build if any vendored kit has drifted
  from `kit/` - by file set, by file contents, or by recorded version:
  ```sh
  node scripts/check-kit-freshness.mjs <extensions-dir>
  ```
  Point it at a folder of extensions (e.g. `.github/extensions`), a single
  extension dir, or a `canvas-kit/` dir. Exit 0 = all fresh; exit 1 = drift, with
  the offending files listed. It runs no network and needs no dependencies.

Both `.kit-version.json` and `.kit-features.json` are metadata, not canonical kit
files. The feature manifest is deterministic and fully lists the selected
canonical files and icons.

To reduce an older full-kit canvas, regenerate the matching built-in template
and port the app-specific `canvas.mjs` and `web/` changes into it. Do not create a
feature manifest by hand because a missing dependency could make the extension
fail only at runtime.

- **Re-vendor the Lucide glyphs (rare).** `kit/vendor/lucide.mjs` is
  AUTO-GENERATED to match the exact `lucide-react` release the Copilot host app
  ships, so canvases render the same glyphs the host does. When the host bumps its
  Lucide version, regenerate the file deterministically rather than hand-editing:
  ```sh
  node scripts/vendor-lucide.mjs <version>
  ```
  Then bump `KIT_VERSION` and re-sync vendored copies. Pass `--icons-dir <path>`
  to vendor from an existing install instead of fetching one.

## References

- `reference/decision-log/` - complete working canvas (`canvas-kit/` nested) demonstrating shared state, `ctx.ai` / `ctx.askAgent` host-model actions, and `ghapp://` deep-link builders.
- `reference/deeplinks.md` - deep-link routes, parameter validation, and webview link handling.
- `kit/` - canonical source of truth synced into extensions via `scripts/sync-kit.mjs`.

## Safety

- Keep `@github/copilot-sdk` imports in `extension.mjs` only; `canvas.mjs` and `web/app.mjs` must stay SDK-free.
- Fetch external URLs only inside `canvas.mjs` action handlers using `safeFetch` (SSRF guard + timeout), never from `web/app.mjs`, and render fetched text via Preact rather than `innerHTML`.
- When `requireCapability: true` is set, preserve the panel URL query string in memory only; never log, persist, or publish capability tokens.
- Pass `open_canvas` an `instanceId` matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (`<=128` chars, alphanumeric start). Malformed handles fail with `Invalid canvas instance ID`.
- Never call external model APIs with keys or spawn `client.createSession()` from an extension; use `ctx.ai(...)` for silent generation and `ctx.askAgent(...)` from interactive UI actions only (`askAgent` is rejected on agent-side `invokeFromAgent` calls).
- Never hand-build `ghapp://` URLs or omit `target="_blank"`; always use the kit deep-link builders (`buildSessionDeepLink`, etc.) with `target="_blank"`.

## Exit Criteria

1. Run `npm test` in the skill repo (and `node test/smoke.test.mjs` inside the stamped canvas folder) to verify HTTP routes, SSE pushes, action schemas, SSRF/origin guards, and kit freshness.
2. Open the canvas in Playwright or the browser canvas, verify key controls render, and capture visual confirmation.
3. Drive the same action from both the UI and the agent, confirming live SSE updates without losing input focus.
