// canvas.mjs — Canvas Workspace App canvas definition (kit config; SDK-free).
//
// Shared state: the agent and the user read/write the SAME state through the
// SAME action handlers. State is durable per-user and keyed by a "domain"
// resolved from the open input (defaults to "default").

import { fileURLToPath } from "node:url";
import { userStore } from "./canvas-kit/storage.mjs";
import { nid } from "./canvas-kit/format.mjs";

const EXT_NAME = "canvas-app";

function fileFor(domainId) {
  const safe = String(domainId).replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return userStore(EXT_NAME, `${safe}.json`);
}

export const canvasConfig = {
  id: "canvas-app",
  displayName: "Canvas Workspace App",
  description: "Canvas Workspace App — a canvas built on the Canvas Kit.",
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
  statusLine: (_ctx, state) => `${state.items.length} items`,

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
        return { id: item.id, status: `Added "${item.text}"` };
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
        if (!found) throw new Error(`No item with id ${input.id}`);
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
          .map((i) => `- [${i.done ? "x" : " "}] ${i.text}`)
          .join("\n");
        return { count: state.items.length, summary };
      },
    },
  },
};
