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
          { id: "sess-a", name: "Feature A", repo_full_name: "jongio/skills", branch: "feat-a", app_url: "ghapp://sessions/sess-a", pr_number: 101, pr_url: "https://github.com/jongio/skills/pull/101", pr_head_sha: "a".repeat(40) },
          { id: "sess-b", name: "Unscoped sibling", repo_full_name: "jongio/skills", branch: "feat-b", app_url: "ghapp://sessions/sess-b", pr_number: 102, pr_url: "https://github.com/jongio/skills/pull/102", pr_head_sha: "c".repeat(40) },
          { id: "sess-null-check", name: "Null Conclusion PR", repo_full_name: "jongio/skills", branch: "feat-c", pr_number: 103, pr_url: "https://github.com/jongio/skills/pull/103", pr_head_sha: "d".repeat(40) },
          { id: "archived-mc-alias", name: "Archived Session", repo_full_name: "jongio/skills", archived_at: "2026-11-10T00:00:00Z" },
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
              references: {
                prs: [{
                  url: "https://github.com/jongio/skills/pull/101",
                  reference: "jongio/skills#101",
                  title: "Old title",
                  state: "OPEN",
                  headRefOid: "a".repeat(40),
                  ci: { status: "unknown", headRefOid: "a".repeat(40), observedAt: "2026-11-11T00:00:00Z" },
                }],
              },
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
          {
            id: "local-archived-dir",
            mcSessionId: "archived-mc-alias",
            repository: "jongio/skills",
            clientName: "github/autopilot",
            todos: [{ id: "old", title: "Should be excluded", status: "in_progress" }],
            dependencies: [],
          },
          {
            id: "truncated-cli",
            repository: "jongio/other",
            clientName: "github/cli",
            todos: [{ id: "t-done", title: "Done sample", status: "done" }],
            todosTruncated: true,
            dependencies: [],
          },
        ],
        prCache: {
          "https://github.com/jongio/skills/pull/101": {
            checkedAt: Date.now(),
            info: {
              state: "MERGED",
              title: "Unified board",
              headRefOid: "a".repeat(40),
              statusCheckRollup: [
                { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
                { name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
                { context: "vally", state: "SUCCESS" },
              ],
            },
          },
          "https://github.com/jongio/skills/pull/102": {
            checkedAt: Date.now(),
            info: {
              state: "OPEN",
              headRefOid: "b".repeat(40), // Stale head != pr_head_sha ("c"*40) => CI must be cleared to unknown!
              statusCheckRollup: [{ name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }],
            },
          },
          "https://github.com/jongio/skills/pull/103": {
            checkedAt: Date.now(),
            info: {
              state: "OPEN",
              headRefOid: "d".repeat(40),
              statusCheckRollup: [
                { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
                { name: "mystery", status: "COMPLETED", conclusion: null }, // Null conclusion must count in total & keep CI unknown!
              ],
            },
          },
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
  // Archived local alias ("local-archived-dir") is excluded; sess-a, sess-b, sess-null-check, chat-1, cli-only-1, truncated-cli => 6 sessions.
  assert.equal(state.sessions.some((s) => s.id === "local-archived-dir" || s.id === "archived-mc-alias"), false);
  assert.equal(state.sessions.length, 6);
  const nullCheckPr = state.sessions.find((s) => s.id === "sess-null-check")?.prs[0];
  assert.equal(nullCheckPr?.ciStatus, "unknown");
  assert.equal(nullCheckPr?.ciPassed, 1);
  assert.equal(nullCheckPr?.ciTotal, 2);
  const truncatedSess = state.sessions.find((s) => s.id === "truncated-cli");
  assert.equal(truncatedSess?.taskProgress.percent, null);
  assert.ok((truncatedSess?.incompleteLeafCount || 0) >= 1);

  const skillsProject = state.projects.find((p) => p.key === "jongio/skills");
  assert.ok(skillsProject);
  // Leaf-only progress across sess-a (1/2 leaves; parent excluded!) + cli-only-1 (1/1 leaf) = 2/3 leaves = 66%.
  assert.deepEqual(skillsProject.taskProgress, { done: 2, total: 3, percent: 66 });
  const mergedPr = skillsProject.sessions.find((s) => s.id === "sess-a")?.prs[0];
  assert.equal(mergedPr?.state, "MERGED");
  assert.equal(mergedPr?.ciStatus, "passed");
  assert.equal(mergedPr?.ciPassed, 3);
  assert.equal(mergedPr?.ciTotal, 3);
  const mismatchedHeadPr = skillsProject.sessions.find((s) => s.id === "sess-b")?.prs[0];
  assert.equal(mismatchedHeadPr?.ciStatus, "unknown");
  assert.equal(mismatchedHeadPr?.ciPassed, null);
  assert.equal(mismatchedHeadPr?.ciTotal, null);
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

  // Unattributed or subagent callers cannot open fleet-scoped panels.
  await assert.rejects(
    runtime.openInstance({ instanceId: "unattributed", input: { scope: "fleet" }, ctx: { sessionId: "cap-host" } }),
    /attribution unavailable/i,
  );
  await assert.rejects(
    runtime.openInstance({ instanceId: "sub-open", input: { scope: "fleet" }, ctx: { sessionId: "cap-host", agentId: "worker-1" } }),
    /Only the primary session agent/i,
  );

  const opened = await runtime.openInstance({
    instanceId: "fleet-panel",
    input: { scope: "fleet" },
    ctx: { sessionId: "cap-host", agentId: null },
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

  // Agent callers (non-UI ctx) never receive cross-session fleet state and cannot invoke fleet actions.
  const agentStatus = await runtime.invokeFromAgent("get_status", {}, { sessionId: "cap-host", instanceId: "fleet-panel" });
  assert.equal("fleet" in agentStatus, false);
  assert.equal("activeScope" in agentStatus, false);
  await assert.rejects(
    runtime.invokeFromAgent("set_scope", { scope: "projects" }, { sessionId: "cap-host", instanceId: "fleet-panel" }),
    /restricted to capability-authenticated UI/i,
  );

  // Multi-panel symmetry: opening a second panel in fleet mode and switching scope to "session" stops polling for all panels.
  const second = await runtime.openInstance({
    instanceId: "fleet-panel-2",
    input: { scope: "inbox" },
    ctx: { sessionId: "cap-host", agentId: null },
  });
  assert.equal(fleetService.isPolling(), true);
  const switchRes = await fetch(capAction, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionName: "set_scope", input: { scope: "session" } }),
  });
  assert.equal(switchRes.status, 200);
  assert.equal(fleetService.isPolling(), false);

  // Subagent or unattributed {} open receives ONLY single-session state and cannot invoke set_scope even with its capability URL!
  const subDefaultPanel = await runtime.openInstance({
    instanceId: "sub-default",
    input: {},
    ctx: { sessionId: "cap-host", agentId: "subagent-x" },
  });
  const subStateUrl = new URL("/state", subDefaultPanel.url);
  subStateUrl.search = new URL(subDefaultPanel.url).search;
  const subState = await (await fetch(subStateUrl)).json();
  assert.equal("fleet" in subState, false);
  const subActionUrl = new URL("/action", subDefaultPanel.url);
  subActionUrl.search = new URL(subDefaultPanel.url).search;
  const subEscalation = await fetch(subActionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionName: "set_scope", input: { scope: "projects" } }),
  });
  assert.equal(subEscalation.status, 500);

  // Reusing an existing primary panel from a subagent revokes its fleet privilege too.
  const downgraded = await runtime.openInstance({
    instanceId: "fleet-panel-2",
    input: {},
    ctx: { sessionId: "cap-host", agentId: "subagent-x" },
  });
  const downgradedAction = new URL("/action", downgraded.url);
  downgradedAction.search = new URL(downgraded.url).search;
  const downgradedEscalation = await fetch(downgradedAction, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionName: "set_scope", input: { scope: "projects" } }),
  });
  assert.equal(downgradedEscalation.status, 500);
});

