// canvas.mjs — Decision Log canvas definition (kit config; SDK-free).
//
// A shared decision log: the agent and the user read/write the SAME state
// through the SAME action handlers. State is durable per-user and keyed by a
// "domain" resolved from the open input (defaults to "default").

import { fileURLToPath } from "node:url";
import { userStore } from "./canvas-kit/storage.mjs";

const EXT_NAME = "decision-log";

function nid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function fileFor(domainId) {
  const safe = String(domainId).replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return userStore(EXT_NAME, `${safe}.json`);
}

const STATUSES = ["open", "decided", "parked"];

export const canvasConfig = {
  id: "decision-log",
  displayName: "Decision Log",
  description:
    "Track decisions for the current work as a shared open/decided/parked log. " +
    "Both the agent and the user can add decisions, change their status, and attach notes; " +
    "the canvas stays in sync live.",
  assetsDir: fileURLToPath(new URL("./web/", import.meta.url)),

  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        description: "Logical log to open (e.g. a feature or project name). Omit for the default log.",
      },
    },
    additionalProperties: false,
  },

  resolveDomainId: (input) => (input?.domain ? String(input.domain) : "default"),

  createInitialState: (ctx) => ({
    domain: ctx?.input?.domain ?? "default",
    decisions: [],
  }),

  loadState: async (domainId) => fileFor(domainId).load(null),
  saveState: async (domainId, state) => fileFor(domainId).save(state),

  statusLine: (_ctx, state) => {
    const open = state.decisions.filter((d) => d.status === "open").length;
    return `${state.decisions.length} decisions · ${open} open`;
  },

  actions: {
    add_decision: {
      description: "Add a decision to the log.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short statement of the decision or question." },
          note: { type: "string", description: "Optional context / rationale." },
          status: { type: "string", enum: STATUSES, description: "Initial status (default: open)." },
        },
        required: ["title"],
        additionalProperties: false,
      },
      handler: ({ state, set, input }) => {
        const title = String(input.title ?? "").trim();
        if (!title) throw new Error("title is required");
        const d = {
          id: nid(),
          title,
          note: input.note ? String(input.note) : "",
          status: STATUSES.includes(input.status) ? input.status : "open",
          createdAt: new Date().toISOString(),
        };
        set({ ...state, decisions: [d, ...state.decisions] });
        return { id: d.id, status: `Added “${d.title}”` };
      },
    },

    set_status: {
      description: "Change a decision's status (open, decided, parked).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: STATUSES },
        },
        required: ["id", "status"],
        additionalProperties: false,
      },
      handler: ({ state, set, input }) => {
        let found = false;
        const decisions = state.decisions.map((d) => {
          if (d.id !== input.id) return d;
          found = true;
          return {
            ...d,
            status: input.status,
            decidedAt: input.status === "decided" ? new Date().toISOString() : d.decidedAt,
          };
        });
        if (!found) throw new Error(`No decision with id ${input.id}`);
        set({ ...state, decisions });
        return { status: `#${input.id} → ${input.status}` };
      },
    },

    set_note: {
      description: "Set or replace the note on a decision.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, note: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      handler: ({ state, set, input }) => {
        let found = false;
        const decisions = state.decisions.map((d) => {
          if (d.id !== input.id) return d;
          found = true;
          return { ...d, note: input.note ? String(input.note) : "" };
        });
        if (!found) throw new Error(`No decision with id ${input.id}`);
        set({ ...state, decisions });
        return { ok: true };
      },
    },

    remove_decision: {
      description: "Delete a decision from the log.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      handler: ({ state, set, input }) => {
        const decisions = state.decisions.filter((d) => d.id !== input.id);
        set({ ...state, decisions });
        return { removed: state.decisions.length - decisions.length };
      },
    },

    list_decisions: {
      description: "Return a text summary of the current decisions (for the agent).",
      inputSchema: {
        type: "object",
        properties: { status: { type: "string", enum: STATUSES } },
        additionalProperties: false,
      },
      handler: ({ state, input }) => {
        const items = input.status
          ? state.decisions.filter((d) => d.status === input.status)
          : state.decisions;
        if (!items.length) return { summary: "No decisions logged.", count: 0 };
        const summary = items
          .map((d) => `- [${d.status}] ${d.title}${d.note ? ` — ${d.note}` : ""}`)
          .join("\n");
        return { count: items.length, summary };
      },
    },
  },
};
