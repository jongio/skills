export const progressInputSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["status", "refresh", "goal", "draft", "assign", "subtasks", "report", "phase"] },
    goalId: { type: "string" }, title: { type: "string" },
    taskIds: { type: "array", items: { type: "string" } },
    taskId: { type: "string" }, agentId: { type: "string" },
    parentTaskId: { type: "string" },
    updateId: { type: "string" }, sequence: { type: "integer" },
    status: { type: "string" }, message: { type: "string" }, evidence: { type: "string" },
    phase: { type: "string" }, verified: { type: "boolean" },
    expectedRevision: { type: "integer" }, confirmEmpty: { type: "boolean" },
    requiresOperator: { type: "boolean" },
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
