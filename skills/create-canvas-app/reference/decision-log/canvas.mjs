// canvas.mjs — Decision Log canvas definition (kit config; SDK-free).
//
// A shared decision log: the agent and the user read/write the SAME state
// through the SAME action handlers. State is durable per-user and keyed by a
// "domain" resolved from the open input (defaults to "default").

import { fileURLToPath } from "node:url";
import { userStore } from "./canvas-kit/storage.mjs";
import { nid } from "./canvas-kit/format.mjs";
import { isRepoFullName } from "./canvas-kit/deeplinks.mjs";

const EXT_NAME = "decision-log";

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
    repo: null,
    summary: "",
    summaryAt: null,
    summaryError: null,
    agentError: null,
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
        const now = new Date().toISOString();
        const d = {
          id: nid(),
          title,
          note: input.note ? String(input.note) : "",
          status: STATUSES.includes(input.status) ? input.status : "open",
          createdAt: now,
          updatedAt: now,
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
        const now = new Date().toISOString();
        const decisions = state.decisions.map((d) => {
          if (d.id !== input.id) return d;
          found = true;
          return {
            ...d,
            status: input.status,
            decidedAt: input.status === "decided" ? now : d.decidedAt,
            updatedAt: now,
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
        const now = new Date().toISOString();
        const decisions = state.decisions.map((d) => {
          if (d.id !== input.id) return d;
          found = true;
          return { ...d, note: input.note ? String(input.note) : "", updatedAt: now };
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

    // ---- github-app integration (deep links) ---------------------------------
    // Set the project repo this log opens sessions in. The view builds a
    // `ghapp://session/new` deep link per decision (kit/deeplinks.mjs) and renders
    // it as a target="_blank" anchor; the canvas webview routes the click into the
    // app's confirmation-gated deeplink pipeline. Repo is validated the SAME way
    // github-app validates it (isRepoFullName), so a stored value always yields a
    // link the app will accept. Both the agent and the user set it through here.
    set_repo: {
      description:
        "Set (or clear) the project repo (owner/repo) that this decision log opens " +
        "github-app sessions in. Pass an empty string to clear it.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "GitHub repo as owner/repo, or empty to clear." },
        },
        required: ["repo"],
        additionalProperties: false,
      },
      handler: ({ state, set, input }) => {
        const raw = String(input.repo ?? "").trim();
        if (raw === "") {
          set({ ...state, repo: null });
          return { repo: null, status: "Cleared project repo" };
        }
        if (!isRepoFullName(raw)) {
          throw new Error(`Invalid repo "${raw}". Expected owner/repo.`);
        }
        set({ ...state, repo: raw });
        return { repo: raw, status: `Project repo set to ${raw}` };
      },
    },

    // ---- host-model actions --------------------------------------------------
    // The two capabilities below reach the COPILOT APP'S OWN model — the same
    // model + auth the app is already running — with no API keys and no external
    // fetch. They arrive on the handler context (`ai` / `askAgent`), wired once in
    // extension.mjs (the only SDK file). Both are guarded: outside the Copilot
    // host they throw, so each handler CAPTURES the failure into shared state and
    // returns a result instead of throwing, letting the panel degrade gracefully.

    summarize: {
      description:
        "Summarize the log with the host AI model (silent — not added to chat history) and store the result on the canvas.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      // `ai(question) -> Promise<string>` is the SILENT host-model call: no tools,
      // not added to the conversation. It runs against the ambient conversation
      // context, so the prompt is framed as a self-contained function with a
      // pinned output shape to keep the live chat from bleeding into the answer.
      handler: async ({ state, set, ai }) => {
        if (!state.decisions.length) {
          set({ ...state, summary: "", summaryAt: new Date().toISOString(), summaryError: null });
          return { summary: "", count: 0 };
        }
        const log = state.decisions
          .map((d) => `- [${d.status}] ${d.title}${d.note ? ` — ${d.note}` : ""}`)
          .join("\n");
        try {
          const summary = (await ai(
            `You are summarizing a shared decision log for a software team. From the ` +
            `entries below, write a 1–2 sentence plain-text summary that highlights what ` +
            `is still open and the recommended next step. Output ONLY the summary — no ` +
            `preamble, no markdown, no surrounding quotes.\n\nDecisions:\n${log}`
          )).trim();
          // Functional set() merges into the LATEST state — a concurrent action
          // (add/remove) may have run while the model call was in flight.
          set((current) => ({
            ...current,
            summary,
            summaryAt: new Date().toISOString(),
            summaryError: null,
          }));
          return { summary, count: state.decisions.length };
        } catch (err) {
          // ai() throws (e.g. "ai_unavailable") when the canvas runs outside the
          // Copilot host. Capture it so the panel shows a friendly message, and
          // return (don't throw) so an agent-side call still gets a clean result.
          const summaryError = String(err?.message ?? err);
          set((current) => ({ ...current, summaryError }));
          return { ok: false, error: summaryError };
        }
      },
    },

    hand_to_agent: {
      description:
        "Hand a decision to the MAIN agent (visible in chat, tool-capable) to act on or research it. Use for follow-up work, not silent text.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The decision to hand off." } },
        required: ["id"],
        additionalProperties: false,
      },
      // `askAgent(prompt)` hands a prompt to the MAIN agent in the user's chat —
      // VISIBLE and TOOL-CAPABLE. Use it for "act in the repo / drive the agent"
      // controls; use `ai` (above) for silent canvas-internal generation.
      handler: async ({ state, set, input, askAgent }) => {
        const decision = state.decisions.find((d) => d.id === input.id);
        if (!decision) throw new Error(`No decision with id ${input.id}`);
        const prompt =
          `From a decision log, please act on this decision (research it, draft an ` +
          `approach, or implement it as appropriate):\n\n` +
          `Title: ${decision.title}\nStatus: ${decision.status}` +
          (decision.note ? `\nNote: ${decision.note}` : "");
        try {
          await askAgent(prompt);
          const now = new Date().toISOString();
          // Write-back into the item so the UI can reflect that it was handed off.
          set((current) => ({
            ...current,
            agentError: null,
            decisions: current.decisions.map((d) =>
              d.id === input.id ? { ...d, handedToAgentAt: now, updatedAt: now } : d
            ),
          }));
          return { ok: true, status: `Handed “${decision.title}” to the agent` };
        } catch (err) {
          const agentError = String(err?.message ?? err);
          set((current) => ({ ...current, agentError }));
          return { ok: false, error: agentError };
        }
      },
    },
  },
};
