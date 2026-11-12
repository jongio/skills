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
  let serverChain = Promise.resolve();
  const serializeServer = (work) => {
    const next = serverChain.catch(() => {}).then(work);
    serverChain = next;
    return next;
  };

  let seq = 0;
  let shutdownSeq = 0;
  const closedSeqByInstance = new Map();
  const activeOpenSeqByInstance = new Map();

  runtime.openInstance = async (args) => {
    const instanceId = args?.instanceId;
    const openSeq = ++seq;
    const isSupersededByCloseOrShutdown = () =>
      openSeq <= shutdownSeq || (Boolean(instanceId) && openSeq <= (closedSeqByInstance.get(instanceId) || 0));
    const isCurrentAttempt = () =>
      !isSupersededByCloseOrShutdown() &&
      (!instanceId || activeOpenSeqByInstance.get(instanceId) === openSeq);

    // Serialize server creation and capability rotation without holding the lock across slow fleet discovery RPCs.
    const serverSetup = await serializeServer(async () => {
      await canvasConfig.authorizeOpen?.(instanceId, args?.input, args?.ctx, { commitTrust: false });
      if (isSupersededByCloseOrShutdown()) {
        return { cancelled: true, out: { url: "", title: canvasConfig.displayName ?? "", status: undefined } };
      }
      if (instanceId && runtime._instances?.has?.(instanceId) && canvasConfig.didOpenerTrustChange?.(instanceId, args?.ctx)) {
        // Recreate the instance when opener trust changes so existing SSE streams disconnect and a fresh capability token is issued.
        await canvasConfig.onCloseInstance?.(instanceId);
        await origClose(instanceId);
      }
      if (isSupersededByCloseOrShutdown()) {
        return { cancelled: true, out: { url: "", title: canvasConfig.displayName ?? "", status: undefined } };
      }
      await canvasConfig.authorizeOpen?.(instanceId, args?.input, args?.ctx, { commitTrust: true });
      if (instanceId) activeOpenSeqByInstance.set(instanceId, openSeq);
      const out = await origOpen(args);
      if (isSupersededByCloseOrShutdown()) {
        if (instanceId) {
          if (activeOpenSeqByInstance.get(instanceId) === openSeq) activeOpenSeqByInstance.delete(instanceId);
          await canvasConfig.onCloseInstance?.(instanceId);
          await origClose(instanceId);
        }
        return { cancelled: true, out };
      }
      const inst = runtime._instances?.get?.(instanceId);
      if (inst) inst._openSeq = openSeq;
      if (inst?.server && !inst._fleetCloseBound) {
        inst._fleetCloseBound = true;
        const boundServer = inst.server;
        boundServer.once("close", () => {
          const live = runtime._instances?.get?.(instanceId);
          if (live?.server === boundServer) {
            if (activeOpenSeqByInstance.get(instanceId) === live._openSeq) {
              activeOpenSeqByInstance.delete(instanceId);
            }
            void canvasConfig.onCloseInstance?.(instanceId);
          }
        });
      }
      return { cancelled: false, out, domainId: inst?.domainId };
    });

    if (serverSetup.cancelled || !isCurrentAttempt()) {
      return serverSetup.out;
    }

    await canvasConfig.onOpenInstance?.(instanceId, args?.input, args?.ctx, { isCurrent: isCurrentAttempt });
    if (serverSetup.domainId && isCurrentAttempt()) {
      await runtime.invoke("get_status", {}, { domainId: serverSetup.domainId, instanceId, source: "ui" });
    }
    return serverSetup.out;
  };

  runtime.closeInstance = async (instanceId) => {
    const closeSeq = ++seq;
    if (instanceId) {
      closedSeqByInstance.set(instanceId, closeSeq);
      if ((activeOpenSeqByInstance.get(instanceId) || 0) < closeSeq) {
        activeOpenSeqByInstance.delete(instanceId);
      }
    }
    // Invalidate viewer activity immediately without waiting on pending fleet open/discovery RPCs.
    const invalidation = Promise.resolve().then(() =>
      canvasConfig.onCloseInstance?.(instanceId, {
        canMutatePanel: () => !instanceId || (activeOpenSeqByInstance.get(instanceId) || 0) < closeSeq,
      }),
    );
    const serverClose = serializeServer(async () => {
      if (!instanceId || (activeOpenSeqByInstance.get(instanceId) || 0) < closeSeq) {
        return origClose(instanceId);
      }
      return undefined;
    });
    const [, closed] = await Promise.all([invalidation, serverClose]);
    return closed;
  };

  runtime.shutdown = async () => {
    const shutSeq = ++seq;
    shutdownSeq = shutSeq;
    activeOpenSeqByInstance.clear();
    // Immediately invalidate all fleet viewers, workers, and recovery dispatch before waiting on server teardown.
    const invalidation = Promise.resolve().then(() => canvasConfig.onShutdown?.());
    const serverShutdown = serializeServer(() => origShutdown());
    const [, closed] = await Promise.all([invalidation, serverShutdown]);
    return closed;
  };

  return runtime;
}

