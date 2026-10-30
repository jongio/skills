import { isOperatorEvent, isRootCancellation } from "./progress.mjs";
import { trackingChangeKind } from "./references.mjs";

export const isProgressEvent = (event) => isOperatorEvent(event.type) || isRootCancellation(event) ||
  /^(subagent\.|session\.(?:plan_changed|todos_changed|resume|compaction_complete))/.test(event.type) ||
  trackingChangeKind(event) !== null;

const trackedTargetSchema = {
  type: "object", properties: {
    reference: { type: "string" }, url: { type: "string" }, owned: { type: "boolean" },
    title: { type: "string" }, state: { type: "string", enum: ["OPEN", "CLOSED", "MERGED", "UNKNOWN"] },
    headRefOid: { type: "string" },
  }, required: ["owned"], additionalProperties: false,
};

export const progressInputSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["status", "refresh", "goal", "draft", "assign", "subtasks", "report", "phase", "references", "ci"] },
    goalId: { type: ["string", "null"], description: "Originating goal for reports. Null only continues a known pre-goal session report after activation." }, title: { type: "string" },
    taskIds: { type: "array", items: { type: "string" } },
    taskId: { type: "string" }, agentId: { type: "string" },
    parentTaskId: { type: "string" },
    updateId: { type: "string" }, sequence: { type: "integer" },
    status: { type: "string" }, message: { type: "string" }, evidence: { type: "string" },
    phase: { type: "string" }, verified: { type: "boolean" },
    expectedRevision: { type: "integer" }, confirmEmpty: { type: "boolean" },
    requiresOperator: { type: "boolean" },
    prs: { type: "array", items: trackedTargetSchema }, issues: { type: "array", items: trackedTargetSchema },
    referenceStatus: { type: "string", enum: ["verified", "unavailable"] }, error: { type: "string" },
    reference: { type: "string" }, headRefOid: { type: "string" }, observedAt: { type: "string" },
    passed: { type: "integer", minimum: 0 }, total: { type: "integer", minimum: 0 },
    pendingChecks: { type: "array", items: { type: "string" } }, failedChecks: { type: "array", items: { type: "string" } },
    drafts: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id", "title"], additionalProperties: false } },
  },
  required: ["action"], additionalProperties: false,
};

export function actorFor(invocation, sessionId) {
  if (invocation.sessionId !== sessionId) throw new Error("Cross-session progress update rejected");
  if (!Object.hasOwn(invocation, "agentId")) throw new Error("Caller attribution unavailable on this host");
  if (invocation.agentId != null && typeof invocation.agentId !== "string") throw new Error("Invalid caller attribution");
  return invocation.agentId ? { id: invocation.agentId, primary: false } : { id: "primary", primary: true };
}

export function createProgressEventGate(handle) {
  const pending = [];
  let live = false;
  let draining;
  return {
    push(event) {
      if (!live) pending.push(event);
      else return handle(event);
    },
    start() {
      draining ||= (async () => {
        while (pending.length) await handle(pending.shift());
        live = true;
      })();
      return draining;
    },
  };
}

export async function readSessionSources(session, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([
      Promise.all([session.rpc.plan.read(), session.rpc.plan.readSqlTodosWithDependencies()])
        .then(([plan, todos]) => ({ plan, rows: todos.rows, dependencies: todos.dependencies })),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Session progress source read timed out")), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
