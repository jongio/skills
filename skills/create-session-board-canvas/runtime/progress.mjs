const statuses = new Set(["pending", "in_progress", "blocked", "done"]);
const reportStatuses = new Set(["working", "blocked", "result_ready", "failed", "cancelled"]);
const phases = new Set(["planning", "testing", "implementing", "reviewing", "delivery", "ci", "remediation", "awaiting_review", "awaiting_merge_approval", "merged", "cleanup_pending", "blocked"]);
const clone = (value) => structuredClone(value);
const bounded = (value, label, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
  return value.trim();
};
const identifier = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error("Invalid identifier");
  return value;
};
const primaryOnly = (actor) => {
  if (!actor.primary) throw new Error("Only the primary agent may configure the board");
};
const initialDelivery = () => ({ phase: "planning", status: "running", evidence: null });

function projectTasks(rows, dependencies) {
  const seen = new Set();
  const tasks = rows.filter((row) => typeof row?.id === "string" && row.id && !seen.has(row.id) && seen.add(row.id))
    .map((row) => ({
      id: row.id, title: String(row.title || row.id), description: String(row.description || ""),
      status: statuses.has(row.status) ? row.status : "unknown", waitingOn: [], issues: [],
    }));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const edges = dependencies.filter((edge) => typeof edge?.todoId === "string" && typeof edge.dependsOn === "string");
  const incoming = new Map(tasks.map((task) => [task.id, edges.filter((e) => e.todoId === task.id).map((e) => e.dependsOn)]));
  for (const task of tasks) {
    task.waitingOn = [...new Set(incoming.get(task.id))].filter((id) => byId.get(id)?.status !== "done");
    for (const id of task.waitingOn) if (!byId.has(id)) task.issues.push(`Missing dependency: ${id}`);
    const visited = new Set();
    const pending = [...(incoming.get(task.id) || [])];
    while (pending.length) {
      const id = pending.pop();
      if (id === task.id) { task.issues.push("Dependency cycle"); break; }
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...(incoming.get(id) || []));
    }
  }
  return { tasks, dependencies: edges };
}

function decorateTasks(tasks, hierarchy) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map(hierarchy.map((entry) => [entry.parentId, entry.childIds]));
  for (const task of tasks) {
    task.childIds = (children.get(task.id) || []).filter((id) => byId.has(id));
    task.parentId = hierarchy.find((entry) => entry.childIds.includes(task.id))?.parentId || null;
    if (!task.childIds.length) continue;
    const pending = [...task.childIds];
    const seen = new Set([task.id]);
    const leaves = [];
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const nested = (children.get(id) || []).filter((child) => byId.has(child));
      if (nested.length) pending.push(...nested);
      else if (byId.has(id)) leaves.push(byId.get(id));
    }
    const done = leaves.filter((leaf) => leaf.status === "done").length;
    task.subtaskProgress = { done, total: leaves.length, percent: leaves.length ? Math.floor(done / leaves.length * 100) : null };
  }
  return tasks;
}

