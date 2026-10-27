import { fileURLToPath } from "node:url";

const emptyInput = { type: "object", properties: {}, additionalProperties: false };

export function createProgressCanvas(service, sessionId) {
  return {
    id: "session-progress",
    requireCapability: true,
    displayName: "Session Board Canvas",
    description: "Live session tasks, kanban, agents, blockers, and delivery status.",
    assetsDir: fileURLToPath(new URL("./web/", import.meta.url)),
    inputSchema: emptyInput,
    resolveDomainId: (_input, ctx) => {
      if (ctx?.sessionId && ctx.sessionId !== sessionId) throw new Error("Cross-session canvas rejected");
      return sessionId;
    },
    createInitialState: () => service.snapshot(),
    statusLine: (_ctx, state) => `${state.metrics?.done || 0}/${state.metrics?.total || 0} tasks`,
    actions: {
      get_status: {
        description: "Read this session's board without changing tasks.",
        inputSchema: emptyInput,
        handler: ({ set }) => {
          const snapshot = service.snapshot();
          set(snapshot);
          return snapshot;
        },
      },
      refresh: {
        description: "Refresh canonical plan/tasks; never mutates task state.",
        inputSchema: emptyInput,
        handler: async ({ set }) => {
          const snapshot = await service.refresh();
          set(snapshot);
          return { revision: snapshot.revision, source: snapshot.source };
        },
      },
    },
  };
}
