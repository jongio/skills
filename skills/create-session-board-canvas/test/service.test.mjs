import assert from "node:assert/strict";
import test from "node:test";
import { createProgressService } from "../runtime/progress.mjs";

const primary = { id: "primary", primary: true };
const worker = { id: "worker", primary: false };
const task = (id, status = "pending") => ({ id, title: id, status });
async function fixture(rows = [task("a"), task("b")], dependencies = []) {
  let source = { plan: { exists: true, content: "Approved plan", path: "plan.md" }, rows, dependencies };
  let saved;
  const service = await createProgressService({
    sessionId: "test-session",
    readSources: async () => {
      if (source instanceof Error) throw source;
      return source;
    },
    store: { load: async () => null, save: async (value) => { saved = structuredClone(value); } },
  });
  await service.refresh();
  return { service, setSource: (next) => { source = next; }, saved: () => saved };
}
const goal = (service, id = "goal", taskIds = ["a", "b"]) =>
  service.update({ action: "goal", goalId: id, title: id, taskIds }, primary);

test("canonical completion and dependencies determine progress, never agent success", async () => {
  const { service } = await fixture([task("a", "done"), task("b")], [{ todoId: "b", dependsOn: "a" }]);
  await goal(service);
  await service.update({ action: "report", updateId: "r1", taskId: "b", status: "result_ready", message: "Ready to verify", sequence: 1 }, worker);
  assert.deepEqual(service.snapshot().metrics, { done: 1, total: 2, percent: 50 });
  assert.equal(service.snapshot().tasks[1].status, "pending");
  assert.deepEqual(service.snapshot().tasks[1].waitingOn, []);
  await assert.rejects(service.update({ action: "report", updateId: "r2", taskId: "b", status: "done", message: "done", sequence: 2 }, worker));
});

test("empty, malformed, missing dependency and cyclic sources never imply completion", async () => {
  const empty = await fixture([]);
  assert.equal(empty.service.snapshot().metrics.percent, null);
  const { service } = await fixture([task("a"), task("b"), { title: "missing id" }, task("c", "bogus")],
    [{ todoId: "a", dependsOn: "b" }, { todoId: "b", dependsOn: "a" }, { todoId: "c", dependsOn: "missing" }]);
  const state = service.snapshot();
  assert.deepEqual(state.tasks[0].waitingOn, ["b"]);
  assert.ok(state.tasks[0].issues.includes("Dependency cycle"));
  assert.equal(state.tasks[2].status, "unknown");
  assert.ok(state.tasks[2].issues.includes("Missing dependency: missing"));
});

test("concurrent reports merge, retries deduplicate, older sequences cannot erase blockers", async () => {
  const { service } = await fixture();
  await goal(service);
  await Promise.all([
    service.update({ action: "report", updateId: "one", taskId: "a", status: "blocked", message: "Need access", sequence: 3 }, worker),
    service.update({ action: "report", updateId: "two", taskId: "b", status: "working", message: "Checking", sequence: 1 }, { id: "other", primary: false }),
  ]);
  const revision = service.snapshot().revision;
  const duplicate = await service.update({ action: "report", updateId: "one", taskId: "a", status: "working", message: "Retry", sequence: 4 }, worker);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(service.update({ action: "report", updateId: "old", taskId: "a", status: "working", message: "Old", sequence: 2 }, worker), /Stale report/);
  assert.equal(service.snapshot().revision, revision);
  assert.equal(service.snapshot().reports.find((r) => r.actorId === "worker").status, "blocked");
  assert.equal(service.snapshot().reports.length, 2);
});