export async function createProgressService({ sessionId, readSources, store, onChange = () => {}, clock = () => new Date().toISOString() }) {
  identifier(sessionId);
  const loaded = await store.load(null);
  if (loaded && (loaded.version !== 1 || loaded.sessionId !== sessionId || !Array.isArray(loaded.goals) ||
      !Array.isArray(loaded.tasks) || !Array.isArray(loaded.agents) || !Array.isArray(loaded.reports) ||
      !Array.isArray(loaded.activity) || !Array.isArray(loaded.seen))) throw new Error("Invalid session progress state");
  let state = loaded || {
    version: 1, sessionId, revision: 0, activeGoalId: null, goals: [], tasks: [], dependencies: [],
    agents: [{ id: "primary", name: "Primary agent", role: "primary", state: "working", taskIds: [] }],
    reports: [], activity: [], attention: [], hierarchy: [], drafts: [], seen: [], plan: { exists: false, content: null, path: null },
    delivery: initialDelivery(), source: { status: "loading", error: null, lastRefresh: null },
  };
  if (loaded) state.source = { ...state.source, status: "stale", error: "Reconnecting to session sources" };
  // Input completions are ephemeral; do not resurrect requests after reconnect.
  state.attention = [];
  state.hierarchy ||= [];
  let tail = Promise.resolve();
  const queue = (work) => {
    const result = tail.catch(() => {}).then(work);
    tail = result;
    return result;
  };
  const snapshot = () => {
    const out = clone(state);
    delete out.seen;
    out.tasks = decorateTasks(out.tasks, out.hierarchy);
    for (const goal of out.goals) goal.tasks = decorateTasks(goal.tasks, out.hierarchy);
    const active = out.goals.find((goal) => goal.id === out.activeGoalId);
    const tasks = (active?.tasks || out.tasks).filter((task) => !task.childIds.length);
    const done = tasks.filter((task) => task.status === "done").length;
    out.metrics = { done, total: tasks.length, percent: tasks.length ? Math.floor(done / tasks.length * 100) : null };
    out.delivery = active?.delivery || out.delivery;
    return out;
  };
  async function commit(next) {
    next.revision = state.revision + 1;
    await store.save(next);
    state = next;
    await onChange(snapshot());
  }
  function activity(next, actorId, message, type) {
    next.activity.push({ id: `${next.revision + 1}`, actorId, message, type, at: clock() });
    next.activity = next.activity.slice(-100);
  }
  function agent(next, id, name) {
    let member = next.agents.find((entry) => entry.id === id);
    if (!member) {
      member = { id, name: name || id, role: "subagent", state: "working", taskIds: [] };
      next.agents.push(member);
    }
    return member;
  }
  async function refreshNow(confirmEmpty = false) {
    const next = clone(state);
    try {
      const source = await readSources();
      if (!Array.isArray(source?.rows) || !Array.isArray(source?.dependencies) || !source.plan) throw new Error("Session sources unavailable");
      if (!source.rows.length && state.tasks.length && !confirmEmpty) throw new Error("Empty task read is ambiguous; primary must confirm task removal");
      Object.assign(next, projectTasks(source.rows, source.dependencies), { plan: source.plan });
      if (confirmEmpty) {
        const active = next.goals.find((goal) => goal.id === next.activeGoalId);
        const canonicalIds = new Set(next.tasks.map((task) => task.id));
        const removed = new Set(active?.taskIds.filter((id) => !canonicalIds.has(id)) || []);
        if (active) active.taskIds = active.taskIds.filter((id) => !removed.has(id));
        next.hierarchy = next.hierarchy.filter((entry) => !removed.has(entry.parentId))
          .map((entry) => ({ ...entry, childIds: entry.childIds.filter((id) => !removed.has(id)) }))
          .filter((entry) => entry.childIds.length);
        next.reports = next.reports.filter((report) => report.goalId !== active?.id || !removed.has(report.taskId));
        for (const member of next.agents) member.taskIds = member.taskIds.filter((id) => !removed.has(id));
      }
      for (const goal of next.goals) {
        const fresh = new Map(next.tasks.filter((task) => goal.taskIds.includes(task.id)).map((task) => [task.id, task]));
        goal.tasks = goal.taskIds.map((id) => fresh.get(id) || goal.tasks.find((task) => task.id === id)).filter(Boolean);
      }
      next.source = { status: "live", error: null, lastRefresh: clock() };
    } catch (error) {
      next.source = { ...next.source, status: "stale", error: String(error.message).slice(0, 1000) };
    }
    await commit(next);
    return snapshot();
  }
  let scheduledRefresh;
  let refreshAgain = false;
  const refresh = (confirmEmpty = false) => {
    if (confirmEmpty) return queue(() => refreshNow(true));
    if (scheduledRefresh) {
      refreshAgain = true;
      return scheduledRefresh;
    }
    scheduledRefresh = queue(() => refreshNow()).finally(() => {
      scheduledRefresh = null;
      if (refreshAgain) {
        refreshAgain = false;
        void refresh().catch(() => {});
      }
    });
    return scheduledRefresh;
  };
  async function update(input, actor) {
    if (!actor || typeof actor.id !== "string") throw new Error("Caller attribution unavailable; use primary-agent relay");
    if (!input || typeof input !== "object") throw new Error("Invalid update");
    if (input.action === "status") return snapshot();
    return queue(async () => {
      if (input.action === "refresh") {
        if (input.confirmEmpty) primaryOnly(actor);
        return refreshNow(Boolean(input.confirmEmpty));
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== state.revision) throw new Error("Revision conflict; refresh and reconcile");
      const next = clone(state);
      const active = next.goals.find((goal) => goal.id === next.activeGoalId);
      switch (input.action) {
        case "goal": {
          primaryOnly(actor);
          const id = identifier(input.goalId);
          const title = bounded(input.title, "goal title", 200);
          if (!Array.isArray(input.taskIds) || input.taskIds.length > 2000) throw new Error("taskIds are required");
          const taskIds = [...new Set(input.taskIds.map(identifier))];
          const membership = new Set(taskIds);
          if (next.hierarchy.some((entry) => entry.childIds.some((id) => membership.has(entry.parentId) !== membership.has(id)))) {
            throw new Error("Goal mapping cannot split a task hierarchy; explicitly detach subtasks first");
          }
          for (const taskId of taskIds) {
            if (!next.tasks.some((task) => task.id === taskId)) throw new Error(`Unknown canonical task: ${taskId}`);
            if (next.goals.some((goal) => goal.id !== id && goal.taskIds.includes(taskId))) throw new Error("Task belongs to another goal");
          }
          const existing = next.goals.find((goal) => goal.id === id);
          const goal = existing || { id, createdAt: clock(), delivery: initialDelivery() };
          Object.assign(goal, { title, taskIds, tasks: next.tasks.filter((task) => taskIds.includes(task.id)), plan: clone(next.plan) });
          if (!existing) next.goals.push(goal);
          next.activeGoalId = id;
          next.drafts = [];
          activity(next, actor.id, `Tracking goal: ${title}`, "goal");
          break;
        }
        case "draft":
          primaryOnly(actor);
          if (!Array.isArray(input.drafts) || input.drafts.length > 100) throw new Error("Invalid draft outline");
          next.drafts = input.drafts.map((draft) => ({ id: identifier(draft.id), title: bounded(draft.title, "draft title", 200) }));
          break;
        case "assign": {
          primaryOnly(actor);
          if (!active) throw new Error("Configure a goal first");
          const member = next.agents.find((entry) => entry.id === input.agentId);
          if (!member) throw new Error("Agent has not been observed in this session");
          if (!Array.isArray(input.taskIds) || input.taskIds.some((id) => !active.taskIds.includes(id))) throw new Error("Unknown goal task");
          for (const other of next.agents) other.taskIds = other.taskIds.filter((id) => !input.taskIds.includes(id));
          member.taskIds = [...new Set(input.taskIds)];
          member.goalId = active.id;
          activity(next, actor.id, `Assigned ${member.taskIds.length} tasks to ${member.name}`, "assignment");
          break;
        }
        case "subtasks": {
          primaryOnly(actor);
          if (!active) throw new Error("Configure a goal first");
          const parentId = identifier(input.parentTaskId);
          if (!active.taskIds.includes(parentId) || !Array.isArray(input.taskIds)) throw new Error("Unknown parent or children");
          const childIds = [...new Set(input.taskIds.map(identifier))];
          if (childIds.some((id) => id === parentId || !active.taskIds.includes(id))) throw new Error("Subtasks must be distinct canonical tasks in this goal");
          const hierarchy = next.hierarchy.filter((entry) => entry.parentId !== parentId);
          if (hierarchy.some((entry) => entry.childIds.some((id) => childIds.includes(id)))) throw new Error("Subtask already has a parent");
          hierarchy.push({ parentId, childIds });
          const byParent = new Map(hierarchy.map((entry) => [entry.parentId, entry.childIds]));
          const pending = [...childIds];
          const seen = new Set();
          while (pending.length) {
            const id = pending.pop();
            if (id === parentId) throw new Error("Subtask hierarchy cannot contain cycles");
            if (seen.has(id)) continue;
            seen.add(id);
            pending.push(...(byParent.get(id) || []));
          }
          next.hierarchy = hierarchy.filter((entry) => entry.childIds.length);
          activity(next, actor.id, `Tracking ${childIds.length} subtasks for ${parentId}`, "subtasks");
          break;
        }
        case "report": {
          const updateId = identifier(input.updateId);
          let actorId = actor.id;
          if (input.agentId !== undefined) {
            primaryOnly(actor);
            if (!next.agents.some((member) => member.id === input.agentId)) throw new Error("Relayed agent has not been observed");
            actorId = input.agentId;
          }
          if (!reportStatuses.has(input.status)) throw new Error("Invalid report status; completion requires primary verification and a canonical task update");
          const message = bounded(input.message, "report");
          const taskId = input.taskId || null;
          const delegated = !actor.primary || input.agentId !== undefined;
          const memberGoalId = delegated ? next.agents.find((member) => member.id === actorId)?.goalId || null : null;
          const taskGoalId = taskId ? next.goals.find((goal) => goal.taskIds.includes(taskId))?.id || null : null;
          const goalId = input.goalId === undefined
            ? taskGoalId || memberGoalId || (delegated ? null : next.activeGoalId)
            : identifier(input.goalId);
          if (delegated && !goalId && next.activeGoalId) throw new Error("goalId is required for an unassigned delegate report");
          if ((memberGoalId && memberGoalId !== goalId) || (taskGoalId && taskGoalId !== goalId)) throw new Error("Report goal conflicts with its delegated task or assignment");
          const reportGoal = next.goals.find((goal) => goal.id === goalId);
          if (goalId && !reportGoal) throw new Error("Unknown report goal");
          if (taskId && (!reportGoal?.taskIds.includes(taskId) || !next.tasks.some((task) => task.id === taskId))) throw new Error("Unknown report goal task");
          const key = JSON.stringify([actorId, goalId, updateId]);
          if (next.seen.includes(key) || next.reports.some((report) =>
            report.actorId === actorId && (report.goalId || null) === goalId && report.id === updateId)) {
            return { duplicate: true, revision: state.revision };
          }
          const owner = next.agents.find((member) => member.taskIds.includes(taskId) && member.goalId === goalId);
          if (owner && owner.id !== actorId) throw new Error("Task is assigned to another agent");
          if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new Error("Positive report sequence required");
          const previous = next.reports.find((report) => report.actorId === actorId && report.taskId === taskId && report.goalId === goalId);
          if (previous && input.sequence <= previous.sequence) throw new Error("Stale report; reconcile the latest sequence");
          if (input.evidence !== undefined) bounded(input.evidence, "evidence", 4000);
          const report = { id: updateId, actorId, taskId, goalId, status: input.status, message,
            sequence: input.sequence, evidence: input.evidence || null, requiresOperator: input.requiresOperator === true,
            relayed: actorId !== actor.id, at: clock() };
          next.reports = next.reports.filter((r) => r !== previous);
          next.reports.push(report);
          next.reports = next.reports.slice(-300);
          const member = agent(next, actorId);
          if (delegated && !member.goalId) member.goalId = goalId;
          Object.assign(member, { state: report.status, report: message, updatedAt: report.at });
          next.seen.push(key);
          next.seen = next.seen.slice(-1000);
          activity(next, actorId, message, report.status);
          break;
        }
        case "phase": {
          primaryOnly(actor);
          if (!phases.has(input.phase) || !["running", "waiting", "blocked", "done"].includes(input.status)) throw new Error("Invalid delivery phase/status");
          if (["merged", "cleanup_pending"].includes(input.phase) && (!input.verified || !input.evidence)) throw new Error("Verified merge evidence is required");
          const delivery = { phase: input.phase, status: input.status, evidence: input.evidence ? bounded(input.evidence, "evidence", 4000) : null };
          if (active) active.delivery = delivery;
          next.delivery = delivery;
          activity(next, actor.id, `Phase: ${input.phase}`, "phase");
          break;
        }
        default: throw new Error("Unknown session progress action");
      }
      await commit(next);
      return { revision: state.revision, activeGoalId: state.activeGoalId };
    });
  }
  async function observe(event) {
    const data = event.data || {};
    if (/^(permission|user_input|elicitation)\.(requested|completed)$/.test(event.type)) {
      if (!data.requestId || data.resolvedByHook) return;
      return queue(async () => {
        const next = clone(state);
        const kind = event.type.split(".")[0];
        const id = `${kind}:${data.requestId}`;
        next.attention = next.attention.filter((request) => request.id !== id);
        if (event.type.endsWith(".requested")) next.attention.push({
          id, kind, message: String(data.question || data.message || "Operator permission required").slice(0, 1000), at: event.timestamp || clock(),
        });
        await commit(next);
      });
    }
    if (!/^subagent\.(started|completed|failed)$/.test(event.type)) return;
    const id = event.agentId || data.agentId;
    if (!id) return;
    return queue(async () => {
      const key = `event:${event.id}`;
      if (event.id && state.seen.includes(key)) return;
      const next = clone(state);
      const member = agent(next, id, String(data.agentDisplayName || data.agentName || id).slice(0, 200));
      if (member.updatedAt && event.timestamp && event.timestamp < member.updatedAt) return;
      member.state = event.type === "subagent.started" ? "working" :
        event.type === "subagent.failed" ? "failed" : data.cancelled ? "cancelled" : "result_ready";
      member.updatedAt = event.timestamp || clock();
      member.role = data.agentType || member.role;
      if (event.id) next.seen = [...next.seen, key].slice(-1000);
      activity(next, id, `${member.name}: ${member.state}`, "agent");
      await commit(next);
    });
  }
  return { snapshot, refresh, update, observe };
}
