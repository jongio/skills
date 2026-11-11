import { fileURLToPath } from "node:url";
import { actorFor } from "./host.mjs";

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
    await canvasConfig.authorizeOpen?.(args?.instanceId, args?.input, args?.ctx);
    const out = await origOpen(args);
    const inst = runtime._instances?.get?.(args?.instanceId);
    if (inst?.server && !inst._fleetCloseBound) {
      inst._fleetCloseBound = true;
      inst.server.once("close", () => {
        void canvasConfig.onCloseInstance?.(args.instanceId);
      });
    }
    const changed = await canvasConfig.onOpenInstance?.(args?.instanceId, args?.input, args?.ctx);
    if (changed && inst?.domainId) {
      await runtime.invoke("get_status", {}, { domainId: inst.domainId, instanceId: args?.instanceId, source: "ui" });
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
  const operatorDomainId = `${sessionId}:operator`;
  const openPanels = new Set();
  const trustedPanels = new Set();
  const isTrustedOpener = (ctx) => {
    try {
      return actorFor(ctx || {}, sessionId).primary === true;
    } catch {
      return false;
    }
  };
  const requireOperatorUi = (ctx) => {
    if (
      ctx?.source !== "ui" ||
      ctx?.domainId !== operatorDomainId ||
      !ctx?.instanceId ||
      !trustedPanels.has(ctx.instanceId)
    ) {
      throw new Error("Fleet operator actions are restricted to capability-authenticated UI clients opened by the primary session");
    }
  };
  const composeSnapshot = (domainId) => {
    const snapshot = service.snapshot();
    if (fleetService && domainId === operatorDomainId) {
      snapshot.activeScope = activeScope;
      snapshot.fleet = fleetService.snapshot();
    }
    return snapshot;
  };

  const actions = {
    get_status: {
      description: "Read this session's board without changing tasks.",
      inputSchema: emptyInput,
      handler: ({ set, ctx }) => {
        const domainSnapshot = composeSnapshot(ctx?.domainId);
        set(domainSnapshot);
        // Agent callers and untrusted panels receive strictly current-session state, never cross-session fleet snapshots.
        return ctx?.source === "ui" && ctx?.domainId === operatorDomainId ? domainSnapshot : service.snapshot();
      },
    },
    refresh: {
      description: "Refresh canonical plan/tasks and request current owned references; never mutates tasks.",
      inputSchema: emptyInput,
      handler: async ({ set, ctx }) => {
        await service.refresh();
        await refreshTracking();
        if (fleetService && ctx?.source === "ui" && ctx?.domainId === operatorDomainId && activeScope !== "session") {
          await fleetService.refreshFleet();
        }
        const domainSnapshot = composeSnapshot(ctx?.domainId);
        set(domainSnapshot);
        return { revision: domainSnapshot.revision, source: domainSnapshot.source };
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
        requireOperatorUi(ctx);
        activeScope = input.scope;
        if (input.scope === "session") {
          await fleetService.clearAllViewers();
        } else {
          const viewerKey = ctx?.instanceId;
          openPanels.add(viewerKey);
          for (const panelId of openPanels) {
            if (trustedPanels.has(panelId)) {
              await fleetService.setViewerActive(panelId, true);
            }
          }
        }
        const snapshot = composeSnapshot(operatorDomainId);
        set(snapshot);
        return { scope: activeScope, fleetRevision: snapshot.fleet?.revision ?? 0 };
      },
    };
    actions.refresh_fleet = {
      description: "Refresh cross-session and project rollup state on demand.",
      inputSchema: emptyInput,
      handler: async ({ set, ctx }) => {
        requireOperatorUi(ctx);
        if (activeScope === "session") {
          throw new Error("Switch to Projects & sessions or Attention inbox before refreshing fleet state");
        }
        await fleetService.refreshFleet();
        const snapshot = composeSnapshot(operatorDomainId);
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
      handler: async ({ input, set, ctx }) => {
        requireOperatorUi(ctx);
        const detail = await fleetService.selectSession(input.targetSessionId);
        set(composeSnapshot(operatorDomainId));
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
      handler: async ({ input, set, ctx }) => {
        requireOperatorUi(ctx);
        const result = await fleetService.answerInput(input);
        set(composeSnapshot(operatorDomainId));
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
      handler: async ({ input, set, ctx }) => {
        requireOperatorUi(ctx);
        const result = await fleetService.respondPlan(input);
        set(composeSnapshot(operatorDomainId));
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
      handler: async ({ input, set, ctx }) => {
        requireOperatorUi(ctx);
        const result = await fleetService.sendMessage(input);
        set(composeSnapshot(operatorDomainId));
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
      handler: async ({ input, set, ctx }) => {
        requireOperatorUi(ctx);
        const result = await fleetService.setRecoveryPolicy(input.policy);
        set(composeSnapshot(operatorDomainId));
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
      handler: async ({ input, set, ctx }) => {
        requireOperatorUi(ctx);
        const result = await fleetService.triggerRecovery(input);
        set(composeSnapshot(operatorDomainId));
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
    authorizeOpen: (instanceId, input, ctx) => {
      if (!fleetService) return;
      const requested = input?.scope;
      if (requested === "fleet" || requested === "projects" || requested === "inbox") {
        const actor = actorFor(ctx || {}, sessionId);
        if (!actor.primary) {
          throw new Error("Only the primary session agent may open fleet-scoped views");
        }
      }
      if (instanceId) {
        if (isTrustedOpener(ctx)) trustedPanels.add(instanceId);
        else trustedPanels.delete(instanceId);
      }
    },
    onOpenInstance: async (instanceId, input, ctx) => {
      if (!fleetService) return false;
      const trusted = instanceId ? trustedPanels.has(instanceId) : isTrustedOpener(ctx);
      if (!trusted) {
        if (instanceId) {
          openPanels.delete(instanceId);
          await fleetService.setViewerActive(instanceId, false);
        }
        if (openPanels.size === 0 || !fleetService.isPolling()) activeScope = "session";
        return false;
      }
      if (instanceId) openPanels.add(instanceId);
      const requested = input?.scope;
      if (requested === "fleet" || requested === "projects" || requested === "inbox") {
        activeScope = requested === "inbox" ? "inbox" : "projects";
        for (const panelId of openPanels) {
          if (trustedPanels.has(panelId)) {
            await fleetService.setViewerActive(panelId, true);
          }
        }
        return true;
      }
      const hadFleetScope = activeScope !== "session" || fleetService.isPolling();
      activeScope = "session";
      await fleetService.clearAllViewers();
      return hadFleetScope;
    },
    onCloseInstance: async (instanceId) => {
      if (!fleetService) return;
      if (instanceId) {
        openPanels.delete(instanceId);
        trustedPanels.delete(instanceId);
      }
      await fleetService.setViewerActive(instanceId, false);
      if (openPanels.size === 0 || !fleetService.isPolling()) activeScope = "session";
    },
    onShutdown: async () => {
      if (!fleetService) return;
      openPanels.clear();
      trustedPanels.clear();
      await fleetService.shutdown();
    },
    resolveDomainId: (_input, ctx) => {
      if (ctx?.sessionId && ctx.sessionId !== sessionId) throw new Error("Cross-session canvas rejected");
      return fleetService && isTrustedOpener(ctx) ? operatorDomainId : sessionId;
    },
    createInitialState: (ctx) => composeSnapshot(fleetService && isTrustedOpener(ctx) ? operatorDomainId : sessionId),
    statusLine: (_ctx, state) => `${state.metrics?.done || 0}/${state.metrics?.total || 0} tasks`,
    actions,
  };
}
