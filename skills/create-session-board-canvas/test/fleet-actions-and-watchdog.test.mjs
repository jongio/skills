import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasRuntime } from "../runtime/canvas-kit/server.mjs";
import { attachCanvasLifecycle, createProgressCanvas } from "../runtime/canvas.mjs";
import { createFleetService } from "../runtime/fleet-service.mjs";
import { createProgressService } from "../runtime/progress.mjs";
import { acquireFleetLeader, createRecoveryWatchdog } from "../runtime/watchdog.mjs";

function memoryStore(initial = null) {
  let state = initial;
  return {
    load: async (fallback = null) => (state ? structuredClone(state) : fallback),
    save: async (next) => { state = structuredClone(next); },
  };
}

test("fleet aggregator rolls up projects with leaf-only progress, deduplicates CLI/desktop sessions, and flags coordinator scoping", async (t) => {
  const fleetService = createFleetService({
    hostSessionId: "coord-1",
    executeHostTool: async (name) => {
      if (name === "list_repositories") {
        return [{ id: "proj-1", name: "skills", github_repo: "jongio/skills", default_branch: "main" }];
      }
      if (name === "list_sessions_and_chats") {
        return [
          { id: "sess-a", name: "Feature A", repo_full_name: "jongio/skills", branch: "feat-a", app_url: "ghapp://sessions/sess-a", pr_number: 101, pr_url: "https://github.com/jongio/skills/pull/101" },
          { id: "sess-b", name: "Unscoped sibling", repo_full_name: "jongio/skills", branch: "feat-b", app_url: "ghapp://sessions/sess-b" },
          { id: "chat-1", name: "Design chat", session_kind: "chat", app_url: "ghapp://sessions/chat-1" },
        ];
      }
      if (name === "get_sessions_status") {
        // Simulates a Persistent Project coordinator receiving only its own + coordinated child status.
        return [
          {
            id: "sess-a",
            activity: "waiting",
            mode: "interactive",
            awaiting_input: {
              request_id: "req-ask-1",
              question: "Which cache strategy?",
              choices: ["LRU", "TTL"],
              allow_freeform: false,
            },
          },
        ];
      }
      if (name === "list_workflows") {
        return [{ id: "wf-1", name: "CI Sweep", enabled: true, project_id: "proj-1" }];
      }
      return [];
    },
    workerClient: {
      scan: async () => ({
        sessions: [
          {
            id: "sess-a",
            repository: "jongio/skills",
            branch: "feat-a",
            clientName: "github/autopilot",
            todos: [
              { id: "parent", title: "Milestone", status: "in_progress" },
              { id: "leaf-1", title: "Step 1", status: "done" },
              { id: "leaf-2", title: "Step 2", status: "in_progress" },
            ],
            dependencies: [],
            board: {
              hierarchy: [{ parentId: "parent", childIds: ["leaf-1", "leaf-2"] }],
              agents: [{ id: "primary", role: "primary", state: "working" }, { id: "sub-1", role: "subagent", name: "explore", state: "completed" }],
            },
          },
          {
            id: "cli-only-1",
            repository: "jongio/skills",
            branch: "cli-branch",
            clientName: "github/cli",
            name: "Terminal debug",
            lockState: { alive: true, pid: 4444 },
            todos: [{ id: "c1", title: "CLI check", status: "done" }],
            dependencies: [],
          },
        ],
        prCache: {
          "https://github.com/jongio/skills/pull/101": { status: "passed", passed: 5, total: 5 },
        },
        stats: {},
      }),
      stop: async () => {},
      isRunning: () => false,
    },
  });
  t.after(() => fleetService.shutdown());

  const state = await fleetService.refreshFleet();
  assert.equal(state.coordinatorScoped, true);
  // sess-a is deduplicated (not listed twice), plus sess-b, chat-1, cli-only-1 => 4 total sessions.
  assert.equal(state.sessions.length, 4);

  const skillsProject = state.projects.find((p) => p.key === "jongio/skills");
  assert.ok(skillsProject);
  // Leaf-only progress across sess-a (1/2 leaves; parent excluded!) + cli-only-1 (1/1 leaf) = 2/3 leaves = 66%.
  assert.deepEqual(skillsProject.taskProgress, { done: 2, total: 3, percent: 66 });
  assert.equal(state.inbox.length, 1);
  assert.equal(state.inbox[0].kind, "ask_user");
  assert.equal(state.inbox[0].requestId, "req-ask-1");
});