test("leader handover, viewer-close cancellation, cross-instance policy sync, RPC failure accounting, subagent auth exclusions, and untimestamped grace windows hold", async (t) => {
  let nowMs = Date.parse("2026-11-11T15:00:00.000Z");
  const sharedStore = memoryStore();
  const scopeKey = `handover-${process.pid}-${Date.now()}`;
  const recoveredByA = [];
  const recoveredByB = [];

  const makeBoard = (bucket) =>
    createFleetService({
      hostSessionId: "host",
      now: () => nowMs,
      acquireLeader: () => acquireFleetLeader(scopeKey),
      createWatchdog: ({ isLeader }) =>
        createRecoveryWatchdog({
          store: sharedStore,
          now: () => nowMs,
          graceMs: 60_000,
          baseBackoffMs: 10_000,
          maxRetries: 3,
          isLeader,
          recoverSession: async (action) => { bucket.push(action); },
        }),
      executeHostTool: async (name) => {
        if (name === "list_sessions_and_chats") {
          return [
            { id: "stalled-auto", name: "Auto Worker", repo_full_name: "jongio/skills" },
            { id: "subagent-401", name: "Subagent OAuth", repo_full_name: "jongio/skills" },
          ];
        }
        if (name === "get_sessions_status") {
          return [
            { id: "stalled-auto", activity: "idle", mode: "autopilot", was_interrupted: true, interruption_reason: "network stream reset" },
            { id: "subagent-401", activity: "idle", mode: "autopilot" },
          ];
        }
        return [];
      },
      workerClient: {
        scan: async () => ({
          sessions: [
            {
              id: "stalled-auto",
              repository: "jongio/skills",
              recencyMs: nowMs - 7_200_000, // 2 hours old workspace mtime MUST NOT bypass 60s grace window!
              todos: [{ id: "t1", title: "Work", status: "in_progress" }],
              tailState: { completedTurns: 1, activity: "idle" },
            },
            {
              id: "subagent-401",
              repository: "jongio/skills",
              todos: [{ id: "t2", title: "Auth work", status: "in_progress" }],
              board: {
                // board.agents omits error details (just like progress.mjs); mergeSubagentRecords must preserve tailState error!
                agents: [{ id: "sub-auth", name: "research", role: "subagent", state: "failed" }],
              },
              tailState: {
                activity: "idle",
                subagents: [{ id: "sub-auth", name: "research", state: "failed", error: "401 Unauthorized: OAuth token expired" }],
              },
            },
          ],
          stats: {},
        }),
        stop: async () => {},
        isRunning: () => false,
      },
    });

  const boardA = makeBoard(recoveredByA);
  const boardB = makeBoard(recoveredByB);
  t.after(async () => { await boardA.shutdown(); await boardB.shutdown(); });

  await boardA.setRecoveryPolicy("autopilot_only");
  await boardA.setViewerActive("panel-a", true);
  await boardB.setViewerActive("panel-b", true);

  // First observation has no error timestamp: must enter 60s grace wait despite 2h-old workspace recencyMs!
  assert.equal(recoveredByA.length, 0);
  assert.equal(recoveredByB.length, 0);
  // Failed subagent with 401 OAuth error is classified attention_only, never auto-woken.
  const snap1 = boardA.snapshot();
  assert.equal(snap1.sessions.find((s) => s.id === "subagent-401")?.recovery?.action, "attention_only");
  assert.equal(snap1.sessions.find((s) => s.id === "stalled-auto")?.recovery?.action, "grace_wait");

  // Advance past 60s grace window: Board A (leader) dispatches attempt 1; Board B does not double-dispatch.
  nowMs += 65_000;
  await boardA.refreshFleet();
  await boardB.refreshFleet();
  assert.equal(recoveredByA.length, 1);
  assert.equal(recoveredByB.length, 0);

  // Cross-instance policy sync: operator turns policy "off" on Board B; Board A honors "off" on next refresh without clobbering it!
  await boardB.setRecoveryPolicy("off");
  nowMs += 65_000;
  await boardA.refreshFleet();
  assert.equal(recoveredByA.length, 1);
  assert.equal(boardA.snapshot().recoveryPolicy, "off");

  // Re-enable on Board B, then close Board A's viewer -> Board A releases leadership and Board B takes over automatically!
  await boardB.setRecoveryPolicy("autopilot_only");
  await boardA.setViewerActive("panel-a", false);
  nowMs += 65_000;
  await boardB.refreshFleet();
  assert.equal(recoveredByB.length, 1);

  // Activity-only changes (completedTurns / statusRevision) without todo or headSha change do NOT reset attempts;
  // and rejected recovery RPCs still increment attempts up to maxRetries=3 without throwing out of refreshFleet!
  let failRpcCalls = 0;
  const flakyWatchdog = await createRecoveryWatchdog({
    store: memoryStore(),
    now: () => nowMs,
    graceMs: 60_000,
    baseBackoffMs: 1_000,
    maxRetries: 3,
    isLeader: () => true,
    recoverSession: async () => {
      failRpcCalls += 1;
      throw new Error("Transient IPC timeout");
    },
  });
  await flakyWatchdog.setPolicy("all_active");
  const failingCandidate = {
    id: "rpc-fail-1",
    surface: "desktop",
    mode: "interactive",
    activity: "idle",
    wasInterrupted: true,
    failedAtMs: nowMs - 120_000,
    incompleteLeafCount: 1,
    progressFingerprint: "todos:abc|head:-",
  };
  for (let i = 0; i < 4; i += 1) {
    nowMs += 30_000;
    await flakyWatchdog.evaluate([failingCandidate]);
  }
  assert.equal(failRpcCalls, 3);
  assert.equal(flakyWatchdog.snapshot().entries["rpc-fail-1"].circuitOpen, true);

  // Manual recovery rejects pending operator prompts and root-cancelled sessions.
  await assert.rejects(
    flakyWatchdog.triggerManual({ ...failingCandidate, awaitingInput: { requestId: "q1", question: "Confirm?" } }),
    /waiting on operator input/i,
  );
  await assert.rejects(
    flakyWatchdog.triggerManual({ ...failingCandidate, rootCancelled: true }),
    /cancelled by the operator/i,
  );

  // Failure reset persistence: after a healthy/busy observation clears firstObservedFailureMs, a new untimestamped failure enforces a fresh 60s grace window!
  let graceCalls = 0;
  const resetWatchdog = await createRecoveryWatchdog({
    store: memoryStore(),
    now: () => nowMs,
    graceMs: 60_000,
    isLeader: () => true,
    recoverSession: async () => { graceCalls += 1; },
  });
  await resetWatchdog.setPolicy("all_active");
  const untimestamped = {
    id: "grace-reset-1",
    surface: "desktop",
    mode: "autopilot",
    activity: "idle",
    wasInterrupted: true,
    failedAtMs: null,
    incompleteLeafCount: 1,
    progressFingerprint: "todos:same|head:same",
  };
  await resetWatchdog.evaluate([untimestamped]); // First observed at nowMs -> enters grace_wait
  assert.equal(graceCalls, 0);
  nowMs += 30_000;
  await resetWatchdog.evaluate([{ ...untimestamped, activity: "busy", wasInterrupted: false }]); // Healthy/busy clears failure
  nowMs += 40_000; // 70s after original failure, but NEW interruption starts now!
  const secondObs = await resetWatchdog.evaluate([untimestamped]);
  assert.equal(secondObs["grace-reset-1"].action, "grace_wait");
  assert.equal(graceCalls, 0);
});


