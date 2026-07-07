// scripts/new-canvas.mjs — stamp a new, working canvas extension from the kit.
//
// Copies the canonical kit/ into <target>/canvas-kit/ and writes a minimal but
// fully working canvas plus a per-canvas smoke test. Three templates:
//
//   list (default)  one shared list (add/toggle/remove), Preact + htm, SSE live
//                   state, durable per-user storage. Edit from there.
//   data            an EXTERNAL-DATA canvas: fetch-in-handler (with a timeout),
//                   a `refresh` action, captured error state, and visibility-
//                   gated auto-refresh via the kit's pollWhileVisible helper.
//   ai              a HOST-AI canvas: calls the Copilot app's own model from an
//                   action with `ctx.ai(...)` (silent, no keys, no history) and
//                   hands prompts to the main agent with `ctx.askAgent(...)`.
//                   Model errors are captured into state and surfaced in the panel.
//
// Usage:
//   node scripts/new-canvas.mjs <name> [--dir <path>] [--title "Display Name"]
//                                       [--description "..."] [--template list|data|ai]
//                                       [--force]
//
// Examples:
//   node scripts/new-canvas.mjs my-notes
//   node scripts/new-canvas.mjs market-feed --template data --title "Market Feed" \
//        --dir .github/extensions/market-feed

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { syncKit } from "./sync-kit.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") args.force = true;
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