test("operator actions validate choices, degrade uncoordinated plan approvals to deep links, and route self/peer messages safely", async (t) => {
  const calls = [];
  const hostPrompts = [];
  const fleetService = createFleetService({
    hostSessionId: "host-self",
    askHostAgent: async (prompt) => { hostPrompts.push(prompt); },
    executeHostTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "list_sessions_and_chats") {
        return [
          { id: "peer-ask", name: "Peer Ask" },
          { id: "peer-plan-root", name: "Root Plan" },
          { id: "peer-plan-child", name: "Child Plan" },
          { id: "peer-idle", name: "Idle Peer" },
          { id: "host-self", name: "Self" },
        ];
      }
      if (name === "get_sessions_status") {
        return [
          {
            id: "peer-ask",
            activity: "waiting",
            awaiting_input: { request_id: "r-1", question: "Pick DB", choices: ["Postgres", "SQLite"], allow_freeform: false },
          },
          {
            id: "peer-plan-root",
            activity: "waiting",
            pending_plan: { request_id: "plan-root-1", summary: "Root plan summary" },
          },
          {
            id: "peer-plan-child",
            activity: "waiting",
            pending_plan: { request_id: "plan-child-1", summary: "Child plan summary" },
          },
          { id: "peer-idle", activity: "idle", mode: "interactive" },
        ];
      }
      if (name === "respond_to_session_plan_v2" && args.project_session_id === "peer-plan-root") {
        throw new Error("Session peer-plan-root is not a coordinated child of host-self");
      }
      return { ok: true };
    },
    workerClient: {
      scan: async () => ({ sessions: [], stats: {} }),
      stop: async () => {},
      isRunning: () => false,
    },
  });
  t.after(() => fleetService.shutdown());
  await fleetService.refreshFleet();

  // Invalid choice rejected before calling host tool.
  await assert.rejects(
    fleetService.answerInput({ targetSessionId: "peer-ask", requestId: "r-1", answer: "MongoDB" }),
    /must match one of the allowed choices/i,
  );

  // Valid choice invokes answer_session_input with exact request_id.
  const answered = await fleetService.answerInput({ targetSessionId: "peer-ask", requestId: "r-1", answer: "SQLite" });
  assert.equal(answered.ok, true);
  assert.deepEqual(calls.find((c) => c.name === "answer_session_input")?.args, {
    project_session_id: "peer-ask",
    request_id: "r-1",
    answer: "SQLite",
  });

  // Sending a plain message while blocked on ask_user fails closed so the operator answers the prompt first.
  await assert.rejects(
    fleetService.sendMessage({ targetSessionId: "peer-ask", message: "Continue anyway" }),
    /blocked on an input question/i,
  );

  // Uncoordinated root plan approval cleanly returns deep-link fallback instead of crashing.
  const rootPlanResult = await fleetService.respondPlan({
    targetSessionId: "peer-plan-root",
    requestId: "plan-root-1",
    approved: true,
    selectedAction: "autopilot",
  });
  assert.equal(rootPlanResult.ok, false);
  assert.equal(rootPlanResult.requiresDeepLink, true);
  assert.equal(rootPlanResult.deepLink, "ghapp://sessions/peer-plan-root");

  // Coordinated child plan approval succeeds directly.
  const childPlanResult = await fleetService.respondPlan({
    targetSessionId: "peer-plan-child",
    requestId: "plan-child-1",
    approved: true,
    selectedAction: "autopilot",
  });
  assert.equal(childPlanResult.ok, true);

  // Peer message uses send_session_message; self message uses askHostAgent.
  await fleetService.sendMessage({ targetSessionId: "peer-idle", message: "Resume tests", deliveryMode: "enqueue", mode: "autopilot" });
  assert.deepEqual(calls.find((c) => c.name === "send_session_message")?.args, {
    session_id: "peer-idle",
    message: "Resume tests",
    delivery_mode: "enqueue",
    mode: "autopilot",
  });
  await fleetService.sendMessage({ targetSessionId: "host-self", message: "Check local status" });
  assert.deepEqual(hostPrompts, ["Check local status"]);
});

