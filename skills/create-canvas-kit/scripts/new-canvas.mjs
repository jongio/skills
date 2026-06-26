// scripts/new-canvas.mjs — stamp a new, working canvas extension from the kit.
//
// Copies the canonical kit/ into <target>/canvas-kit/ and writes a minimal but
// fully working canvas (one shared list, Preact + htm view, Lucide icons, SSE
// live state, durable per-user storage). Edit from there.
//
// Usage:
//   node scripts/new-canvas.mjs <name> [--dir <path>] [--title "Display Name"]
//                                       [--description "..."] [--force]
//
// Examples:
//   node scripts/new-canvas.mjs my-notes
//   node scripts/new-canvas.mjs release-board --dir .github/extensions/release-board \
//        --title "Release Board" --description "Track release readiness items."

import { cp, mkdir, readdir, writeFile, stat } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KIT = join(ROOT, "kit");

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

await joinSession({ canvases: [canvas] });
`;

const CANVAS_MJS = `// canvas.mjs — {{title}} canvas definition (kit config; SDK-free).
//
// Shared state: the agent and the user read/write the SAME state through the
// SAME action handlers. State is durable per-user and keyed by a "domain"
// resolved from the open input (defaults to "default").

import { fileURLToPath } from "node:url";
import { userStore } from "./canvas-kit/storage.mjs";

const EXT_NAME = "{{name}}";

function nid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function fileFor(domainId) {
  const safe = String(domainId).replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return userStore(EXT_NAME, \`\${safe}.json\`);
}

export const canvasConfig = {
  id: "{{name}}",
  displayName: "{{title}}",
  description: "{{description}}",
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

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{title}}</title>
    <link rel="stylesheet" href="/kit/theme.css" />
  </head>
  <body>
    <div id="app"><p class="ck-muted">Loading…</p></div>
    <script type="module" src="./app.mjs"></script>
  </body>
</html>
`;

const APP_MJS = `// web/app.mjs — Preact view for the {{title}} canvas.
//
// SHARED state arrives over /events (SSE); the agent mutates the same data.
// LOCAL UI state (the draft input) lives in useState. Because Preact DIFFS the
// DOM (no innerHTML repaint), live pushes never clobber what you're typing.

import { html, mountCanvas, useState, Icon } from "/kit/client.mjs";

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
          <h1 style="margin:0">{{title}}</h1>
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

const MANIFEST = `{
  "name": "{{name}}",
  "version": 1
}
`;

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
      "Usage: node scripts/new-canvas.mjs <name> [--dir <path>] [--title \"...\"] [--description \"...\"] [--force]\n" +
        "  <name> must be kebab-case: start with a letter, then lowercase letters, digits, or hyphens."
    );
    process.exit(1);
  }

  const title = args.title || toTitle(name);
  const description = args.description || `${title} — a canvas built on the Canvas Kit.`;
  const target = args.dir ? (isAbsolute(args.dir) ? args.dir : resolve(process.cwd(), args.dir)) : resolve(process.cwd(), name);

  if (!args.force && (await isNonEmptyDir(target))) {
    console.error(`Refusing to write: ${target} already exists and is not empty (use --force).`);
    process.exit(1);
  }

  const vars = { name, title, description };

  await mkdir(join(target, "web"), { recursive: true });
  await cp(KIT, join(target, "canvas-kit"), { recursive: true });

  await writeFile(join(target, "extension.mjs"), EXTENSION_MJS);
  await writeFile(join(target, "canvas.mjs"), tpl(CANVAS_MJS, vars));
  await writeFile(join(target, "copilot-extension.json"), tpl(MANIFEST, vars));
  await writeFile(join(target, "web", "index.html"), tpl(INDEX_HTML, vars));
  await writeFile(join(target, "web", "app.mjs"), tpl(APP_MJS, vars));

  console.log(`Created canvas "${name}" at: ${target}`);
  console.log("Files:");
  for (const f of ["extension.mjs", "canvas.mjs", "copilot-extension.json", "web/index.html", "web/app.mjs", "canvas-kit/"]) {
    console.log("  " + f);
  }
  console.log("\nNext: install it (copy the folder into .github/extensions/ or $COPILOT_HOME/extensions/), then extensions_reload.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