test("only attributed primary configures goals, assignments and verified delivery", async () => {
  const { service } = await fixture();
  await assert.rejects(service.update({ action: "goal", goalId: "g", title: "x", taskIds: ["a"] }, worker), /primary/i);
  await assert.rejects(service.update({ action: "status" }, null), /attribution/i);
  await goal(service);
  await assert.rejects(service.update({ action: "assign", agentId: "not-observed", taskIds: ["a"] }, primary), /observed/i);
  await service.observe({ id: "s1", type: "subagent.started", agentId: "worker", data: { agentDisplayName: "Tester", agentType: "task" } });
  await service.update({ action: "assign", agentId: "worker", taskIds: ["a"] }, primary);
  await assert.rejects(service.update({ action: "report", updateId: "bad", taskId: "a", status: "working", message: "Claim", sequence: 1 }, { id: "other" }), /assigned/i);
  await assert.rejects(service.update({ action: "phase", phase: "merged", status: "done" }, primary), /evidence/i);
  await service.update({ action: "phase", phase: "awaiting_merge_approval", status: "waiting" }, primary);
  assert.equal(service.snapshot().delivery.phase, "awaiting_merge_approval");
});

test("goal history survives plan replacement without duplicating task ownership", async () => {
  const { service, setSource } = await fixture([task("a", "done")]);
  await goal(service, "first", ["a"]);
  setSource({ plan: { exists: true, content: "Next goal" }, rows: [task("b")], dependencies: [] });
  await service.refresh();
  await goal(service, "second", ["b"]);
  const state = service.snapshot();
  assert.equal(state.goals[0].tasks[0].status, "done");
  assert.equal(state.goals[1].tasks[0].status, "pending");
  assert.equal(state.metrics.percent, 0);
  await assert.rejects(goal(service, "duplicate", ["b"]), /another goal/i);
});

test("unexplained empty reads and source failures preserve the last good tasks", async () => {
  const { service, setSource } = await fixture();
  setSource({ plan: { exists: false }, rows: [], dependencies: [] });
  await service.refresh();
  assert.equal(service.snapshot().source.status, "stale");
  assert.equal(service.snapshot().tasks.length, 2);
  setSource(new Error("RPC unavailable"));
  await service.refresh();
  assert.equal(service.snapshot().tasks.length, 2);
  assert.match(service.snapshot().source.error, /unavailable/);
  setSource({ plan: { exists: false }, rows: [], dependencies: [] });
  await service.update({ action: "refresh", confirmEmpty: true }, primary);
  assert.equal(service.snapshot().tasks.length, 0);
});

test("failed persistence rolls back updates and resume preserves isolated metadata", async () => {
  let value;
  let fail = false;
  const store = { load: async () => value, save: async (next) => {
    if (fail) throw new Error("disk full");
    value = structuredClone(next);
  } };
  const options = { sessionId: "one", store, readSources: async () => ({ plan: {}, rows: [task("a")], dependencies: [] }) };
  const service = await createProgressService(options);
  await service.refresh();
  await goal(service, "g", ["a"]);
  fail = true;
  const revision = service.snapshot().revision;
  await assert.rejects(service.update({ action: "phase", phase: "testing", status: "running" }, primary), /disk full/);
  assert.equal(service.snapshot().revision, revision);
  fail = false;
  const resumed = await createProgressService(options);
  assert.equal(resumed.snapshot().activeGoalId, "g");
  assert.equal(resumed.snapshot().source.status, "stale");
  await assert.rejects(createProgressService({ ...options, sessionId: "two" }), /session/i);
});

test("drafts never become canonical and lifecycle events do not accept results", async () => {
  const { service } = await fixture([]);
  await service.update({ action: "draft", drafts: [{ id: "draft", title: "Proposed work" }] }, primary);
  assert.equal(service.snapshot().metrics.percent, null);
  await service.observe({ id: "start", type: "subagent.started", agentId: "worker", data: { agentName: "Check" } });
  await service.observe({ id: "finish", type: "subagent.completed", agentId: "worker", data: {} });
  assert.equal(service.snapshot().agents.find((a) => a.id === "worker").state, "result_ready");
  const rev = service.snapshot().revision;
  await service.observe({ id: "finish", type: "subagent.completed", agentId: "worker", data: {} });
  assert.equal(service.snapshot().revision, rev);
});

