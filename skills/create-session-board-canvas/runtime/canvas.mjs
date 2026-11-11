import { fileURLToPath } from "node:url";

const emptyInput = { type: "object", properties: {}, additionalProperties: false };
const openInputSchema = {
  type: "object",
  properties: {
    scope: { type: "string", enum: ["session", "fleet", "projects", "inbox"] },
  },
  additionalProperties: false,
};

export function attachCanvasLifecycle(runtime, canvasConfig = runtime?.config) {
  if (!runtime || !canvasConfig) return runtime;
  const origOpen = runtime.openInstance.bind(runtime);
  const origClose = runtime.closeInstance.bind(runtime);
  const origShutdown = runtime.shutdown.bind(runtime);

  runtime.openInstance = async (args) => {
    const out = await origOpen(args);
    const inst = runtime._instances?.get?.(args?.instanceId);
    if (inst?.server && !inst._fleetCloseBound) {
      inst._fleetCloseBound = true;
      inst.server.once("close", () => {
        void canvasConfig.onCloseInstance?.(args.instanceId);
      });
    }
    const changed = await canvasConfig.onOpenInstance?.(args?.instanceId, args?.input);
    if (changed && inst?.domainId) {
      await runtime.invoke("get_status", {}, { domainId: inst.domainId });
    }
    return out;
  };

  runtime.closeInstance = async (instanceId) => {
    await canvasConfig.onCloseInstance?.(instanceId);
    return origClose(instanceId);
  };

  runtime.shutdown = async () => {
    await canvasConfig.onShutdown?.();
    return origShutdown();
  };

  return runtime;
}

