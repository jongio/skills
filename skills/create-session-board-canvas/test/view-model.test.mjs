import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  activeWorkView, blockerEntries, blockingReportLabel, ciSnapshot, latestReports, leafProgress,
  milestoneProgress, operatorRequests, safeHttpsUrl, scopedReports, scopedTaskReports, sessionBlockerReports,
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

test("reactivating a goal hides requests for removed tasks while preserving current and taskless requests", () => {
  const moved = { id: "moved", status: "pending" };
  const current = { id: "current", status: "pending" };
  const taskMap = new Map([moved, current].map((task) => [task.id, task]));
  const oldRequest = Object.freeze({
    id: "old-A-request", goalId: "A", actorId: "worker", taskId: moved.id,
    sequence: 5, status: "blocked", requiresOperator: true,
  });
  const emptyA = {
    activeGoalId: "A",
    goals: [{ id: "A", taskIds: [] }, { id: "B", taskIds: [moved.id] }],
    reports: [oldRequest],
  };
  assert.deepEqual(operatorRequests(emptyA, new Set(), taskMap), []);

  const currentRequest = Object.freeze({
    id: "current-A-request", goalId: "A", actorId: "worker", taskId: current.id,
    sequence: 1, status: "working", requiresOperator: true,
  });
  const tasklessRequest = Object.freeze({
    id: "taskless-A-request", goalId: "A", actorId: "worker",
    sequence: 1, status: "working", requiresOperator: true,
  });
  const sessionRequest = Object.freeze({
    id: "session-request", goalId: null, actorId: "primary",
    sequence: 1, status: "working", requiresOperator: true,
  });
  const reports = Object.freeze([oldRequest, currentRequest, tasklessRequest, sessionRequest]);
  const model = {
    activeGoalId: "A",
    goals: [{ id: "A", taskIds: [current.id] }, { id: "B", taskIds: [moved.id] }],
    agents: [{ id: "primary", goalId: "A" }],
    reports,
  };
  const snapshot = structuredClone(model);
  assert.deepEqual(operatorRequests(model, new Set([current.id]), taskMap), [
    currentRequest, tasklessRequest, sessionRequest,
  ]);
  assert.deepEqual(latestReports(reports), [...reports]);
  assert.deepEqual(model, snapshot);
  assert.equal(oldRequest.requiresOperator, true);
  assert.equal(oldRequest.goalId, "A");
});

test("explicit null-scope taskless requests survive goal activation and actor reassignment until cleared", () => {
  const request = Object.freeze({
    id: "pre-goal-request", goalId: null, actorId: "worker", taskId: null,
    sequence: 1, status: "blocked", requiresOperator: true,
  });
  const otherGoal = Object.freeze({
    id: "other-goal-request", goalId: "B", actorId: "worker", taskId: null,
    sequence: 5, status: "blocked", requiresOperator: true,
  });
  const reports = [request, otherGoal];
  assert.deepEqual(operatorRequests({ activeGoalId: null, reports }, new Set(), new Map()), [request]);
  const active = { activeGoalId: "A", agents: [{ id: "worker", goalId: "B" }], reports };
  assert.deepEqual(operatorRequests(active, new Set(), new Map()), [request]);
  assert.deepEqual(operatorRequests({ ...active, agents: [] }, new Set(), new Map()), [request]);
  const cleared = { ...request, id: "pre-goal-cleared", sequence: 2, status: "working", requiresOperator: false };
  assert.deepEqual(operatorRequests({ ...active, reports: [...reports, cleared] }, new Set(), new Map()), []);
  assert.deepEqual(latestReports([...reports, cleared]), [cleared, otherGoal]);
  assert.equal(request.requiresOperator, true);
});

