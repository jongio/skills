import { createCanvas, joinSession, CanvasError } from "@github/copilot-sdk/extension";
import { homedir } from "node:os";
import { join } from "node:path";
import { createProgressService } from "./progress.mjs";
import { attachCanvasLifecycle, createProgressCanvas } from "./canvas.mjs";
import { createCanvasRuntime } from "./canvas-kit/server.mjs";
import { userStore, workspaceStore, sessionStore } from "./canvas-kit/storage.mjs";
import { validate } from "./canvas-kit/validate.mjs";
import { createFleetService } from "./fleet-service.mjs";
import { createFleetWorkerClient } from "./fleet-worker-client.mjs";
import { actorFor, createFeedbackGate, createProgressEventGate, isProgressEvent, progressInputSchema, readSessionSources } from "./host.mjs";
import { acquireProvider } from "./provider.mjs";
import { createTrackingSync, trackingChangeKind, trackingResult } from "./references.mjs";
import { acquireFleetLeader, createRecoveryWatchdog } from "./watchdog.mjs";

// One SDK connection is required: disconnect/rejoin loses canvas callbacks on
// the supported host. An OS-owned session lease prevents duplicate loaders.
const lease = await acquireProvider(process.env.SESSION_ID);

if (lease) {
  let service;
  let fleetService;
  let runtime;
  let tracking;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const checkSession = (ctx, session) => {
    if (ctx.sessionId !== session.sessionId) throw new CanvasError("wrong_session", "Cross-session canvas rejected");
  };
  const canvasInputSchema = {
    type: "object",
    properties: { scope: { type: "string", enum: ["session", "fleet", "projects", "inbox"] } },
    additionalProperties: false,
  };
  const canvas = createCanvas({
    id: "session-progress",
    displayName: "Session Board Canvas",
    description: "Live session kanban, team, blockers, delivery status, and opt-in cross-session project rollup.",
    inputSchema: canvasInputSchema,
    actions: ["get_status", "refresh"].map((name) => ({
      name,
      description: name === "refresh" ? "Refresh canonical session sources" : "Read session progress",
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
  const feedbackGate = createFeedbackGate();
  const session = await joinSession({
    hooks: {
      onPostToolUse: async (input, invocation) => {
        if (invocation.sessionId !== process.env.SESSION_ID) return;
        const delta = trackingResult(input);
        if (delta) {
          if (input.toolArgs?.action === "list" && tracking?.isReading(delta.kind)) return;
          try {
            await ready;
            if (delta.refreshAll) { await refreshTracking(); }
            else {
              const snapshot = service.syncTracking(delta, tracking.current(delta.kind || "all"));
              const pending = refreshTracking(delta.kind || "all");
              await Promise.all([snapshot, pending]);
            }
          } catch (error) {
            await logTrackingError(error);
          }
        }
        return feedbackGate.evaluateToolHook(input, invocation, process.env.SESSION_ID);
      },
      onPostToolUseFailure: async (input, invocation) => {
        if (invocation.sessionId !== process.env.SESSION_ID) return;
        return feedbackGate.evaluateToolHook(input, invocation, process.env.SESSION_ID);
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
          if (input.action === "refresh") {
            const pending = await refreshTracking();
            return JSON.stringify(pending);
          }
          return JSON.stringify(result);
        } catch (error) {
          return { resultType: "failure", textResultForLlm: JSON.stringify({ error: String(error.message) }) };
        }
      },
    }],
  });
  let stopped = false;
  let refreshTimer;
  async function logTrackingError(error) {
    try { await session.log(`Session board tracking sync unavailable: ${String(error.message).slice(0, 300)}`); }
    catch {}
  }
  function refreshTracking(kind = "all") {
    // Native callbacks wait only for the local barrier, never for a nested tool to finish.
    const pending = service.syncTracking({ ...(kind === "all" ? {} : { kind }), error: "Session tracking refresh pending" });
    void tracking.refresh(kind).catch(logTrackingError);
    return pending;
  }
  const handle = (event) => {
    if (stopped) return;
    const trackingKind = trackingChangeKind(event);
    if (trackingKind) return refreshTracking(trackingKind).catch(logTrackingError);
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
    feedbackGate.observe(event);
    if (isProgressEvent(event)) events.push(event);
  });
  const initializing = (async () => {
    const store = session.workspacePath
      ? workspaceStore(session.workspacePath, join("files", "session-progress", "board.json"))
      : sessionStore(session.sessionId, "session-progress", "board.json");
    service = await createProgressService({
      sessionId: session.sessionId, store, readSources: () => readSessionSources(session),
      onChange: async () => {
        if (runtime) {
          await Promise.all([
            runtime.invoke("get_status", {}, { domainId: session.sessionId }),
            runtime.invoke("get_status", {}, { domainId: `${session.sessionId}:operator` }),
          ]);
        }
      },
    });
    tracking = createTrackingSync(session, service);
    const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
    const workerClient = createFleetWorkerClient({ copilotHome });
    fleetService = createFleetService({
      hostSessionId: session.sessionId,
      executeHostTool: (name, args) => session.rpc.tools.execute({ name, arguments: args }),
      askHostAgent: (prompt) => session.send({ prompt }),
      workerClient,
      acquireLeader: () => acquireFleetLeader(copilotHome),
      createWatchdog: async ({ isLeader }) =>
        createRecoveryWatchdog({
          store: userStore("session-progress", "fleet-recovery.json"),
          isLeader,
          recoverSession: async ({ sessionId: targetId, prompt }) => {
            await session.rpc.tools.execute({
              name: "send_session_message",
              arguments: { session_id: targetId, message: prompt, delivery_mode: "immediate" },
            });
          },
        }),
      onChange: async () => {
        if (runtime) await runtime.invoke("get_status", {}, { domainId: `${session.sessionId}:operator` });
      },
    });
    const canvasConfig = createProgressCanvas(service, session.sessionId, {
      refreshTracking,
      fleetService,
    });
    runtime = attachCanvasLifecycle(createCanvasRuntime(canvasConfig), canvasConfig);
    runtime.setHost({ askAgent: (prompt) => session.send({ prompt }) });
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