function toTitle(name) {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const tpl = (s, vars) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// extension.mjs is identical for every canvas — the thin SDK adapter.
const EXTENSION_MJS = `// extension.mjs — the ONLY file that talks to the Copilot SDK.
// It adapts the SDK canvas lifecycle onto the SDK-free kit runtime so the
// runtime can also be booted and tested standalone. Keep behavior in canvas.mjs.

import { createCanvas, joinSession, CanvasError } from "@github/copilot-sdk/extension";
import { canvasConfig } from "./canvas.mjs";
import { createCanvasRuntime, CanvasKitError } from "./canvas-kit/server.mjs";

const runtime = createCanvasRuntime(canvasConfig);

function toCanvasError(err) {
  if (err instanceof CanvasError) return err;
  if (err instanceof CanvasKitError) return new CanvasError(err.code, err.message);
  return new CanvasError("action_failed", String(err?.message ?? err));
}

const canvas = createCanvas({
  id: canvasConfig.id,
  displayName: canvasConfig.displayName,
  description: canvasConfig.description,
  inputSchema: canvasConfig.inputSchema,
  actions: Object.entries(canvasConfig.actions).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: def.inputSchema,
    handler: async (ctx) => {
      try {
        return await runtime.invokeFromAgent(ctx.actionName, ctx.input, ctx);
      } catch (err) {
        throw toCanvasError(err);
      }
    },
  })),
  open: async (ctx) => {
    try {
      return await runtime.openInstance({ instanceId: ctx.instanceId, input: ctx.input, ctx });
    } catch (err) {
      throw toCanvasError(err);
    }
  },
  onClose: async (ctx) => {
    await runtime.closeInstance(ctx.instanceId);
  },
});

const session = await joinSession({ canvases: [canvas] });

// Give canvas action handlers access to the host's AI model via ctx.ai /
// ctx.askAgent. This is the ONLY place the SDK is touched; keep canvas.mjs
// SDK-free and just call ctx.ai(...) / ctx.askAgent(...) from a handler.
runtime.setHost({
  // ctx.ai(question) -> Promise<string>: a silent, no-tools model query that is
  // NOT added to the conversation. It runs against the ambient conversation
  // context, so write self-contained prompts ("You are X. Output ONLY ...").
  ai: async (question) => {
    const { answer } = await session.rpc.ui.ephemeralQuery({ question: String(question) });
    return answer ?? "";
  },
  // ctx.askAgent(prompt): hand a prompt to the MAIN agent (visible in chat,
  // tool-capable). Use for "act in the repo" requests, not silent generation.
  askAgent: async (prompt) => session.send({ prompt: String(prompt) }),
});
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{titleHtml}}</title>
    <link rel="stylesheet" href="/kit/theme.css" />
  </head>
  <body>
    <div id="app"><p class="ck-muted">Loading…</p></div>
    <script type="module" src="./app.mjs"></script>
  </body>
</html>
`;

const MANIFEST = `{
  "name": "{{name}}",
  "version": 1
}
`;

// Per-canvas README — stamped for every generated canvas (all templates) so the
// folder is self-documenting once copied into an extensions dir.
const README_MD = `# {{titleText}}

{{descriptionText}}

A GitHub Copilot App **canvas extension** generated with the \`create-canvas-app\`
skill ({{templateLabel}} template). The agent and the user share the same live
state through the same action handlers; the view renders with Preact + htm and a
vendored kit — no build step, no \`package.json\`.

## Layout

\`\`\`
extension.mjs   the ONLY file that imports the Copilot SDK (thin adapter)
canvas.mjs      canvas config: state load/save + action handlers (SDK-free)
canvas-kit/     vendored kit (copied verbatim; do not edit)
web/index.html  shell that loads /kit/theme.css and ./app.mjs
web/app.mjs     your Preact view
test/smoke.test.mjs  boots the runtime over HTTP and exercises the actions
\`\`\`

{{templateNote}}

## Validate

\`\`\`
node test/smoke.test.mjs
\`\`\`

## Install

Copy this folder into \`.github/extensions/{{name}}\` (in-repo),
\`$COPILOT_HOME/extensions/{{name}}\` (personal), or
\`$COPILOT_HOME/session-state/<sessionId>/extensions/{{name}}\` (current session
only — disappears with the session), then run \`extensions_reload\` and open it
with \`open_canvas\` (\`canvasId: "{{name}}"\`).

## Keeping the kit current

\`canvas-kit/\` is a vendored snapshot of the create-canvas-app \`kit/\`. Re-sync it
with the skill's \`scripts/sync-kit.mjs\`, and gate drift in CI with
\`scripts/check-kit-freshness.mjs\`.
`;

// Template-specific note injected into the stamped README.
const TEMPLATE_NOTES = {
  list: "This is a user-entered **list** canvas: add / toggle / remove items, " +
    "persisted per user and shared live across every open panel.",
  data: "This is an **external-data** canvas: it fetches from a source URL inside " +
    "an action handler (always with `AbortSignal.timeout`), captures failures into " +
    "state, and auto-refreshes on a visibility-gated timer via the kit's " +
    "`pollWhileVisible` helper.",
  ai: "This is a **host-AI** canvas: it calls the Copilot app's own model from an " +
    "action handler with `ctx.ai(...)` (silent, no API keys, not added to chat " +
    "history) and can hand a prompt to the main agent with `ctx.askAgent(...)`. " +
    "Model errors (e.g. running outside the Copilot host) are captured into state " +
    "and surfaced in the panel.",
};

// ---- template: list (default) ----------------------------------------------

const LIST_CANVAS_MJS = `// canvas.mjs — {{titleText}} canvas definition (kit config; SDK-free).
//
// Shared state: the agent and the user read/write the SAME state through the
// SAME action handlers. State is durable per-user and keyed by a "domain"
// resolved from the open input (defaults to "default").

import { fileURLToPath } from "node:url";
import { userStore } from "./canvas-kit/storage.mjs";
import { nid } from "./canvas-kit/format.mjs";

const EXT_NAME = "{{name}}";

function fileFor(domainId) {
  const safe = String(domainId).replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return userStore(EXT_NAME, \`\${safe}.json\`);
}

export const canvasConfig = {
  id: "{{name}}",
  displayName: {{titleJs}},
  description: {{descriptionJs}},
  assetsDir: fileURLToPath(new URL("./web/", import.meta.url)),

  inputSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Logical board to open. Omit for the default." },
    },
    additionalProperties: false,
  },

  resolveDomainId: (input) => (input?.domain ? String(input.domain) : "default"),
  createInitialState: () => ({ items: [] }),
  loadState: async (domainId) => fileFor(domainId).load(null),
  saveState: async (domainId, state) => fileFor(domainId).save(state),
  statusLine: (_ctx, state) => \`\${state.items.length} items\`,

  actions: {
    add_item: {
      description: "Add an item to the board.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "Item text." } },
        required: ["text"],
        additionalProperties: false,
      },
      handler: ({ state, set, input }) => {
        const text = String(input.text ?? "").trim();
        if (!text) throw new Error("text is required");
        const item = { id: nid(), text, done: false, createdAt: new Date().toISOString() };
        set({ ...state, items: [item, ...state.items] });
        return { id: item.id, status: \`Added "\${item.text}"\` };
      },
    },

    toggle_item: {
      description: "Toggle an item's done state.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      handler: ({ state, set, input }) => {
        let found = false;
        const items = state.items.map((i) => {
          if (i.id !== input.id) return i;
          found = true;
          return { ...i, done: !i.done };
        });
        if (!found) throw new Error(\`No item with id \${input.id}\`);
        set({ ...state, items });
        return { ok: true };
      },
    },

    remove_item: {
      description: "Delete an item from the board.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      handler: ({ state, set, input }) => {
        const items = state.items.filter((i) => i.id !== input.id);
        set({ ...state, items });
        return { removed: state.items.length - items.length };
      },
    },

    list_items: {
      description: "Return a text summary of the current items (for the agent).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: ({ state }) => {
        if (!state.items.length) return { summary: "No items yet.", count: 0 };
        const summary = state.items
          .map((i) => \`- [\${i.done ? "x" : " "}] \${i.text}\`)
          .join("\\n");
        return { count: state.items.length, summary };
      },
    },
  },
};
`;

const LIST_APP_MJS = `// web/app.mjs — Preact view for the {{titleText}} canvas.
//
// SHARED state arrives over /events (SSE); the agent mutates the same data.
// LOCAL UI state (the draft input) lives in useState. Because Preact DIFFS the
// DOM (no innerHTML repaint), live pushes never clobber what you're typing.

import { html, mountCanvas, useState, Icon } from "/kit/client.mjs";

const TITLE = {{titleJs}};

function NewItem({ invoke }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await invoke("add_item", { text: t });
      setText("");
    } finally {
      setBusy(false);
    }
  }

  return html\`
    <div class="ck-card ck-row" style="margin:12px 0 16px">
      <input
        class="ck-input ck-grow"
        placeholder="Add an item…"
        value=\${text}
        onInput=\${(e) => setText(e.target.value)}
        onKeyDown=\${(e) => { if (e.key === "Enter") add(); }}
      />
      <button class="ck-btn ck-btn-primary" disabled=\${!text.trim() || busy} onClick=\${add}>
        <\${Icon} name="plus" size=\${16} />Add
      </button>
    </div>
  \`;
}

function Item({ item, invoke }) {
  return html\`
    <div class="ck-card ck-spread">
      <button class="ck-btn ck-btn-sm" onClick=\${() => invoke("toggle_item", { id: item.id })}>
        <\${Icon} name=\${item.done ? "circle-check" : "circle"} size=\${16} />
        <span style=\${item.done ? "text-decoration:line-through;opacity:.6" : ""}>\${item.text}</span>
      </button>
      <button class="ck-btn ck-btn-sm ck-btn-danger" onClick=\${() => invoke("remove_item", { id: item.id })}>
        <\${Icon} name="trash-2" size=\${14} />
      </button>
    </div>
  \`;
}

function App({ state, invoke, connected }) {
  if (!state) return html\`<p class="ck-muted">Loading…</p>\`;
  const items = state.items ?? [];

  return html\`
    <div>
      <div class="ck-spread" style="margin-bottom:14px">
        <div class="ck-row" style="gap:8px">
          <\${Icon} name="layout-list" size=\${20} />
          <h1 style="margin:0">\${TITLE}</h1>
        </div>
        <span class="ck-status">
          <span class=\${\`ck-dot \${connected ? "ck-dot-live" : "ck-dot-off"}\`}></span>
          \${connected ? "live" : "reconnecting…"}
        </span>
      </div>

      <\${NewItem} invoke=\${invoke} />

      <div class="ck-col" style="gap:10px">
        \${items.length
          ? items.map((item) => html\`<\${Item} key=\${item.id} item=\${item} invoke=\${invoke} />\`)
          : html\`<div class="ck-empty"><\${Icon} name="inbox" size=\${20} />No items yet.</div>\`}
      </div>
    </div>
  \`;
}

mountCanvas({ view: (model) => html\`<\${App} ...\${model} />\` });
`;

// ---- template: data (external-data / auto-refresh) -------------------------

const DATA_CANVAS_MJS = `// canvas.mjs — {{titleText}} canvas definition (data template; kit config; SDK-free).
//
// An EXTERNAL-DATA canvas: it fetches from the network inside an action handler,
// captures any error into shared state, and is auto-refreshed by the view. The
// agent and the user share the same state and the same handlers.
//
// Where things live:
//   * fetch() goes in the HANDLER/helper here — NEVER in the view.
//   * always set a timeout (AbortSignal.timeout) so a slow upstream can't hang.
//   * the view polls a "refresh" action on a visibility-gated timer (app.mjs).

import { fileURLToPath } from "node:url";
import { userStore } from "./canvas-kit/storage.mjs";
import { nid } from "./canvas-kit/format.mjs";
import { safeFetch } from "./canvas-kit/net.mjs";

const EXT_NAME = "{{name}}";

// A stable, no-auth demo JSON API (returns an array). Swap for your real source
// and reshape mapItems() to match its payload.
const DEFAULT_SOURCE = "https://jsonplaceholder.typicode.com/posts?_limit=10";

function fileFor(domainId) {
  const safe = String(domainId).replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return userStore(EXT_NAME, \`\${safe}.json\`);
}

async function fetchItems(url) {
  // This runs server-side on the loopback runtime, so a caller-set \`url\` would
  // otherwise be an unrestricted fetch. The kit's safeFetch() blocks
  // private/loopback/link-local targets BEFORE connecting (SSRF guard) and
  // applies a hard timeout so a slow upstream can't hang the panel. A determined
  // attacker could still DNS-rebind between the check and the fetch; for a local
  // dev tool pointed at a source you trust this is adequate defense-in-depth. The
  // response still flows back to the agent, so render fetched fields as TEXT,
  // never innerHTML.
  const res = await safeFetch(url, {
    headers: { Accept: "application/json", "User-Agent": "copilot-canvas" },
  });
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  return mapItems(await res.json());
}

// Reshape the upstream payload into this canvas's item shape. Edit for your API.
function mapItems(data) {
  const rows = Array.isArray(data) ? data : data?.items ?? [];
  return rows.slice(0, 50).map((row, i) => ({
    id: String(row.id ?? nid()),
    title: String(row.title ?? row.name ?? \`Item \${i + 1}\`),
    note: String(row.body ?? row.description ?? "").slice(0, 280),
  }));
}

export const canvasConfig = {
  id: "{{name}}",
  displayName: {{titleJs}},
  description: {{descriptionJs}},
  assetsDir: fileURLToPath(new URL("./web/", import.meta.url)),

  inputSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Logical board to open. Omit for the default." },
    },
    additionalProperties: false,
  },

  resolveDomainId: (input) => (input?.domain ? String(input.domain) : "default"),
  createInitialState: () => ({
    items: [],
    error: null,
    lastRefresh: null,
    autoRefreshSec: 60,
    sourceUrl: DEFAULT_SOURCE,
  }),
  loadState: async (domainId) => fileFor(domainId).load(null),
  saveState: async (domainId, state) => fileFor(domainId).save(state),
  statusLine: (_ctx, state) => \`\${state.items.length} items\`,

  actions: {
    refresh: {
      description: "Fetch the latest items from the source URL and update the canvas.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async ({ state, set }) => {
        // Capture the input BEFORE awaiting; use a functional set() afterward so
        // we merge into the LATEST state (a concurrent action may have run while
        // the fetch was in flight) and drop the response if the source changed.
        const sourceUrl = state.sourceUrl;
        try {
          const items = await fetchItems(sourceUrl);
          set((current) => {
            if (current.sourceUrl !== sourceUrl) return current; // stale response
            return {
              ...current,
              items,
              error: items.length ? null : "No items returned.",
              lastRefresh: new Date().toISOString(),
            };
          });
          return { count: items.length, summary: \`Loaded \${items.length} item(s).\` };
        } catch (err) {
          // Capture the failure into shared state so the view can surface it,
          // and still return a result (don't throw) so a poll tick stays quiet.
          const error = \`Couldn't load: \${String(err?.message ?? err)}\`;
          set((current) =>
            current.sourceUrl !== sourceUrl ? current : { ...current, error, lastRefresh: new Date().toISOString() }
          );
          return { ok: false, error };
        }
      },
    },

    set_source: {
      description: "Change the upstream source URL.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "JSON endpoint returning a list." } },
        required: ["url"],
        additionalProperties: false,
      },
      handler: ({ state, set, input }) => {
        const url = String(input.url ?? "").trim();
        if (!url) throw new Error("url is required");
        set({ ...state, sourceUrl: url });
        return { sourceUrl: url };
      },
    },

    set_auto_refresh: {
      description: "Set the auto-refresh interval in seconds (0 turns it off).",
      inputSchema: {
        type: "object",
        properties: { seconds: { type: "number", description: "Interval in seconds; 0 disables." } },
        required: ["seconds"],
        additionalProperties: false,
      },
      handler: ({ state, set, input }) => {
        const seconds = Math.max(0, Number(input.seconds) || 0);
        set({ ...state, autoRefreshSec: seconds });
        return { autoRefreshSec: seconds };
      },
    },

    clear: {
      description: "Remove all loaded items.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: ({ state, set }) => {
        set({ ...state, items: [], error: null });
        return { ok: true };
      },
    },

    list_items: {
      description: "Return a text summary of the current items (for the agent).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: ({ state }) => {
        if (!state.items.length) return { summary: "No items loaded.", count: 0 };
        const summary = state.items.map((i) => \`- \${i.title}\`).join("\\n");
        return { count: state.items.length, summary };
      },
    },
  },
};
`;

const DATA_APP_MJS = `// web/app.mjs — Preact view for the {{titleText}} data canvas.
//
// EXTERNAL-DATA shape: items arrive over /events (SSE) like any shared state;
// the network fetch lives in the "refresh" action handler, not here. The view
// only TRIGGERS refresh — on a button and on a visibility-gated timer via the
// kit's pollWhileVisible helper, with the interval bound to durable state.

import { html, mountCanvas, useState, useEffect, useRef, Icon, pollWhileVisible, relativeTime } from "/kit/client.mjs";

const TITLE = {{titleJs}};

const INTERVALS = [
  { v: 0, label: "Off" },
  { v: 30, label: "30s" },
  { v: 60, label: "1m" },
  { v: 300, label: "5m" },
];

function Toolbar({ state, invoke }) {
  const [url, setUrl] = useState(state.sourceUrl ?? "");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  // Reflect an agent-driven source change back into the field, but never clobber
  // what the user is mid-edit — only resync the draft when the input isn't focused.
  useEffect(() => {
    if (inputRef.current && document.activeElement === inputRef.current) return;
    setUrl(state.sourceUrl ?? "");
  }, [state.sourceUrl]);

  async function refresh() {
    if (busy) return;
    setBusy(true);
    try { await invoke("refresh"); } finally { setBusy(false); }
  }
  async function applySource() {
    const u = url.trim();
    if (!u) return;
    await invoke("set_source", { url: u });
    refresh();
  }

  return html\`
    <div class="ck-card ck-col" style="margin:12px 0 16px">
      <div class="ck-row">
        <input
          ref=\${inputRef}
          class="ck-input ck-grow"
          placeholder="Source URL…"
          value=\${url}
          onInput=\${(e) => setUrl(e.target.value)}
          onKeyDown=\${(e) => { if (e.key === "Enter") applySource(); }}
        />
        <button class="ck-btn" onClick=\${applySource}>Set</button>
      </div>
      <div class="ck-row">
        <button class="ck-btn ck-btn-primary" disabled=\${busy} onClick=\${refresh}>
          <\${Icon} name=\${busy ? "loader-circle" : "refresh-cw"} size=\${16} class=\${busy ? "ck-spinner" : ""} />
          \${busy ? "Refreshing…" : "Refresh"}
        </button>
        <span class="ck-grow"></span>
        <label class="ck-caption">Auto</label>
        <select
          class="ck-select"
          style="width:auto"
          value=\${String(state.autoRefreshSec ?? 0)}
          onChange=\${(e) => invoke("set_auto_refresh", { seconds: Number(e.target.value) })}
        >
          \${INTERVALS.map((o) => html\`<option value=\${String(o.v)}>\${o.label}</option>\`)}
        </select>
      </div>
    </div>
  \`;
}

function App({ state, invoke, connected }) {
  // Hooks run unconditionally (before any early return). Two effects:
  //   1) initial load once state arrives and nothing has been fetched yet;
  //   2) visibility-gated auto-refresh, rebuilt when the interval changes.
  useEffect(() => {
    if (state && !state.lastRefresh) invoke("refresh").catch(() => {});
  }, [state?.lastRefresh]);
  useEffect(
    () => pollWhileVisible(() => invoke("refresh"), state?.autoRefreshSec || 0),
    [state?.autoRefreshSec]
  );

  if (!state) return html\`<p class="ck-muted">Loading…</p>\`;
  const items = state.items ?? [];

  return html\`
    <div>
      <div class="ck-spread" style="margin-bottom:14px">
        <div class="ck-row" style="gap:8px">
          <\${Icon} name="rss" size=\${20} />
          <h1 style="margin:0">\${TITLE}</h1>
        </div>
        <span class="ck-status">
          <span class=\${\`ck-dot \${connected ? "ck-dot-live" : "ck-dot-off"}\`}></span>
          \${connected ? "live" : "reconnecting…"}
        </span>
      </div>

      <\${Toolbar} state=\${state} invoke=\${invoke} />

      \${state.error
        ? html\`<div class="ck-callout ck-error" style="margin-bottom:12px">
            <\${Icon} name="circle-x" size=\${16} /><span>\${state.error}</span>
          </div>\`
        : null}

      <div class="ck-spread ck-caption" style="margin-bottom:8px">
        <span>\${items.length} item\${items.length === 1 ? "" : "s"}</span>
        <span>\${state.lastRefresh ? \`updated \${relativeTime(state.lastRefresh)}\` : "not loaded yet"}</span>
      </div>

      <div class="ck-col" style="gap:10px">
        \${items.length
          ? items.map((it) => html\`
              <div class="ck-card" key=\${it.id}>
                <div style="font-weight:var(--ck-fw-semibold)">\${it.title}</div>
                \${it.note ? html\`<div class="ck-muted" style="margin-top:6px">\${it.note}</div>\` : null}
              </div>\`)
          : html\`<div class="ck-empty"><\${Icon} name="inbox" size=\${20} />Nothing loaded yet. Hit Refresh.</div>\`}
      </div>
    </div>
  \`;
}

mountCanvas({ view: (model) => html\`<\${App} ...\${model} />\` });
`;

// ---- template: ai (host model / agent handoff) -----------------------------

const AI_CANVAS_MJS = `// canvas.mjs — {{titleText}} canvas definition (ai template; kit config; SDK-free).
//
// A HOST-AI canvas: action handlers call the COPILOT APP'S OWN model — the same
// model + auth the app is already running — with no API keys, no model picker,
// and no external fetch. Two capabilities arrive on the handler context,
// wired once in extension.mjs (the only SDK file) and exposed by the kit:
//
//   * ctx.ai(question) -> Promise<string>  a SILENT, no-tools model query that is
//       NOT added to the conversation. Use it for canvas-internal generation
//       (summarize / suggest / rewrite / classify). It runs against the ambient
//       conversation context, so frame prompts as self-contained functions and
//       pin the output shape ("Output ONLY ...").
//   * ctx.askAgent(prompt) -> Promise<unknown>  hand a prompt to the MAIN agent
//       in the user's chat. It is VISIBLE in chat and TOOL-CAPABLE — use it for
//       "act in the repo / drive the agent" controls, not silent text.
//
// ctx.ai() / ctx.askAgent() throw when the canvas runs OUTSIDE the Copilot host
// (e.g. a standalone smoke test); this canvas captures that into state.error so
// the panel degrades gracefully instead of dead-ending on a thrown action.

import { fileURLToPath } from "node:url";
import { userStore } from "./canvas-kit/storage.mjs";
import { nid } from "./canvas-kit/format.mjs";

const EXT_NAME = "{{name}}";

function fileFor(domainId) {
  const safe = String(domainId).replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return userStore(EXT_NAME, \`\${safe}.json\`);
}

export const canvasConfig = {
  id: "{{name}}",
  displayName: {{titleJs}},
  description: {{descriptionJs}},
  assetsDir: fileURLToPath(new URL("./web/", import.meta.url)),

  inputSchema: {
    type: "object",
    properties: {
      domain: { type: "string", description: "Logical board to open. Omit for the default." },
    },
    additionalProperties: false,
  },

  resolveDomainId: (input) => (input?.domain ? String(input.domain) : "default"),
  createInitialState: () => ({ entries: [], error: null }),
  loadState: async (domainId) => fileFor(domainId).load(null),
  saveState: async (domainId, state) => fileFor(domainId).save(state),
  statusLine: (_ctx, state) => \`\${state.entries.length} entries\`,

  actions: {
    ask_ai: {
      description: "Ask the host AI model a question silently (no tools, not added to chat history) and record the answer.",
      inputSchema: {
        type: "object",
        properties: { prompt: { type: "string", description: "What to ask the model." } },
        required: ["prompt"],
        additionalProperties: false,
      },
      // The "ai" capability destructured off the handler context is the silent
      // host-model call. Frame the prompt as a self-contained function so the live
      // chat can't bleed into the answer, and pin the output shape.
      handler: async ({ set, input, ai }) => {
        const prompt = String(input.prompt ?? "").trim();
        if (!prompt) throw new Error("prompt is required");
        try {
          const answer = (await ai(
            \`You are a concise assistant embedded in a side-panel canvas. \` +
            \`Answer the request directly in plain text. Output ONLY the answer — \` +
            \`no preamble, no markdown headings, no surrounding quotes. Request: \${prompt}\`
          )).trim();
          const entry = { id: nid(), kind: "ai", prompt, answer, createdAt: new Date().toISOString() };
          // Functional set() merges into the LATEST state — a concurrent action
          // may have run while the model call was in flight.
          set((current) => ({ ...current, error: null, entries: [entry, ...current.entries] }));
          return { id: entry.id, answer };
        } catch (err) {
          // ai() throws "ai_unavailable" outside the Copilot host. Capture it into
          // shared state so the panel shows a friendly message, and return (don't
          // throw) so an agent-side call still gets a clean result.
          const error = String(err?.message ?? err);
          set((current) => ({ ...current, error }));
          return { ok: false, error };
        }
      },
    },

    hand_to_agent: {
      description: "Hand a prompt to the MAIN agent (visible in chat, tool-capable). Use for 'act in the repo' requests, not silent generation.",
      inputSchema: {
        type: "object",
        properties: { prompt: { type: "string", description: "Instruction for the main agent." } },
        required: ["prompt"],
        additionalProperties: false,
      },
      handler: async ({ set, input, askAgent }) => {
        const prompt = String(input.prompt ?? "").trim();
        if (!prompt) throw new Error("prompt is required");
        try {
          await askAgent(prompt);
          const entry = {
            id: nid(),
            kind: "agent",
            prompt,
            answer: "Handed to the agent — watch the conversation.",
            createdAt: new Date().toISOString(),
          };
          set((current) => ({ ...current, error: null, entries: [entry, ...current.entries] }));
          return { id: entry.id, ok: true };
        } catch (err) {
          const error = String(err?.message ?? err);
          set((current) => ({ ...current, error }));
          return { ok: false, error };
        }
      },
    },

    remove_entry: {
      description: "Delete an entry from the log.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      handler: ({ state, set, input }) => {
        const entries = state.entries.filter((e) => e.id !== input.id);
        set({ ...state, entries });
        return { removed: state.entries.length - entries.length };
      },
    },

    clear: {
      description: "Clear the whole log.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: ({ state, set }) => {
        set({ ...state, entries: [], error: null });
        return { ok: true };
      },
    },

    list_entries: {
      description: "Return a text summary of the log (for the agent).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: ({ state }) => {
        if (!state.entries.length) return { summary: "No entries yet.", count: 0 };
        const summary = state.entries
          .map((e) => \`- (\${e.kind}) \${e.prompt} -> \${e.answer}\`)
          .join("\\n");
        return { count: state.entries.length, summary };
      },
    },
  },
};
`;

const AI_APP_MJS = `// web/app.mjs — Preact view for the {{titleText}} ai canvas.
//
// The MODEL call never happens here — it lives in the "ask_ai" / "hand_to_agent"
// action handlers (canvas.mjs), which reach the host model. The view only
// TRIGGERS those actions and renders the shared log that arrives over /events.
// LOCAL UI state (the draft prompt, the busy flag) lives in useState.

import { html, mountCanvas, useState, Icon } from "/kit/client.mjs";

const TITLE = {{titleJs}};

function Composer({ invoke }) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(null); // "ai" | "agent" | null

  async function run(action) {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(action === "ask_ai" ? "ai" : "agent");
    try {
      await invoke(action, { prompt: p });
      setPrompt("");
    } finally {
      setBusy(null);
    }
  }

  return html\`
    <div class="ck-card ck-col" style="margin:12px 0 16px">
      <textarea
        class="ck-textarea"
        placeholder="Ask the model anything…"
        value=\${prompt}
        onInput=\${(e) => setPrompt(e.target.value)}
        onKeyDown=\${(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run("ask_ai"); }}
      ></textarea>
      <div class="ck-row">
        <button
          class="ck-btn ck-btn-primary"
          disabled=\${!prompt.trim() || !!busy}
          onClick=\${() => run("ask_ai")}
        >
          <\${Icon} name=\${busy === "ai" ? "loader-circle" : "sparkles"} size=\${16} class=\${busy === "ai" ? "ck-spinner" : ""} />
          \${busy === "ai" ? "Asking…" : "Ask AI"}
        </button>
        <button
          class="ck-btn"
          disabled=\${!prompt.trim() || !!busy}
          onClick=\${() => run("hand_to_agent")}
        >
          <\${Icon} name=\${busy === "agent" ? "loader-circle" : "send"} size=\${16} class=\${busy === "agent" ? "ck-spinner" : ""} />
          \${busy === "agent" ? "Sending…" : "Hand to agent"}
        </button>
      </div>
      <span class="ck-caption">Cmd/Ctrl + Enter asks the AI silently. "Hand to agent" drives the main chat.</span>
    </div>
  \`;
}

function Entry({ entry, invoke }) {
  const isAgent = entry.kind === "agent";
  return html\`
    <div class="ck-card ck-col" style="gap:8px">
      <div class="ck-spread">
        <span class=\${\`ck-badge \${isAgent ? "ck-badge-accent" : "ck-badge-success"}\`}>
          <\${Icon} name=\${isAgent ? "send" : "sparkles"} size=\${12} />
          \${isAgent ? "agent" : "ai"}
        </span>
        <button class="ck-btn ck-btn-sm ck-btn-danger" onClick=\${() => invoke("remove_entry", { id: entry.id })}>
          <\${Icon} name="trash-2" size=\${14} />
        </button>
      </div>
      <div style="font-weight:var(--ck-fw-semibold)">\${entry.prompt}</div>
      <div class="ck-muted" style="white-space:pre-wrap">\${entry.answer}</div>
    </div>
  \`;
}

function App({ state, invoke, connected }) {
  if (!state) return html\`<p class="ck-muted">Loading…</p>\`;
  const entries = state.entries ?? [];

  return html\`
    <div>
      <div class="ck-spread" style="margin-bottom:14px">
        <div class="ck-row" style="gap:8px">
          <\${Icon} name="wand-sparkles" size=\${20} />
          <h1 style="margin:0">\${TITLE}</h1>
        </div>
        <span class="ck-status">
          <span class=\${\`ck-dot \${connected ? "ck-dot-live" : "ck-dot-off"}\`}></span>
          \${connected ? "live" : "reconnecting…"}
        </span>
      </div>

      <\${Composer} invoke=\${invoke} />

      \${state.error
        ? html\`<div class="ck-callout ck-error" style="margin-bottom:12px">
            <\${Icon} name="circle-x" size=\${16} /><span>\${state.error}</span>
          </div>\`
        : null}

      <div class="ck-spread ck-caption" style="margin-bottom:8px">
        <span>\${entries.length} entr\${entries.length === 1 ? "y" : "ies"}</span>
        \${entries.length ? html\`<button class="ck-btn ck-btn-sm" onClick=\${() => invoke("clear")}>Clear</button>\` : null}
      </div>

      <div class="ck-col" style="gap:10px">
        \${entries.length
          ? entries.map((e) => html\`<\${Entry} key=\${e.id} entry=\${e} invoke=\${invoke} />\`)
          : html\`<div class="ck-empty"><\${Icon} name="messages-square" size=\${20} />Ask the model to get started.</div>\`}
      </div>
    </div>
  \`;
}

mountCanvas({ view: (model) => html\`<\${App} ...\${model} />\` });
`;

// ---- per-canvas smoke test -------------------------------------------------

// Wrap template-specific test calls in a shared harness that boots the runtime
// over real HTTP against an isolated temp COPILOT_HOME.
function smokeFile(name, body) {
  return `// test/smoke.test.mjs — boots this canvas's runtime over HTTP and exercises
// its actions. Generated by create-canvas-app. Run:  node test/smoke.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "${name}-smoke-"));
process.env.COPILOT_HOME = home;

const { canvasConfig } = await import("../canvas.mjs");
const { createCanvasRuntime } = await import("../canvas-kit/server.mjs");
const runtime = createCanvasRuntime(canvasConfig);

let passed = 0;
async function test(label, fn) {
  try {
    await fn();
    passed++;
    console.log(\`  ok  \${label}\`);
  } catch (e) {
    console.error(\`FAIL  \${label}\\n      \${e.message}\`);
    process.exitCode = 1;
    throw e;
  }
}
const post = (url, actionName, input) =>
  fetch(new URL("/action", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionName, input }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
const getState = (url) => fetch(new URL("/state", url)).then((r) => r.json());

try {
  const open = await runtime.openInstance({
    instanceId: "smoke",
    input: {},
    ctx: { instanceId: "smoke", input: {} },
  });
  await test("opens on a loopback url", () =>
    assert.match(open.url, /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/$/));
${body}
} finally {
  await runtime.shutdown();
  await rm(home, { recursive: true, force: true });
}

console.log(\`\\n\${passed} checks passed\`);
`;
}

const LIST_SMOKE_BODY = `  await test("GET /state starts empty", async () => {
    const s = await getState(open.url);
    assert.deepEqual(s.items, []);
  });

  let id;
  await test("add_item adds an item", async () => {
    const { body } = await post(open.url, "add_item", { text: "first" });
    assert.equal(body.ok, true);
    id = body.result.id;
    assert.ok(id);
    const s = await getState(open.url);
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].text, "first");
  });

  await test("toggle_item flips done", async () => {
    await post(open.url, "toggle_item", { id });
    const s = await getState(open.url);
    assert.equal(s.items[0].done, true);
  });

  await test("list_items summarizes for the agent", async () => {
    const { body } = await post(open.url, "list_items", {});
    assert.equal(body.result.count, 1);
  });

  await test("remove_item removes it", async () => {
    const { body } = await post(open.url, "remove_item", { id });
    assert.equal(body.result.removed, 1);
    const s = await getState(open.url);
    assert.deepEqual(s.items, []);
  });`;

const DATA_SMOKE_BODY = `  await test("GET /state has the initial data shape", async () => {
    const s = await getState(open.url);
    assert.ok(Array.isArray(s.items));
    assert.equal(s.lastRefresh, null);
  });

  await test("set_source + set_auto_refresh mutate state", async () => {
    // Point at an unreachable local URL so refresh fails fast and offline —
    // the smoke test never touches the network.
    await post(open.url, "set_source", { url: "http://127.0.0.1:1/none" });
    await post(open.url, "set_auto_refresh", { seconds: 0 });
    const s = await getState(open.url);
    assert.equal(s.sourceUrl, "http://127.0.0.1:1/none");
    assert.equal(s.autoRefreshSec, 0);
  });

  await test("refresh records lastRefresh and captures the error (offline)", async () => {
    const { body } = await post(open.url, "refresh", {});
    assert.equal(body.ok, true); // POST envelope ok; the result carries the error
    const s = await getState(open.url);
    assert.ok(s.lastRefresh, "lastRefresh should be set after a refresh attempt");
    assert.ok(s.error, "the failed fetch should be captured in state.error");
  });

  await test("relativeTime formats the captured lastRefresh", async () => {
    const { relativeTime } = await import("../canvas-kit/format.mjs");
    const s = await getState(open.url);
    const rel = relativeTime(s.lastRefresh);
    assert.equal(typeof rel, "string");
    assert.ok(rel.length > 0, "relativeTime should format the lastRefresh timestamp");
  });

  await test("clear empties items and error", async () => {
    await post(open.url, "clear", {});
    const s = await getState(open.url);
    assert.deepEqual(s.items, []);
    assert.equal(s.error, null);
  });`;

const AI_SMOKE_BODY = `  await test("GET /state starts empty", async () => {
    const s = await getState(open.url);
    assert.deepEqual(s.entries, []);
    assert.equal(s.error, null);
  });

  await test("ask_ai with no host wired captures a friendly error (offline)", async () => {
    // No host is wired yet (a standalone smoke test never runs under the Copilot
    // app), so ai() throws "ai_unavailable" and the handler captures it to state.
    const { body } = await post(open.url, "ask_ai", { prompt: "hello" });
    assert.equal(body.ok, true); // POST envelope ok; the result carries the error
    assert.equal(body.result.ok, false);
    assert.match(body.result.error, /unavailable/i);
    const s = await getState(open.url);
    assert.ok(s.error, "ai_unavailable should be captured into state.error");
    assert.deepEqual(s.entries, [], "no entry is recorded when the model is unavailable");
  });

  // Wire a STUB host so the rest runs offline + deterministic. This mirrors what
  // extension.mjs does with the real Copilot model: ai -> ephemeralQuery (silent),
  // askAgent -> a main-conversation message.
  const sentToAgent = [];
  runtime.setHost({
    ai: async (q) => "ECHO:" + q,
    askAgent: async (p) => { sentToAgent.push(p); return "queued"; },
  });

  let aiId;
  await test("ask_ai records the model's answer once a host is wired", async () => {
    const { body } = await post(open.url, "ask_ai", { prompt: "ping" });
    aiId = body.result.id;
    assert.ok(aiId);
    assert.match(body.result.answer, /ECHO:/);
    const s = await getState(open.url);
    assert.equal(s.entries.length, 1);
    assert.equal(s.entries[0].kind, "ai");
    assert.equal(s.error, null, "a successful call clears the prior error");
  });

  await test("hand_to_agent forwards the prompt to the main agent", async () => {
    const { body } = await post(open.url, "hand_to_agent", { prompt: "do the thing" });
    assert.equal(body.result.ok, true);
    assert.deepEqual(sentToAgent, ["do the thing"]);
    const s = await getState(open.url);
    assert.equal(s.entries.length, 2);
    assert.equal(s.entries[0].kind, "agent");
  });

  await test("list_entries summarizes for the agent", async () => {
    const { body } = await post(open.url, "list_entries", {});
    assert.equal(body.result.count, 2);
  });

  await test("remove_entry + clear empty the log", async () => {
    await post(open.url, "remove_entry", { id: aiId });
    let s = await getState(open.url);
    assert.equal(s.entries.length, 1);
    await post(open.url, "clear", {});
    s = await getState(open.url);
    assert.deepEqual(s.entries, []);
    assert.equal(s.error, null);
  });`;

const TEMPLATES = {
  list: { canvas: LIST_CANVAS_MJS, app: LIST_APP_MJS, smokeBody: LIST_SMOKE_BODY },
  data: { canvas: DATA_CANVAS_MJS, app: DATA_APP_MJS, smokeBody: DATA_SMOKE_BODY },
  ai: { canvas: AI_CANVAS_MJS, app: AI_APP_MJS, smokeBody: AI_SMOKE_BODY },
};

async function isNonEmptyDir(dir) {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = args._[0];

  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error(
      "Usage: node scripts/new-canvas.mjs <name> [--dir <path>] [--title \"...\"] [--description \"...\"] [--template list|data|ai] [--force]\n" +
        "  <name> must be kebab-case: start with a letter, then lowercase letters, digits, or hyphens."
    );
    process.exit(1);
  }

  const template = args.template || "list";
  if (!TEMPLATES[template]) {
    console.error(`Unknown --template "${template}". Use "list" (default), "data", or "ai".`);
    process.exit(1);
  }

  const title = args.title || toTitle(name);
  const description = args.description || `${title} — a canvas built on the Canvas Kit.`;
  const target = args.dir ? (isAbsolute(args.dir) ? args.dir : resolve(process.cwd(), args.dir)) : resolve(process.cwd(), name);

  if (!args.force && (await isNonEmptyDir(target))) {
    console.error(`Refusing to write: ${target} already exists and is not empty (use --force).`);
    process.exit(1);
  }

  const vars = {
    name,
    titleJs: JSON.stringify(title),
    descriptionJs: JSON.stringify(description),
    titleHtml: htmlEscape(title),
    titleText: String(title).replace(/[`\r\n]/g, " "),
    descriptionText: String(description).replace(/[`\r\n]/g, " "),
    templateLabel: template,
    templateNote: TEMPLATE_NOTES[template],
  };
  const t = TEMPLATES[template];

  await mkdir(join(target, "web"), { recursive: true });
  await mkdir(join(target, "test"), { recursive: true });
  // Vendor the kit AND stamp .kit-version.json, so the generated canvas passes
  // scripts/check-kit-freshness.mjs out of the box.
  await syncKit(target);

  await writeFile(join(target, "extension.mjs"), EXTENSION_MJS);
  await writeFile(join(target, "canvas.mjs"), tpl(t.canvas, vars));
  await writeFile(join(target, "copilot-extension.json"), tpl(MANIFEST, vars));
  await writeFile(join(target, "README.md"), tpl(README_MD, vars));
  await writeFile(join(target, "web", "index.html"), tpl(INDEX_HTML, vars));
  await writeFile(join(target, "web", "app.mjs"), tpl(t.app, vars));
  await writeFile(join(target, "test", "smoke.test.mjs"), smokeFile(name, t.smokeBody));

  console.log(`Created ${template} canvas "${name}" at: ${target}`);
  console.log("Files:");
  for (const f of [
    "extension.mjs",
    "canvas.mjs",
    "copilot-extension.json",
    "README.md",
    "web/index.html",
    "web/app.mjs",
    "test/smoke.test.mjs",
    "canvas-kit/",
  ]) {
    console.log("  " + f);
  }
  console.log("\nValidate it:   node test/smoke.test.mjs   (run from the canvas folder)");
  console.log("Then install:  copy the folder into .github/extensions/ (in-repo), $COPILOT_HOME/extensions/ (personal), or $COPILOT_HOME/session-state/<sessionId>/extensions/ (this session only), then extensions_reload.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