test("native plan approval attention is visible without task assignment and clears when removed", () => {
  const appUrl = new URL("../runtime/web/app.mjs", import.meta.url).href;
  // Load the existing browser-only helper with transport stubs, without copying its projection.
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", `
    import { readFile } from "node:fs/promises";
    import { SourceTextModule, SyntheticModule } from "node:vm";
    const appUrl = ${JSON.stringify(appUrl)};
    const kit = new SyntheticModule(["html", "mountCanvas", "useState", "Icon"], function () {
      for (const name of ["html", "mountCanvas", "useState", "Icon"]) this.setExport(name, () => null);
    });
    const source = await readFile(new URL(appUrl), "utf8");
    const app = new SourceTextModule(source + "\\nexport { operatorAttention };", { identifier: appUrl });
    await app.link(async (specifier) => {
      if (specifier === "/kit/core-client.mjs" || specifier === "/kit/icons.mjs") return kit;
      if (specifier !== "./view-model.mjs") throw new Error("Unexpected UI dependency: " + specifier);
      const url = new URL(specifier, appUrl);
      return new SourceTextModule(await readFile(url, "utf8"), { identifier: url.href });
    });
    await app.evaluate();
    const state = {
      activeGoalId: "active",
      goals: [{ id: "active", taskIds: [], tasks: [] }],
      tasks: [], agents: [], reports: [],
      attention: [{
        id: "exit_plan_mode:plan", kind: "exit_plan_mode",
        message: "Approve the plan", at: "2026-10-27T19:00:00Z",
      }],
    };
    console.log(JSON.stringify({
      pending: app.namespace.operatorAttention(state),
      cleared: app.namespace.operatorAttention({ ...state, attention: [] }),
    }));
  `], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), {
    pending: [{
      id: "event:exit_plan_mode:plan", title: "Exit plan mode",
      message: "Approve the plan", at: "2026-10-27T19:00:00Z",
    }],
    cleared: [],
  });
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
  const entries = blockerEntries([task], [], taskMap, reports, { selectedGoalId: "B" });
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

test("moved tasks use selected-goal reports and session-wide views use explicit current membership", () => {
  const task = { id: "moved", title: "Moved work", status: "pending" };
  const taskMap = new Map([[task.id, task]]);
  const goals = [
    { id: "A", taskIds: [], tasks: [{ ...task }] },
    { id: "B", taskIds: [task.id], tasks: [task] },
  ];
  const previous = { id: "a-blocker", goalId: "A", actorId: "worker", taskId: task.id, sequence: 5, status: "blocked", requiresOperator: true };
  const current = { id: "b-working", goalId: "B", actorId: "worker", taskId: task.id, sequence: 1, status: "working", requiresOperator: false };
  const selectedB = { selectedGoalId: "B", goals, taskMap };
  const session = { goals, taskMap, activeGoalId: "A" };
  const historicalA = { selectedGoalId: "A", goals, taskMap };

  assert.deepEqual(scopedTaskReports([previous], task.id, selectedB), []);
  assert.deepEqual(scopedTaskReports([previous], task.id, session), []);
  assert.deepEqual(blockerEntries([task], [], taskMap, [previous], selectedB), []);
  assert.deepEqual(blockerEntries([task], [], taskMap, [previous], session), []);

  const reports = [previous, current];
  assert.deepEqual(scopedTaskReports(reports, task.id, selectedB), [current]);
  assert.deepEqual(scopedTaskReports(reports, task.id, session), [current]);
  assert.deepEqual(blockerEntries([task], [], taskMap, reports, selectedB), []);
  assert.deepEqual(blockerEntries([task], [], taskMap, reports, session), []);
  assert.deepEqual(scopedTaskReports(reports, task.id, historicalA), [previous]);
  assert.deepEqual(blockerEntries([task], [], taskMap, reports, historicalA)[0].reports, [previous]);
  assert.deepEqual(operatorRequests({ activeGoalId: "B", goals, tasks: [task], reports }, new Set([task.id]), taskMap), []);
  assert.deepEqual(latestReports(reports), [previous, current]);
  assert.equal(previous.status, "blocked");
  assert.equal(previous.requiresOperator, true);
});

test("explicit task goal metadata scopes session-wide reports without using the active goal", () => {
  const taskMap = new Map([["task", { id: "task", goalId: "B" }]]);
  const previous = { goalId: "A", actorId: "worker", taskId: "task", status: "failed" };
  const current = { goalId: "B", actorId: "worker", taskId: "task", status: "working" };
  assert.deepEqual(scopedTaskReports([previous, current], "task", { taskMap, activeGoalId: "A" }), [current]);
});

test("superseded latest task and taskless reports suppress older live versions without losing history", () => {
  const task = { id: "task", status: "pending" };
  const taskMap = new Map([[task.id, task]]);
  const scope = { selectedGoalId: "A", goals: [{ id: "A", taskIds: [task.id] }], taskMap };
  const older = { id: "older-task", goalId: "A", actorId: "former-owner", taskId: task.id, sequence: 1, status: "blocked", requiresOperator: true };
  const superseded = { ...older, id: "superseded-task", sequence: 2, status: "failed", superseded: true };
  const olderSession = { ...older, id: "older-session", taskId: null };
  const supersededSession = { ...superseded, id: "superseded-session", taskId: null };
  const reports = [superseded, older, supersededSession, olderSession];
  assert.deepEqual(latestReports(reports), [superseded, supersededSession]);
  assert.deepEqual(scopedReports(reports, scope), []);
  assert.deepEqual(scopedTaskReports(reports, task.id, scope), []);
  assert.deepEqual(blockerEntries([task], [], taskMap, reports, scope), []);
  assert.deepEqual(sessionBlockerReports(reports, "A"), []);
  assert.deepEqual(operatorRequests({ activeGoalId: "A", reports }, new Set([task.id]), taskMap), []);
  assert.equal(reports.length, 4);
  assert.equal(older.superseded, undefined);
  assert.equal(olderSession.requiresOperator, true);
});

for (const { done, total, expected } of [
  { done: 29, total: 100, expected: 29 },
  { done: 999, total: 1000, expected: 99 },
  { done: 100, total: 100, expected: 100 },
  { done: 0, total: 0, expected: null },
]) {
  test(`header and descendant rollup percentages are exact for ${done}/${total}`, () => {
    const leaves = Array.from({ length: total }, (_, index) => ({
      id: `leaf-${index}`, status: index < done ? "done" : "pending", childIds: [],
    }));
    const branch = { id: "branch", status: "done", childIds: leaves.map((task) => task.id) };
    const root = { id: "root", status: "done", childIds: total ? [branch.id] : [] };
    const taskMap = new Map([root, branch, ...leaves].map((task) => [task.id, task]));
    const header = leafProgress(total ? [root, branch, ...leaves] : []);
    const rollup = milestoneProgress(root, taskMap);
    assert.equal(header.done, done);
    assert.equal(header.total, total);
    assert.equal(header.percent, expected);
    assert.equal(rollup.done, done);
    assert.equal(rollup.total, total);
    assert.equal(rollup.percent, expected);
  });
}

test("incomplete rollups use multiply-first arithmetic and preserve unknown percentages", () => {
  const missing = { id: "root", childIds: ["missing"] };
  const provided = { ...missing, subtaskProgress: { done: 29, total: 100, percent: 29 } };
  assert.equal(milestoneProgress(provided, new Map()).percent, 29);
  assert.equal(milestoneProgress(missing, new Map()).percent, null);
  assert.equal(milestoneProgress({
    ...provided, subtaskProgress: { done: 29, total: 100, percent: null },
  }, new Map()).percent, null);
  assert.equal(milestoneProgress({
    ...provided, subtaskProgress: { done: 0, total: 0, percent: null },
  }, new Map()).percent, null);
});

test("active work links allow only absolute credential-free HTTPS URLs", () => {
  assert.equal(safeHttpsUrl("https://github.com/owner/repo/pull/193"), "https://github.com/owner/repo/pull/193");
  for (const url of [
    "javascript:alert(1)", "http://github.com/owner/repo/issues/1", "data:text/html,test",
    "file:///private", "//github.com/owner/repo/pull/193", "/owner/repo/pull/193",
    "https://user:password@github.com/owner/repo/pull/193", "https://github.com/\nunsafe",
    "not a URL", null,
  ]) assert.equal(safeHttpsUrl(url), null);
});

test("active work shows strictly owned references, text titles, explicit states, and safe links", () => {
  const work = activeWorkView({
    prs: [
      { reference: "owner/repo#193", owned: true, title: "<img src=x onerror=alert(1)>", state: "OPEN", url: "https://github.com/owner/repo/pull/193" },
      { reference: "owner/repo#194", owned: false },
      { reference: "owner/repo#195", owned: "true" },
    ],
    issues: [
      { reference: "owner/repo#1", owned: true, state: "CLOSED", url: "javascript:alert(1)" },
      { reference: "owner/repo#2", title: "Not owned" },
    ],
  });
  assert.equal(work.prs.length, 1);
  assert.equal(work.prs[0].title, "<img src=x onerror=alert(1)>");
  assert.equal(work.prs[0].state, "OPEN");
  assert.equal(work.issues.length, 1);
  assert.equal(work.issues[0].state, "CLOSED");
  assert.equal(work.issues[0].url, null);
  assert.equal(work.prs[0].ci.status, "unknown");
});

test("empty issues are confirmed absent only by a verified, known issue source", () => {
  assert.equal(activeWorkView({ source: { status: "verified", known: { issues: true } } }).emptyIssues, "No session-owned issues.");
  for (const status of ["unknown", "partial", "unavailable"]) {
    const work = activeWorkView({ source: { status, known: { issues: true } } });
    assert.equal(work.issues.length, 0);
    assert.doesNotMatch(work.emptyIssues, /^No session-owned/);
  }
  assert.doesNotMatch(activeWorkView({ source: { status: "verified", known: { issues: false } } }).emptyIssues, /^No session-owned/);
  assert.doesNotMatch(activeWorkView().emptyIssues, /^No session-owned/);
});

test("missing and zero-check CI snapshots are unknown, never zero-of-zero green", () => {
  for (const pr of [
    {},
    { headRefOid: "current" },
    { headRefOid: "current", ci: { status: "passed", passed: 0, total: 0 } },
    { headRefOid: "current", ci: { status: "passed", headRefOid: "current", passed: 0, total: 0 } },
  ]) {
    const ci = ciSnapshot(pr);
    assert.equal(ci.status, "unknown");
    assert.equal(ci.passed, null);
    assert.equal(ci.total, null);
  }
});

test("CI for another head is unverified even when it reports passing checks", () => {
  const ci = ciSnapshot({
    headRefOid: "new-head",
    ci: { status: "passed", headRefOid: "old-head", passed: 8, total: 8, observedAt: "2026-10-27T18:00:00Z" },
  });
  assert.equal(ci.status, "unknown");
  assert.equal(ci.headVerified, false);
  assert.equal(ci.prHead, "new-head");
  assert.equal(ci.ciHead, "old-head");
  assert.match(ci.reason, /does not match/);
  assert.equal(ci.observedAt, "2026-10-27T18:00:00Z");
});

test("matching CI snapshots preserve status, counts, pending and failed check names", () => {
  const passed = ciSnapshot({ headRefOid: "head", ci: { status: "passed", headRefOid: "head", passed: 8, total: 8 } });
  assert.equal(passed.status, "passed");
  assert.equal(passed.headVerified, true);
  assert.equal(passed.passed, 8);
  assert.equal(passed.total, 8);
  const failed = ciSnapshot({
    headRefOid: "head",
    ci: { status: "failed", headRefOid: "head", passed: 3, total: 5, pendingChecks: ["Browser tests"], failedChecks: [{ name: "Lint" }] },
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.pendingChecks, ["Browser tests"]);
  assert.deepEqual(failed.failedChecks, ["Lint"]);
  assert.equal(ciSnapshot({ headRefOid: "head", ci: { status: "unknown", headRefOid: "head", passed: 8, total: 8 } }).status, "unknown");
  assert.equal(ciSnapshot({ headRefOid: "head", ci: { status: "passed", headRefOid: "head", passed: 3, total: 5 } }).status, "unknown");
});

test("active references and failed CI never create implicit operator requests", () => {
  const model = {
    references: {
      prs: [{ reference: "owner/repo#193", owned: true, state: "OPEN", headRefOid: "head", ci: { status: "failed", headRefOid: "head" } }],
      issues: [],
      source: { status: "partial", updatedAt: "2026-10-27T18:00:00Z", error: "Issues not observed yet", known: { prs: true, issues: false } },
    },
  };
  const work = activeWorkView(model.references);
  assert.equal(work.prs[0].ci.status, "failed");
  assert.equal(work.source.status, "partial");
  assert.equal(work.source.error, "Issues not observed yet");
  assert.deepEqual(operatorRequests(model, new Set(), new Map()), []);
});