test("operator attention is explicit and independent of blocked tasks and cross-agent dependencies", async () => {
  const { service } = await fixture([task("a", "blocked"), task("b")], [{ todoId: "b", dependsOn: "a" }]);
  await goal(service);
  await service.observe({ id: "worker-start", type: "subagent.started", agentId: "worker", data: {} });
  await service.update({ action: "assign", agentId: "worker", taskIds: ["a"] }, primary);
  await service.update({ action: "assign", agentId: "primary", taskIds: ["b"] }, primary);
  await service.update({ action: "report", updateId: "blocked", taskId: "a", sequence: 1, status: "blocked", message: "Waiting for fixture" }, worker);
  assert.equal(service.snapshot().reports[0].requiresOperator, false);
  assert.deepEqual(service.snapshot().attention, []);
  assert.deepEqual(service.snapshot().tasks[1].waitingOn, ["a"]);
  await service.update({ action: "report", updateId: "operator", taskId: "a", sequence: 2, status: "blocked", message: "Operator must grant fixture access", requiresOperator: true }, worker);
  assert.equal(service.snapshot().reports[0].requiresOperator, true);
  await service.observe({ type: "permission.requested", data: { requestId: "automatic", resolvedByHook: true } });
  assert.deepEqual(service.snapshot().attention, []);
  await service.observe({ type: "user_input.requested", data: { requestId: "choice", question: "Approve scope?" } });
  assert.equal(service.snapshot().attention[0].message, "Approve scope?");
  await service.observe({ type: "user_input.completed", data: { requestId: "choice" } });
  assert.deepEqual(service.snapshot().attention, []);
  await service.update({ action: "report", updateId: "resolved", taskId: "a", sequence: 3, status: "working", message: "Access restored" }, worker);
  assert.equal(service.snapshot().reports[0].requiresOperator, false);
});

test("canonical subtasks produce nested leaf progress without double-counting parents", async () => {
  const { service } = await fixture([task("milestone"), task("group"), task("a", "done"), task("b")]);
  await goal(service, "g", ["milestone", "group", "a", "b"]);
  await service.update({ action: "subtasks", parentTaskId: "milestone", taskIds: ["group", "b"] }, primary);
  await service.update({ action: "subtasks", parentTaskId: "group", taskIds: ["a"] }, primary);
  const state = service.snapshot();
  assert.deepEqual(state.metrics, { done: 1, total: 2, percent: 50 });
  assert.deepEqual(state.tasks[0].subtaskProgress, { done: 1, total: 2, percent: 50 });
  assert.equal(state.tasks[2].parentId, "group");
  assert.equal(state.tasks[0].status, "pending", "child completion cannot accept a parent milestone");
  await assert.rejects(service.update({ action: "subtasks", parentTaskId: "a", taskIds: ["milestone"] }, primary), /cycle/);
  await assert.rejects(service.update({ action: "subtasks", parentTaskId: "a", taskIds: ["b"] }, primary), /parent/);
  await assert.rejects(service.update({ action: "subtasks", parentTaskId: "milestone", taskIds: ["missing"] }, primary), /canonical/);
  await assert.rejects(service.update({ action: "subtasks", parentTaskId: "milestone", taskIds: ["a"] }, worker), /primary/);
});

test("percentage never rounds unfinished work up to 100 percent", async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => task(`work-${i}`, i === 999 ? "pending" : "done"));
  const { service } = await fixture(rows);
  assert.deepEqual(service.snapshot().metrics, { done: 999, total: 1000, percent: 99 });
});

test("slow source reads coalesce invalidations without starving live reports", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const order = [];
  const service = await createProgressService({
    sessionId: "coalescing",
    readSources: async () => {
      order.push(`read-${++calls}`);
      await gate;
      return { plan: { exists: false }, rows: [], dependencies: [] };
    },
    store: { load: async () => null, save: async (state) => {
      if (state.reports.length && !order.includes("report")) order.push("report");
    } },
  });
  const reads = Array.from({ length: 20 }, () => service.refresh());
  const report = service.update({ action: "report", updateId: "live", status: "working", message: "Still making progress", sequence: 1 }, worker);
  release();
  await Promise.all([...reads, report]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.ok(order.indexOf("report") < order.indexOf("read-2"));
  assert.equal(service.snapshot().reports[0].message, "Still making progress");
});