export function createProgressCanvas(service, sessionId, { refreshTracking = async () => {}, fleetService = null } = {}) {
  let activeScope = "session";
  const operatorDomainId = `${sessionId}:operator`;
  const openPanels = new Set();
  const trustedPanels = new Set();
  const panelTrustByInstance = new Map();
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
        const viewerKey = ctx?.instanceId;
        if (input.scope === "session") {
          activeScope = "session";
          await fleetService.clearAllViewers();
        } else {
          activeScope = input.scope;
          if (viewerKey && trustedPanels.has(viewerKey)) openPanels.add(viewerKey);
          for (const panelId of [...openPanels]) {
            if (viewerKey && (!openPanels.has(viewerKey) || !trustedPanels.has(viewerKey))) break;
            if (openPanels.has(panelId) && trustedPanels.has(panelId)) {
              await fleetService.setViewerActive(panelId, true);
            }
          }
        }
        if (viewerKey && !trustedPanels.has(viewerKey)) {
          return { scope: activeScope, fleetRevision: fleetService.snapshot()?.revision ?? 0 };
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
    didOpenerTrustChange: (instanceId, ctx) => {
      if (!fleetService || !instanceId || !panelTrustByInstance.has(instanceId)) return false;
      return panelTrustByInstance.get(instanceId) !== isTrustedOpener(ctx);
    },
    authorizeOpen: (instanceId, input, ctx, { commitTrust = true } = {}) => {
      if (ctx?.sessionId && ctx.sessionId !== sessionId) {
        throw new Error("Cross-session canvas rejected");
      }
      if (!fleetService) return;
      const requested = input?.scope;
      if (requested === "fleet" || requested === "projects" || requested === "inbox") {
        const actor = actorFor(ctx || {}, sessionId);
        if (!actor.primary) {
          throw new Error("Only the primary session agent may open fleet-scoped views");
        }
      }
      if (commitTrust && instanceId) {
        const trusted = isTrustedOpener(ctx);
        panelTrustByInstance.set(instanceId, trusted);
        if (trusted) trustedPanels.add(instanceId);
        else trustedPanels.delete(instanceId);
      }
    },
    onOpenInstance: async (instanceId, input, ctx, { isCurrent = () => true } = {}) => {
      if (!fleetService || !isCurrent()) return false;
      const trusted = instanceId ? trustedPanels.has(instanceId) : isTrustedOpener(ctx);
      if (!trusted) {
        if (instanceId) {
          openPanels.delete(instanceId);
          await fleetService.setViewerActive(instanceId, false);
        }
        if (isCurrent() && (openPanels.size === 0 || !fleetService.isPolling())) activeScope = "session";
        return false;
      }
      if (instanceId) openPanels.add(instanceId);
      const requested = input?.scope;
      if (requested === "fleet" || requested === "projects" || requested === "inbox") {
        activeScope = requested === "inbox" ? "inbox" : "projects";
        for (const panelId of [...openPanels]) {
          if (!isCurrent()) return false;
          if (openPanels.has(panelId) && trustedPanels.has(panelId)) {
            await fleetService.setViewerActive(panelId, true);
          }
        }
        return isCurrent();
      }
      const hadFleetScope = activeScope !== "session" || fleetService.isPolling();
      activeScope = "session";
      await fleetService.clearAllViewers();
      return isCurrent() ? hadFleetScope : false;
    },
    onCloseInstance: async (instanceId, { canMutatePanel = () => true } = {}) => {
      if (!fleetService) return;
      if (instanceId && canMutatePanel()) {
        openPanels.delete(instanceId);
        trustedPanels.delete(instanceId);
        panelTrustByInstance.delete(instanceId);
        if (openPanels.size === 0) activeScope = "session";
      }
      if (canMutatePanel()) {
        await fleetService.setViewerActive(instanceId, false);
      }
      if (canMutatePanel() && (openPanels.size === 0 || !fleetService.isPolling())) {
        activeScope = "session";
      }
    },
    onShutdown: async () => {
      if (!fleetService) return;
      openPanels.clear();
      trustedPanels.clear();
      panelTrustByInstance.clear();
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