export function createProgressCanvas(service, sessionId, { refreshTracking = async () => {}, fleetService = null } = {}) {
  let activeScope = "session";
  const composeSnapshot = () => {
    const snapshot = service.snapshot();
    if (fleetService) {
      snapshot.activeScope = activeScope;
      snapshot.fleet = fleetService.snapshot();
    }
    return snapshot;
  };

  const actions = {
    get_status: {
      description: "Read this session's board without changing tasks.",
      inputSchema: emptyInput,
      handler: ({ set }) => {
        const snapshot = composeSnapshot();
        set(snapshot);
        return snapshot;
      },
    },
    refresh: {
      description: "Refresh canonical plan/tasks and request current owned references; never mutates tasks.",
      inputSchema: emptyInput,
      handler: async ({ set }) => {
        await service.refresh();
        await refreshTracking();
        if (fleetService && activeScope !== "session") {
          await fleetService.refreshFleet();
        }
        const snapshot = composeSnapshot();
        set(snapshot);
        return { revision: snapshot.revision, source: snapshot.source };
      },
    },
  };

  if (fleetService) {
    actions.set_scope = {
      description: "Switch board view between current session, project fleet rollup, and operator attention inbox.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["session", "projects", "inbox"] },
          instanceId: { type: "string" },
        },
        required: ["scope"],
        additionalProperties: false,
      },
      handler: async ({ input, set, ctx }) => {
        activeScope = input.scope;
        const viewerKey = ctx?.instanceId || input.instanceId || "__default_panel__";
        await fleetService.setViewerActive(viewerKey, input.scope !== "session");
        const snapshot = composeSnapshot();
        set(snapshot);
        return { scope: activeScope, fleetRevision: snapshot.fleet?.revision ?? 0 };
      },
    };
    actions.refresh_fleet = {
      description: "Refresh cross-session and project rollup state on demand.",
      inputSchema: emptyInput,
      handler: async ({ set }) => {
        await fleetService.refreshFleet();
        const snapshot = composeSnapshot();
        set(snapshot);
        return { fleetRevision: snapshot.fleet?.revision ?? 0 };
      },
    };
    actions.select_session = {
      description: "Select or clear a session for drill-down inspection.",
      inputSchema: {
        type: "object",
        properties: {
          targetSessionId: { type: ["string", "null"] },
        },
        required: ["targetSessionId"],
        additionalProperties: false,
      },
      handler: async ({ input, set }) => {
        const detail = await fleetService.selectSession(input.targetSessionId);
        set(composeSnapshot());
        return { selectedSessionId: input.targetSessionId, found: Boolean(detail) };
      },
    };
    actions.answer_input = {
      description: "Answer a pending ask_user question for a target desktop session.",
      inputSchema: {
        type: "object",
        properties: {
          targetSessionId: { type: "string" },
          requestId: { type: "string" },
          answer: { type: "string" },
        },
        required: ["targetSessionId", "requestId", "answer"],
        additionalProperties: false,
      },
      handler: async ({ input, set }) => {
        const result = await fleetService.answerInput(input);
        set(composeSnapshot());
        return result;
      },
    };
    actions.respond_plan = {
      description: "Approve or reject a coordinated child session plan, or return a deep link for uncoordinated root sessions.",
      inputSchema: {
        type: "object",
        properties: {
          targetSessionId: { type: "string" },
          requestId: { type: "string" },
          approved: { type: "boolean" },
          feedback: { type: "string" },
          selectedAction: { type: "string", enum: ["interactive", "autopilot", "autopilot_fleet", "exit_only"] },
        },
        required: ["targetSessionId", "requestId", "approved"],
        additionalProperties: false,
      },
      handler: async ({ input, set }) => {
        const result = await fleetService.respondPlan(input);
        set(composeSnapshot());
        return result;
      },
    };
    actions.send_message = {
      description: "Send an immediate steer or enqueued message to a desktop session, waking dormant sessions if needed.",
      inputSchema: {
        type: "object",
        properties: {
          targetSessionId: { type: "string" },
          message: { type: "string" },
          deliveryMode: { type: "string", enum: ["immediate", "enqueue"] },
          mode: { type: "string", enum: ["plan", "interactive", "autopilot"] },
        },
        required: ["targetSessionId", "message"],
        additionalProperties: false,
      },
      handler: async ({ input, set }) => {
        const result = await fleetService.sendMessage(input);
        set(composeSnapshot());
        return result;
      },
    };
    actions.set_recovery_policy = {
      description: "Set automatic recovery watchdog policy (off, autopilot_only, or all_active).",
      inputSchema: {
        type: "object",
        properties: {
          policy: { type: "string", enum: ["off", "autopilot_only", "all_active"] },
        },
        required: ["policy"],
        additionalProperties: false,
      },
      handler: async ({ input, set }) => {
        const result = await fleetService.setRecoveryPolicy(input.policy);
        set(composeSnapshot());
        return result;
      },
    };
    actions.trigger_recovery = {
      description: "Manually send a state-verifying recovery wake message to an interrupted or stalled desktop session.",
      inputSchema: {
        type: "object",
        properties: {
          targetSessionId: { type: "string" },
        },
        required: ["targetSessionId"],
        additionalProperties: false,
      },
      handler: async ({ input, set }) => {
        const result = await fleetService.triggerRecovery(input);
        set(composeSnapshot());
        return result;
      },
    };
  }

  return {
    id: "session-progress",
    requireCapability: true,
    displayName: "Session Board Canvas",
    description: "Live session tasks, kanban, agents, blockers, delivery status, and opt-in cross-session project rollup.",
    assetsDir: fileURLToPath(new URL("./web/", import.meta.url)),
    inputSchema: openInputSchema,
    onOpenInstance: async (instanceId, input) => {
      if (!fleetService) return false;
      const requested = input?.scope;
      if (requested === "fleet" || requested === "projects" || requested === "inbox") {
        activeScope = requested === "inbox" ? "inbox" : "projects";
        await fleetService.setViewerActive(instanceId, true);
        return true;
      }
      if (!fleetService.isPolling() && activeScope !== "session") {
        activeScope = "session";
        return true;
      }
      return false;
    },
    onCloseInstance: async (instanceId) => {
      if (!fleetService) return;
      await fleetService.setViewerActive(instanceId, false);
      if (!fleetService.isPolling()) activeScope = "session";
    },
    onShutdown: async () => {
      if (!fleetService) return;
      await fleetService.shutdown();
    },
    resolveDomainId: (_input, ctx) => {
      if (ctx?.sessionId && ctx.sessionId !== sessionId) throw new Error("Cross-session canvas rejected");
      return sessionId;
    },
    createInitialState: () => composeSnapshot(),
    statusLine: (_ctx, state) => `${state.metrics?.done || 0}/${state.metrics?.total || 0} tasks`,
    actions,
  };
}
