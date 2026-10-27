import { createCanvas, joinSession, CanvasError } from "@github/copilot-sdk/extension";
import { join } from "node:path";
import { createProgressService, isOperatorEvent } from "./progress.mjs";
import { createProgressCanvas } from "./canvas.mjs";
import { createCanvasRuntime } from "./canvas-kit/server.mjs";
import { workspaceStore, sessionStore } from "./canvas-kit/storage.mjs";
import { validate } from "./canvas-kit/validate.mjs";
import { actorFor, createProgressEventGate, progressInputSchema, readSessionSources } from "./host.mjs";
import { acquireProvider } from "./provider.mjs";
import { trackingResult } from "./references.mjs";

// One SDK connection is required: disconnect/rejoin loses canvas callbacks on
// the supported host. An OS-owned session lease prevents duplicate loaders.
const lease = await acquireProvider(process.env.SESSION_ID);

if (lease) {
  let service;
  let runtime;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const checkSession = (ctx, session) => {
    if (ctx.sessionId !== session.sessionId) throw new CanvasError("wrong_session", "Cross-session canvas rejected");
  };
  const canvas = createCanvas({
    id: "session-progress",
    displayName: "Session Board Canvas",
    description: "Live session kanban, team, blockers, and delivery status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    actions: ["get_status", "refresh"].map((name) => ({
      name, description: name === "refresh" ? "Refresh canonical session sources" : "Read session progress",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        await ready;
        checkSession(ctx, session);
        return runtime.invokeFromAgent(name, ctx.input, ctx);
      },
    })),
    open: async (ctx) => {
      await ready;
      checkSession(ctx, session);
      return runtime.openInstance({ instanceId: ctx.instanceId, input: ctx.input, ctx });
    },
    onClose: async (ctx) => { await ready; await runtime.closeInstance(ctx.instanceId); },
  });
  const session = await joinSession({
    hooks: {
      onPostToolUse: async (input, invocation) => {
        const delta = trackingResult(input);
        if (!delta || invocation.sessionId !== process.env.SESSION_ID) return;
        try {
          await ready;
          await service.syncTracking(delta);
        } catch (error) {
          await session.log(`Session board tracking sync unavailable: ${String(error.message).slice(0, 300)}`).catch(() => {});
        }
      },
    },
    canvases: [canvas],
    tools: [{
      name: "session_progress",
      description: "Current-session progress board. Primary configures goals/assignments/phases; primary and subagents report work/blockers/results. Never marks canonical tasks done.",
      parameters: progressInputSchema,
      handler: async (input, invocation) => {
        try {
          await ready;
          const errors = validate(progressInputSchema, input);
          if (errors.length) throw new Error(`Invalid progress input: ${errors.join("; ")}`);
          const result = await service.update(input, actorFor(invocation, session.sessionId));
          return JSON.stringify(result);
        } catch (error) {
          return { resultType: "failure", textResultForLlm: JSON.stringify({ error: String(error.message) }) };
        }
      },
    }],
  });
  let stopped = false;
  let refreshTimer;
  const handle = (event) => {
    if (stopped) return;
    if (event.type === "session.plan_changed" || event.type === "session.todos_changed" ||
        event.type === "session.resume" || event.type === "session.compaction_complete") {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => service.refresh().catch(() => {}), 100);
      refreshTimer.unref?.();
    } else {
      return service.observe(event).catch(() => {});
    }
  };
  const events = createProgressEventGate(handle);
  const unsubscribe = session.on((event) => {
    if (isOperatorEvent(event.type) || /^(subagent\.|session\.(?:plan_changed|todos_changed|resume|compaction_complete))/.test(event.type)) events.push(event);
  });
  const initializing = (async () => {
    const store = session.workspacePath
      ? workspaceStore(session.workspacePath, join("files", "session-progress", "board.json"))
      : sessionStore(session.sessionId, "session-progress", "board.json");
    service = await createProgressService({
      sessionId: session.sessionId, store, readSources: () => readSessionSources(session),
      onChange: async () => {
        if (runtime) await runtime.invoke("get_status", {}, { domainId: session.sessionId });
      },
    });
    runtime = createCanvasRuntime(createProgressCanvas(service, session.sessionId));
    await service.refresh();
    try {
      const history = await session.getEvents();
      for (const event of history.slice(-10000)) {
        if (event.type.startsWith("subagent.")) await service.observe(event);
      }
    } catch (error) {
      await session.log(`Session progress team history unavailable: ${String(error.message).slice(0, 300)}`);
    }
    await events.start();
  })();
  void initializing.then(resolveReady, rejectReady);
  try { await ready; }
  catch (error) { await lease.close(); throw error; }
  const stop = async () => {
    stopped = true;
    clearTimeout(refreshTimer);
    unsubscribe();
    await runtime.shutdown();
    await session.disconnect();
    await lease.close();
  };
  process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
  process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
} else {
  await joinSession({ tools: [] });
}