test("confirmed task removal clears the active goal without erasing archived history", async () => {
  const { service, setSource } = await fixture([task("a", "done"), task("b"), task("c")]);
  await goal(service, "archived", ["a"]);
  await goal(service, "current", ["b", "c"]);
  await service.update({ action: "subtasks", parentTaskId: "b", taskIds: ["c"] }, primary);
  await service.observe({ id: "worker", type: "subagent.started", agentId: "worker", data: {} });
  await service.update({ action: "assign", agentId: "worker", taskIds: ["c"] }, primary);
  await service.update({ action: "report", updateId: "old-blocker", taskId: "c", status: "blocked", message: "Old request", requiresOperator: true, sequence: 1 }, worker);
  setSource({ plan: { exists: false }, rows: [], dependencies: [] });
  await service.update({ action: "refresh", confirmEmpty: true }, primary);
  const state = service.snapshot();
  assert.deepEqual(state.goals.find((entry) => entry.id === "current").taskIds, []);
  assert.deepEqual(state.goals.find((entry) => entry.id === "current").tasks, []);
  assert.equal(state.goals.find((entry) => entry.id === "archived").tasks[0].status, "done");
  assert.deepEqual(state.metrics, { done: 0, total: 0, percent: null });
  assert.deepEqual(state.hierarchy, []);
  assert.equal(state.reports.length, 0);
  assert.deepEqual(state.agents.find((entry) => entry.id === "worker").taskIds, []);
});

test("goal remapping cannot split a hierarchy until primary explicitly detaches it", async () => {
  const { service } = await fixture();
  await goal(service, "first");
  await service.update({ action: "subtasks", parentTaskId: "a", taskIds: ["b"] }, primary);
  await assert.rejects(goal(service, "first", ["a"]), /hierarchy/i);
  await assert.rejects(goal(service, "first", ["b"]), /hierarchy/i);
  assert.deepEqual(service.snapshot().goals[0].taskIds, ["a", "b"]);
  await service.update({ action: "subtasks", parentTaskId: "a", taskIds: [] }, primary);
  await goal(service, "first", ["a"]);
  await goal(service, "second", ["b"]);
  assert.deepEqual(service.snapshot().hierarchy, []);
});

test("late delegate reports remain bound to their originating goal and reject mismatches", async () => {
  const { service } = await fixture();
  await goal(service, "first", ["a"]);
  await service.observe({ id: "worker", type: "subagent.started", agentId: "worker", data: {} });
  await service.update({ action: "assign", agentId: "worker", taskIds: ["a"] }, primary);
  await service.update({ action: "report", goalId: "first", updateId: "a-first", sequence: 5, status: "working", message: "First goal" }, worker);
  await goal(service, "second", ["b"]);
  await service.update({ action: "report", goalId: "first", updateId: "a-late", sequence: 6, status: "blocked", message: "Still first goal", requiresOperator: true }, worker);
  assert.equal(service.snapshot().reports.at(-1).goalId, "first");
  const revision = service.snapshot().revision;
  await assert.rejects(service.update({ action: "report", goalId: "second", updateId: "wrong", sequence: 7, status: "working", message: "Wrong goal" }, worker), /goal/i);
  assert.equal(service.snapshot().revision, revision);
  await service.update({ action: "report", updateId: "a-bound", sequence: 7, status: "working", message: "Uses bound first goal" }, worker);
  assert.equal(service.snapshot().reports.at(-1).goalId, "first");
  await service.update({ action: "report", updateId: "primary-b", sequence: 1, status: "working", message: "Primary second goal" }, primary);
  assert.equal(service.snapshot().reports.at(-1).goalId, "second");
  await assert.rejects(service.update({ action: "report", updateId: "unbound", sequence: 1, status: "working", message: "Unknown origin" }, { id: "unassigned", primary: false }), /goal/i);
});

