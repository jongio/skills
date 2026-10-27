import assert from "node:assert/strict";
import test from "node:test";
import {
  blockerEntries, blockingReportLabel, latestReports, operatorRequests, sessionBlockerReports,
} from "../runtime/web/view-model.mjs";

test("report sequences are independent per goal, actor, and task", () => {
  const goalA = { id: "a5", goalId: "A", actorId: "worker", taskId: "task", sequence: 5, status: "blocked" };
  const goalB = { id: "b1", goalId: "B", actorId: "worker", taskId: "task", sequence: 1, status: "working" };
  assert.deepEqual(latestReports([goalA, goalB]), [goalA, goalB]);
  const newerA = { ...goalA, id: "a6", sequence: 6, status: "working" };
  assert.deepEqual(latestReports([newerA, goalB, goalA]), [newerA, goalB]);
});

for (const goalId of [null, undefined]) {
  test(`operator requests without a goal are visible before a goal is active (${goalId})`, () => {
    const request = { id: "permission", goalId, actorId: "worker", status: "working", requiresOperator: true };
    const model = { activeGoalId: null, reports: [request] };
    assert.deepEqual(operatorRequests(model, new Set(), new Map()), [request]);
  });
}

test("goal-scoped operator requests are hidden before a goal is active", () => {
  const model = {
    reports: [{ goalId: "old-goal", actorId: "worker", status: "blocked", requiresOperator: true }],
  };
  assert.deepEqual(operatorRequests(model, new Set(), new Map()), []);
});

test("the originating goal controls operator request visibility, not the actor's current goal", () => {
  const previous = { goalId: "A", actorId: "worker", sequence: 5, status: "blocked", requiresOperator: true };
  const current = { goalId: "B", actorId: "worker", sequence: 1, status: "working", requiresOperator: true };
  const model = {
    activeGoalId: "B",
    agents: [{ id: "worker", goalId: "B" }],
    reports: [previous, current],
  };
  assert.deepEqual(operatorRequests(model, new Set(), new Map()), [current]);
});

test("newer reports clear operator requests, including null/undefined session scopes", () => {
  const model = {
    reports: [
      { goalId: null, actorId: "worker", sequence: 5, status: "working", requiresOperator: false, at: "2026-10-27T16:00:00Z" },
      { actorId: "worker", sequence: 4, status: "blocked", requiresOperator: true, at: "2026-10-27T17:00:00Z" },
    ],
  };
  assert.deepEqual(operatorRequests(model, new Set(), new Map()), []);
});

test("done-task requests, ordinary blockers, and non-boolean operator flags stay out of attention", () => {
  const done = { id: "done", status: "done" };
  const reports = [
    { actorId: "done-worker", taskId: "done", status: "blocked", requiresOperator: true },
    { actorId: "blocked-worker", status: "blocked" },
    { actorId: "failed-worker", status: "failed", requiresOperator: false },
    { actorId: "ready-worker", status: "result_ready" },
    { actorId: "string-worker", status: "working", requiresOperator: "true" },
  ];
  assert.deepEqual(operatorRequests({ reports }, new Set(["done"]), new Map([["done", done]])), []);
  assert.equal(done.status, "done");
});

test("task-bound and taskless failures are visible with failed labels, without operator inference", () => {
  const task = { id: "task", title: "Work", status: "pending" };
  const taskMap = new Map([[task.id, task]]);
  const taskFailure = { id: "task-failure", goalId: "B", actorId: "task-worker", taskId: "task", status: "failed" };
  const sessionFailure = { id: "session-failure", goalId: "B", actorId: "session-worker", status: "failed" };
  const reports = [taskFailure, sessionFailure];
  const entries = blockerEntries([task], [], taskMap, reports);
  const taskless = sessionBlockerReports(reports, "B");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].task.status, "pending");
  assert.deepEqual(entries[0].reports, [taskFailure]);
  assert.deepEqual(taskless, [sessionFailure]);
  assert.deepEqual([...entries[0].reports, ...taskless].map((report) => ({
    id: report.id, status: report.status, label: blockingReportLabel(report),
  })), [
    { id: "task-failure", status: "failed", label: "Failed report" },
    { id: "session-failure", status: "failed", label: "Failed report" },
  ]);
  assert.deepEqual(operatorRequests({ activeGoalId: "B", reports }, new Set(["task"]), taskMap), []);
  assert.equal(task.status, "pending");
});

test("taskless failures respect the selected goal and failure requests still require an explicit flag", () => {
  const previous = { id: "old", goalId: "A", actorId: "worker", sequence: 5, status: "failed", requiresOperator: true };
  const current = { id: "new", goalId: "B", actorId: "worker", sequence: 1, status: "failed", requiresOperator: true };
  const reports = [previous, current];
  assert.deepEqual(sessionBlockerReports(reports, "B"), [current]);
  assert.deepEqual(operatorRequests({ activeGoalId: "B", reports }, new Set(), new Map()), [current]);
});

test("newer recovered reports clear task-bound and taskless failures", () => {
  const task = { id: "task", status: "pending" };
  const taskMap = new Map([[task.id, task]]);
  const reports = [
    { goalId: "B", actorId: "worker", taskId: "task", sequence: 1, status: "failed" },
    { goalId: "B", actorId: "worker", taskId: "task", sequence: 2, status: "working" },
    { goalId: "B", actorId: "worker", sequence: 1, status: "failed" },
    { goalId: "B", actorId: "worker", sequence: 2, status: "working" },
  ];
  assert.deepEqual(blockerEntries([task], [], taskMap, reports), []);
  assert.deepEqual(sessionBlockerReports(reports, "B"), []);
});

test("canonical blockers, unresolved dependencies, and blocked labels are preserved", () => {
  const blocked = { id: "blocked", status: "blocked" };
  const waiting = { id: "waiting", status: "pending", waitingOn: ["external", "finished"] };
  const external = { id: "external", status: "in_progress" };
  const finished = { id: "finished", status: "done" };
  const taskMap = new Map([blocked, waiting, external, finished].map((task) => [task.id, task]));
  const entries = blockerEntries([blocked, waiting], [], taskMap, []);
  assert.deepEqual(entries.map((entry) => ({ id: entry.task.id, waiting: entry.waiting })), [
    { id: "blocked", waiting: [] },
    { id: "waiting", waiting: ["external"] },
  ]);
  const report = { actorId: "worker", status: "blocked" };
  assert.deepEqual(sessionBlockerReports([report]), [report]);
  assert.equal(blockingReportLabel(report), "Blocked report");
});