test("recovery watchdog enforces off-by-default, 60s grace window, non-retryable exclusions, progress-gated 3-strike breaker, and pipe leader lease", async () => {
  let currentMs = Date.parse("2026-11-11T12:00:00.000Z");
  const dispatched = [];

  const leaderOne = await acquireFleetLeader("test-leader-scope-" + process.pid);
  assert.ok(leaderOne);
  const leaderTwo = await acquireFleetLeader("test-leader-scope-" + process.pid);
  assert.equal(leaderTwo, null);
  await leaderOne.close();

  const watchdog = await createRecoveryWatchdog({
    store: memoryStore(),
    now: () => currentMs,
    graceMs: 60_000,
    baseBackoffMs: 10_000,
    maxRetries: 3,
    isLeader: () => true,
    recoverSession: async (action) => { dispatched.push(action); },
  });

  // 1. Default policy is "off": zero automatic recoveries.
  assert.equal(watchdog.getPolicy(), "off");
  const candidate = {
    id: "auto-1",
    surface: "desktop",
    mode: "autopilot",
    activity: "idle",
    wasInterrupted: true,
    interruptionReason: "stream reset",
    failedAtMs: currentMs - 120_000,
    incompleteLeafCount: 2,
    progressFingerprint: "turns:1|done:0|head:aaa",
  };
  await watchdog.evaluate([candidate]);
  assert.equal(dispatched.length, 0);

  // 2. Enable "autopilot_only": ignores interactive sessions and respects 60s grace window.
  await watchdog.setPolicy("autopilot_only");
  await watchdog.evaluate([
    { ...candidate, id: "interactive-1", mode: "interactive" },
    { ...candidate, id: "too-fresh", failedAtMs: currentMs - 30_000 },
    { ...candidate, id: "auth-blocked", interruptionReason: "401 Unauthorized MCP OAuth token expired" },
    { ...candidate, id: "trust-blocked", interruptionReason: "Repository trust required" },
    { ...candidate, id: "user-aborted", interruptionReason: "User cancelled turn (abort)" },
    { ...candidate, id: "waiting-input", awaitingInput: { requestId: "r1", question: "?" } },
  ]);
  assert.equal(dispatched.length, 0);

  // 3. Eligible stalled autopilot session recovers up to 3 times, then trips circuit breaker if progress does not advance.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    currentMs += 120_000;
    await watchdog.evaluate([candidate]);
  }
  assert.equal(dispatched.length, 3);
  assert.equal(watchdog.snapshot().entries["auto-1"].circuitOpen, true);

  // 4. Advancing progressFingerprint resets circuit breaker and retry counter.
  currentMs += 120_000;
  await watchdog.evaluate([{
    ...candidate,
    failedAtMs: currentMs - 90_000,
    progressFingerprint: "turns:2|done:1|head:bbb",
  }]);
  assert.equal(dispatched.length, 4);
  assert.equal(watchdog.snapshot().entries["auto-1"].attempts, 1);
  assert.equal(watchdog.snapshot().entries["auto-1"].circuitOpen, false);
});

test("HTTP capability token gates all fleet operator actions and serves unified web assets", async (t) => {
  const progressService = await createProgressService({
    sessionId: "cap-host",
    store: memoryStore(),
    readSources: async () => ({ plan: { exists: false, content: null }, rows: [], dependencies: [] }),
  });
  const watchdog = await createRecoveryWatchdog({
    store: memoryStore(),
    isLeader: () => true,
  });
  const fleetService = createFleetService({
    hostSessionId: "cap-host",
    watchdog,
    executeHostTool: async () => [],
    workerClient: {
      scan: async () => ({ sessions: [], stats: {} }),
      stop: async () => {},
      isRunning: () => false,
    },
  });
  t.after(() => fleetService.shutdown());

  const canvasConfig = createProgressCanvas(progressService, "cap-host", { fleetService });
  const runtime = attachCanvasLifecycle(createCanvasRuntime(canvasConfig), canvasConfig);
  t.after(() => runtime.shutdown());

  const opened = await runtime.openInstance({
    instanceId: "fleet-panel",
    input: { scope: "fleet" },
    ctx: { sessionId: "cap-host" },
  });
  assert.equal(fleetService.isPolling(), true);

  // Unauthenticated action requests are rejected with 403.
  const noCapAction = new URL("/action", opened.url);
  const denied = await fetch(noCapAction, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionName: "set_recovery_policy", input: { policy: "autopilot_only" } }),
  });
  assert.equal(denied.status, 403);

  // Capability-authenticated fleet actions succeed.
  const capAction = new URL("/action", opened.url);
  capAction.search = new URL(opened.url).search;
  const allowed = await fetch(capAction, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionName: "set_recovery_policy", input: { policy: "autopilot_only" } }),
  });
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.equal(body.ok, true);
  assert.equal(body.result.policy, "autopilot_only");

  // All browser assets resolve cleanly over HTTP 200.
  for (const assetPath of ["/", "/app.mjs", "/fleet-view.mjs", "/deeplinks.mjs", "/style.css", "/kit/core-client.mjs", "/kit/icons.mjs"]) {
    const assetRes = await fetch(new URL(assetPath, opened.url));
    assert.equal(assetRes.status, 200, `expected 200 for ${assetPath}`);
  }
});