test("exact whole percentages do not lose a point to binary rounding", async () => {
  const rows = [task("parent"), ...Array.from({ length: 100 }, (_, i) => task(`leaf-${i}`, i < 29 ? "done" : "pending"))];
  const { service } = await fixture(rows);
  await goal(service, "g", rows.map((row) => row.id));
  await service.update({ action: "subtasks", parentTaskId: "parent", taskIds: rows.slice(1).map((row) => row.id) }, primary);
  const state = service.snapshot();
  assert.equal(state.metrics.percent, 29);
  assert.equal(state.tasks[0].subtaskProgress.percent, 29);
});

test("task handoffs retire old alerts without discarding report sequence guards", async () => {
  const { service } = await fixture([task("a")]);
  await goal(service, "g", ["a"]);
  for (const id of ["worker", "other"]) await service.observe({ id, type: "subagent.started", agentId: id, data: {} });
  await service.update({ action: "assign", agentId: "worker", taskIds: ["a"] }, primary);
  await service.update({ action: "report", updateId: "request", taskId: "a", sequence: 5, status: "blocked", message: "Need access", requiresOperator: true }, worker);
  await service.update({ action: "assign", agentId: "other", taskIds: ["a"] }, primary);
  const retired = service.snapshot().reports.find((report) => report.actorId === "worker");
  assert.equal(retired.superseded, true);
  assert.equal(retired.requiresOperator, false);
  assert.equal(retired.sequence, 5);
  await service.update({ action: "report", updateId: "resolved", taskId: "a", sequence: 1, status: "working", message: "Access restored" }, { id: "other", primary: false });
  await service.update({ action: "assign", agentId: "worker", taskIds: ["a"] }, primary);
  await assert.rejects(service.update({ action: "report", updateId: "delayed", taskId: "a", sequence: 4, status: "blocked", message: "Stale request" }, worker), /Stale/);
  await service.update({ action: "report", updateId: "current", taskId: "a", sequence: 6, status: "working", message: "New accepted report" }, worker);
  assert.notEqual(service.snapshot().reports.find((report) => report.actorId === "worker").superseded, true);
});

test("latest reports and pending requests survive more than300 distinct task streams", async () => {
  const rows = Array.from({ length: 301 }, (_, i) => task(`work-${i}`));
  const { service } = await fixture(rows);
  await goal(service, "g", rows.map((row) => row.id));
  await service.update({ action: "report", updateId: "first", taskId: "work-0", sequence: 5, status: "blocked", requiresOperator: true, message: "Still unresolved" }, worker);
  for (let i = 1; i < rows.length; i++) {
    await service.update({ action: "report", updateId: `report-${i}`, taskId: rows[i].id, sequence: 1, status: "working", message: "Other work" }, worker);
  }
  const state = service.snapshot();
  assert.equal(state.reports.length, 301);
  assert.equal(state.reports.find((report) => report.taskId === "work-0").requiresOperator, true);
  assert.ok(state.activity.length <= 100);
  await assert.rejects(service.update({ action: "report", updateId: "old-first", taskId: "work-0", sequence: 4, status: "working", message: "Delayed old result" }, worker), /Stale/);
});

test("goal remapping cleans assignments and retires invalid task alerts without losing guards", async () => {
  const { service, saved } = await fixture([task("a")]);
  await goal(service, "first", ["a"]);
  await service.observe({ id: "worker", type: "subagent.started", agentId: "worker", data: {} });
  await service.update({ action: "assign", agentId: "worker", taskIds: ["a"] }, primary);
  await service.update({ action: "report", taskId: "a", updateId: "old", sequence: 5, status: "blocked", message: "Old scope request", requiresOperator: true }, worker);
  const legacy = structuredClone(saved());
  legacy.goals[0].taskIds = [];
  legacy.goals[0].tasks = [];
  await goal(service, "first", []);
  const state = service.snapshot();
  assert.deepEqual(state.agents.find((entry) => entry.id === "worker").taskIds, []);
  assert.equal(state.reports[0].superseded, true);
  assert.equal(state.reports[0].requiresOperator, false);
  assert.equal(state.reports[0].sequence, 5);
  await goal(service, "second", ["a"]);
  assert.equal(service.snapshot().reports[0].goalId, "first");
  const restored = await createProgressService({
    sessionId: legacy.sessionId,
    store: { load: async () => legacy, save: async () => {} },
    readSources: async () => ({ plan: {}, rows: [task("a")], dependencies: [] }),
  });
  assert.deepEqual(restored.snapshot().agents.find((entry) => entry.id === "worker").taskIds, []);
  assert.equal(restored.snapshot().reports[0].superseded, true);
});

test("native plan approval requests are shown and completed independently of permissions", async () => {
  const { service } = await fixture([]);
  await service.observe({ type: "exit_plan_mode.requested", data: { requestId: "plan", summary: "Approve the implementation plan" } });
  await service.observe({ type: "permission.requested", data: { requestId: "permission" } });
  assert.equal(service.snapshot().attention.find((request) => request.kind === "exit_plan_mode").message, "Approve the implementation plan");
  await service.observe({ type: "exit_plan_mode.completed", data: { requestId: "plan", approved: true } });
  assert.deepEqual(service.snapshot().attention.map((request) => request.kind), ["permission"]);
});

test("known pre-goal request streams remain resolvable after goal activation", async () => {
  const { service } = await fixture([task("a")]);
  await service.update({ action: "report", updateId: "global-primary", sequence: 1, status: "blocked", message: "Planning choice", requiresOperator: true }, primary);
  await service.update({ action: "report", updateId: "global-worker", sequence: 1, status: "blocked", message: "Global input", requiresOperator: true }, worker);
  await goal(service, "g", ["a"]);
  await service.update({ action: "assign", agentId: "worker", taskIds: ["a"] }, primary);
  for (const actor of [primary, worker]) {
    await service.update({ action: "report", goalId: null, updateId: `clear-${actor.id}`, sequence: 2, status: "working", message: "Input resolved" }, actor);
  }
  assert.ok(service.snapshot().reports.every((report) => report.goalId === null && report.requiresOperator === false));
  await assert.rejects(service.update({ action: "report", goalId: null, updateId: "new-global", sequence: 1, status: "working", message: "Ambiguous new origin" }, { id: "new-worker", primary: false }), /goal|unscoped/i);
});

test("existing prior-goal alerts remain resolvable after reassignment without claiming current work", async () => {
  const { service } = await fixture([task("a"), task("b"), task("c")]);
  await goal(service, "first", ["a", "c"]);
  await service.observe({ type: "subagent.started", agentId: "worker", data: {} });
  await service.update({ action: "assign", agentId: "worker", taskIds: ["a"] }, primary);
  for (const taskId of [undefined, "a"]) {
    await service.update({ action: "report", taskId, goalId: "first", updateId: `request-${taskId || "goal"}`,
      sequence: 5, status: "blocked", message: "Need access", requiresOperator: true }, worker);
  }
  await goal(service, "second", ["b"]);
  await service.update({ action: "assign", agentId: "worker", taskIds: ["b"] }, primary);
  await service.update({ action: "report", goalId: "second", updateId: "current",
    sequence: 1, status: "working", message: "Working on second goal" }, worker);
  await service.update({ action: "report", goalId: "first", updateId: "clear-goal",
    sequence: 6, status: "result_ready", message: "Access restored" }, worker);
  await service.update({ action: "report", agentId: "worker", taskId: "a", goalId: "first", updateId: "clear-task",
    sequence: 6, status: "result_ready", message: "Primary verified access restored" }, primary);
  const state = service.snapshot();
  assert.ok(state.reports.filter((report) => report.goalId === "first").every((report) => !report.requiresOperator));
  assert.equal(state.agents.find((member) => member.id === "worker").goalId, "second");
  assert.equal(state.agents.find((member) => member.id === "worker").state, "working");
  assert.equal(state.agents.find((member) => member.id === "worker").report, "Working on second goal");
  await assert.rejects(service.update({ action: "report", goalId: "first", taskId: "c", updateId: "new-conflict",
    sequence: 1, status: "working", message: "Unrelated old work" }, worker), /goal/i);
  await assert.rejects(service.update({ action: "report", goalId: "first", updateId: "stale",
    sequence: 5, status: "blocked", message: "Delayed old request", requiresOperator: true }, worker), /Stale/i);
});
