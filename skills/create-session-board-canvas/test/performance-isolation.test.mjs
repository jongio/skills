import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createCanvasRuntime } from "../runtime/canvas-kit/server.mjs";
import { attachCanvasLifecycle, createProgressCanvas } from "../runtime/canvas.mjs";
import { createLocalFleetCache, readLocalFleetSnapshot } from "../runtime/fleet-local-reader.mjs";
import { createFleetService } from "../runtime/fleet-service.mjs";
import { createFleetWorkerClient } from "../runtime/fleet-worker-client.mjs";
import { createProgressService } from "../runtime/progress.mjs";

function makeTempCopilotHome(t) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "copilot-fleet-perf-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedSessionDb(dbPath, { todos = [], deps = [], workflowStatus = null } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE todo_deps (
        todo_id TEXT NOT NULL,
        depends_on TEXT NOT NULL
      );
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const insertTodo = db.prepare("INSERT INTO todos (id, title, description, status) VALUES (?, ?, ?, ?)");
    for (const row of todos) insertTodo.run(row.id, row.title, row.description || "", row.status);
    const insertDep = db.prepare("INSERT INTO todo_deps (todo_id, depends_on) VALUES (?, ?)");
    for (const dep of deps) insertDep.run(dep.todoId, dep.dependsOn);
    if (workflowStatus) {
      db.prepare("INSERT INTO workflow_runs (id, name, status) VALUES (?, ?, ?)").run("wf-1", "batch", workflowStatus);
    }
  } finally {
    db.close();
  }
}

test("default session scope performs zero fleet scans, zero host RPCs, and zero worker/timer activity", async (t) => {
  let hostRpcCalls = 0;
  let workerScans = 0;

  const progressService = await createProgressService({
    sessionId: "perf-host",
    store: { load: async () => null, save: async () => {} },
    readSources: async () => ({ plan: { exists: false, content: null }, rows: [], dependencies: [] }),
  });

  const fleetService = createFleetService({
    hostSessionId: "perf-host",
    pollIntervalMs: 40,
    executeHostTool: async () => {
      hostRpcCalls += 1;
      return { items: [] };
    },
    workerClient: {
      scan: async () => {
        workerScans += 1;
        return { sessions: [], stats: {} };
      },
      stop: async () => {},
      isRunning: () => false,
    },
  });
  t.after(() => fleetService.shutdown());

  const canvasConfig = createProgressCanvas(progressService, "perf-host", { fleetService });
  const runtime = attachCanvasLifecycle(createCanvasRuntime(canvasConfig), canvasConfig);
  t.after(() => runtime.shutdown());

  // Opening with {} as attributed primary stays in single-session mode: zero fleet activity.
  const panel = await runtime.openInstance({ instanceId: "panel-1", input: {}, ctx: { sessionId: "perf-host", agentId: null } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hostRpcCalls, 0);
  assert.equal(workerScans, 0);
  assert.equal(fleetService.isPolling(), false);

  const endpoint = (p) => {
    const u = new URL(p, panel.url);
    u.search = new URL(panel.url).search;
    return u;
  };

  // Switching scope to projects starts polling only while panel is open in fleet mode.
  const res = await fetch(endpoint("action"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actionName: "set_scope", input: { scope: "projects", instanceId: "panel-1" } }),
  });
  assert.equal(res.status, 200);
  assert.equal(fleetService.isPolling(), true);
  assert.ok(workerScans >= 1);

  // Closing the panel tears down fleet polling immediately.
  await runtime.closeInstance("panel-1");
  assert.equal(fleetService.isPolling(), false);
});

test("Windows SQLite reader releases file handles immediately, caches by mtime, and yields under exclusive writer locks", (t) => {
  const home = makeTempCopilotHome(t);
  const sessionDir = join(home, "session-state", "cli-session-1");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "workspace.yaml"),
    "id: cli-session-1\ncwd: C:\\code\\demo\nrepository: jongio/demo\nbranch: feat-x\nclient_name: github/cli\nname: Demo CLI\n",
  );
  const dbPath = join(sessionDir, "session.db");
  seedSessionDb(dbPath, {
    todos: [
      { id: "t1", title: "Write tests", status: "done" },
      { id: "t2", title: "Ship feature", status: "in_progress" },
    ],
    deps: [{ todoId: "t2", dependsOn: "t1" }],
    workflowStatus: "running",
  });

  const cache = createLocalFleetCache();
  const first = readLocalFleetSnapshot({ copilotHome: home, cache, sqliteTimeoutMs: 40 });
  assert.equal(first.sessions.length, 1);
  assert.equal(first.sessions[0].todos.length, 2);
  assert.equal(first.stats.sqliteOpens, 1);

  // Second read with unchanged mtime performs ZERO SQLite opens.
  const second = readLocalFleetSnapshot({ copilotHome: home, cache, sqliteTimeoutMs: 40 });
  assert.equal(second.stats.sqliteOpens, 0);
  assert.equal(second.sessions[0].todos.length, 2);

  // Simulate an active session holding an EXCLUSIVE transaction on session.db while mtime changes.
  const writer = new DatabaseSync(dbPath, { timeout: 1000 });
  try {
    writer.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO todos (id, title, status) VALUES ('t3', 'Busy write', 'pending');");
    const future = new Date(Date.now() + 5000);
    utimesSync(dbPath, future, future);

    const startMs = performance.now();
    const underLock = readLocalFleetSnapshot({ copilotHome: home, cache, sqliteTimeoutMs: 25 });
    const elapsedMs = performance.now() - startMs;
    assert.ok(elapsedMs < 500, `expected non-blocking fallback under lock, took ${elapsedMs}ms`);
    // Preserves previously cached todos instead of wiping or crashing.
    assert.equal(underLock.sessions[0].todos.length, 2);
    writer.exec("COMMIT; PRAGMA locking_mode = NORMAL;");
  } finally {
    writer.close();
  }

  // After writer commits, next read picks up all 3 todos cleanly.
  const afterCommit = readLocalFleetSnapshot({ copilotHome: home, cache, sqliteTimeoutMs: 40 });
  assert.equal(afterCommit.sessions[0].todos.length, 3);

  // Also verify unvalidated workspace.yaml IDs, root abort vs child events, hook-resolved prompts, and overlapping request IDs.
  writeFileSync(
    join(sessionDir, "workspace.yaml"),
    "id: \"cli-session-1; calc.exe\"\nrepository: jongio/demo\nclient_name: github/cli\n",
  );
  writeFileSync(
    join(sessionDir, "events.jsonl"),
    [
      JSON.stringify({ type: "session.error", timestamp: "2026-11-11T10:00:00Z", data: { message: "503 overloaded" } }),
      JSON.stringify({ type: "subagent.failed", timestamp: "2026-11-11T10:00:01Z", data: { agentId: "s1", error: "boom" } }),
      JSON.stringify({ type: "abort", timestamp: "2026-11-11T10:00:05Z", data: {} }),
      // Child turn_start after root abort MUST NOT clear parent rootCancelled!
      JSON.stringify({ type: "assistant.turn_start", agentId: "child-1", timestamp: "2026-11-11T10:00:06Z", data: { agentId: "child-1" } }),
      // Hook-resolved permission request MUST NOT mark session waiting!
      JSON.stringify({ type: "permission.requested", timestamp: "2026-11-11T10:00:07Z", data: { requestId: "hook-1", resolvedByHook: true } }),
      // Overlapping user_input A and B where A completes leaves B pending!
      JSON.stringify({ type: "user_input.requested", timestamp: "2026-11-11T10:00:08Z", data: { requestId: "ask-a", question: "First?" } }),
      JSON.stringify({ type: "user_input.requested", timestamp: "2026-11-11T10:00:09Z", data: { requestId: "ask-b", question: "Second?" } }),
      JSON.stringify({ type: "user_input.completed", timestamp: "2026-11-11T10:00:10Z", data: { requestId: "ask-a" } }),
    ].join("\n") + "\n",
  );
  const sanitizedSnap = readLocalFleetSnapshot({ copilotHome: home, cache, sqliteTimeoutMs: 40 });
  assert.equal(sanitizedSnap.sessions[0].id, "cli-session-1");
  assert.equal(sanitizedSnap.sessions[0].tailState?.rootCancelled, true);
  assert.equal(sanitizedSnap.sessions[0].tailState?.lastError, null);
  assert.equal(sanitizedSnap.sessions[0].tailState?.pendingPermission, null);
  assert.equal(sanitizedSnap.sessions[0].tailState?.awaitingInput?.requestId, "ask-b");
  assert.equal(sanitizedSnap.sessions[0].tailState?.awaitingInput?.question, "Second?");

  // Unterminated initial JSONL line is preserved as remainder and completed on subsequent append!
  const partialSessionDir = join(home, "session-state", "partial-jsonl-1");
  mkdirSync(partialSessionDir, { recursive: true });
  writeFileSync(join(partialSessionDir, "workspace.yaml"), "id: partial-jsonl-1\nrepository: jongio/demo\nclient_name: github/cli\n");
  const fullRecord = JSON.stringify({ type: "user_input.requested", timestamp: "2026-11-11T12:00:00Z", data: { requestId: "frag-1", question: "Fragmented?" } }) + "\n";
  const halfIdx = Math.floor(fullRecord.length / 2);
  const partialEventsPath = join(partialSessionDir, "events.jsonl");
  writeFileSync(partialEventsPath, fullRecord.slice(0, halfIdx));
  const partialRead1 = readLocalFleetSnapshot({ copilotHome: home, cache, sqliteTimeoutMs: 40 });
  assert.equal(partialRead1.sessions.find((s) => s.id === "partial-jsonl-1")?.tailState?.awaitingInput, null);

  writeFileSync(partialEventsPath, fullRecord);
  const nextTick = new Date(Date.now() + 8000);
  utimesSync(partialEventsPath, nextTick, nextTick);
  const partialRead2 = readLocalFleetSnapshot({ copilotHome: home, cache, sqliteTimeoutMs: 40 });
  assert.equal(partialRead2.sessions.find((s) => s.id === "partial-jsonl-1")?.tailState?.awaitingInput?.question, "Fragmented?");
  assert.deepEqual(
    sanitizedSnap.sessions[0].tailState?.subagents.filter((s) => s.state === "failed"),
    [],
  );

  // Prove zero Windows handles remain open: renaming and deleting the session directory succeeds immediately on Windows.
  const renamedDir = join(home, "session-state", "cli-session-1-archived");
  renameSync(sessionDir, renamedDir);
  rmSync(renamedDir, { recursive: true, force: true });
});

test("server registry reader strips secret tokens and network endpoints before returning state", (t) => {
  const home = makeTempCopilotHome(t);
  const serversDir = join(home, "servers");
  const sessionDir = join(home, "session-state", "srv-session-1");
  mkdirSync(serversDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "workspace.yaml"), "id: srv-session-1\nrepository: jongio/skills\nclient_name: github/cli\n");
  writeFileSync(
    join(serversDir, `${process.pid}.json`),
    JSON.stringify({
      schemaVersion: 2,
      kind: "managed-server",
      pid: process.pid,
      host: "127.0.0.1",
      port: 59123,
      token: "SECRET_BEARER_TOKEN_DO_NOT_LEAK_999",
      sessionId: "srv-session-1",
      status: "attention",
      attentionKind: "user_input",
      statusRevision: 7,
      lastTerminalEvent: "turn_end",
      startedAt: "2026-11-11T19:00:00.000Z",
      copilotVersion: "1.0.106",
    }),
  );

  const snapshot = readLocalFleetSnapshot({ copilotHome: home });
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("SECRET_BEARER_TOKEN_DO_NOT_LEAK_999"), false);
  assert.equal(serialized.includes("59123"), false);
  assert.equal(serialized.includes('"token"'), false);
  assert.equal(snapshot.sessions[0].liveServer?.status, "attention");
  assert.equal(snapshot.sessions[0].liveServer?.attentionKind, "user_input");
});

test("worker client bounds large session directories and 512KB event logs off the main thread and stops cleanly", async (t) => {
  const home = makeTempCopilotHome(t);
  const stateRoot = join(home, "session-state");
  mkdirSync(stateRoot, { recursive: true });

  const now = Date.now();
  for (let i = 0; i < 65; i += 1) {
    const id = `bulk-session-${String(i).padStart(3, "0")}`;
    const dir = join(stateRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workspace.yaml"), `id: ${id}\nrepository: jongio/skills\nclient_name: github/cli\nname: Session ${i}\n`);
    if (i === 64) {
      // 512 KB events.jsonl: tail reader must read only the last 64 KB and still capture the latest state.
      const filler = `${JSON.stringify({ type: "assistant.message", timestamp: "2026-11-11T10:00:00Z", data: { content: "x".repeat(500) } })}\n`.repeat(950);
      const finalEvents = [
        JSON.stringify({ type: "subagent.started", timestamp: "2026-11-11T11:00:00Z", data: { agentId: "sub-1", name: "explore" } }),
        JSON.stringify({ type: "user_input.requested", timestamp: "2026-11-11T11:01:00Z", data: { requestId: "req-9", question: "Pick target?" } }),
      ].join("\n") + "\n";
      writeFileSync(join(dir, "events.jsonl"), filler + finalEvents);
    }
    const stamp = new Date(now - (65 - i) * 1000);
    utimesSync(dir, stamp, stamp);
    utimesSync(join(dir, "workspace.yaml"), stamp, stamp);
  }

  const client = createFleetWorkerClient({ copilotHome: home, maxSessions: 20 });
  t.after(() => client.stop());

  let maxLagMs = 0;
  let lastTick = performance.now();
  const lagTimer = setInterval(() => {
    const current = performance.now();
    const lag = current - lastTick - 5;
    if (lag > maxLagMs) maxLagMs = lag;
    lastTick = current;
  }, 5);

  let result;
  try {
    result = await client.scan();
  } finally {
    clearInterval(lagTimer);
  }

  assert.equal(client.isRunning(), true);
  assert.equal(result.sessions.length, 20);
  assert.equal(result.stats.totalDiscoveredDirs, 65);
  const newest = result.sessions.find((s) => s.id === "bulk-session-064");
  assert.ok(newest);
  assert.equal(newest.tailState?.awaitingInput?.question, "Pick target?");
  // Cold 512 KB tail with no root lifecycle event and no waiting prompt would mark lifecycleUnknown; verify oldest live session priority & scratch board fallback too:
  const oldLiveDir = join(stateRoot, "bulk-session-000");
  writeFileSync(join(oldLiveDir, `inuse.${process.pid}.lock`), "");
  const scratchDir = join(oldLiveDir, "extensions", "session-progress");
  mkdirSync(scratchDir, { recursive: true });
  writeFileSync(join(scratchDir, "board.json"), JSON.stringify({ hierarchy: [{ parentId: "m1", childIds: ["c1"] }], agents: [], reports: [] }));
  const reprioritized = await client.scan();
  const prioritizedLive = reprioritized.sessions.find((s) => s.id === "bulk-session-000");
  assert.ok(prioritizedLive, "expected live older CLI session to be prioritized ahead of inactive newer dirs");
  assert.deepEqual(prioritizedLive.board?.hierarchy, [{ parentId: "m1", childIds: ["c1"] }]);
  assert.ok(maxLagMs < 100, `expected main-thread event loop to stay responsive, maxLagMs=${maxLagMs}`);

  await client.stop();
  assert.equal(client.isRunning(), false);
});

test("fleet service coalesces concurrent refreshes and backs off polling when host RPCs are slow", async (t) => {
  let listCalls = 0;
  const fleetService = createFleetService({
    hostSessionId: "host-1",
    pollIntervalMs: 100,
    maxPollIntervalMs: 800,
    slowRpcThresholdMs: 30,
    executeHostTool: async (name) => {
      if (name === "list_sessions_and_chats") {
        listCalls += 1;
        await new Promise((r) => setTimeout(r, 60));
        return [];
      }
      return [];
    },
    workerClient: {
      scan: async () => ({ sessions: [], stats: {} }),
      stop: async () => {},
      isRunning: () => false,
    },
  });
  t.after(() => fleetService.shutdown());

  // Concurrent refresh calls coalesce into a single host RPC flight, and viewerless refresh stops any worker on exit.
  let workerStopped = 0;
  const viewerlessFleet = createFleetService({
    hostSessionId: "host-2",
    executeHostTool: async () => [],
    workerClient: {
      scan: async () => ({ sessions: [], stats: {} }),
      stop: async () => { workerStopped += 1; },
      isRunning: () => false,
    },
  });
  t.after(() => viewerlessFleet.shutdown());
  await viewerlessFleet.refreshFleet();
  assert.ok(workerStopped >= 1, "expected viewerless refreshFleet to stop workerClient in finally");

  const [a, b, c] = await Promise.all([
    fleetService.refreshFleet(),
    fleetService.refreshFleet(),
    fleetService.refreshFleet(),
  ]);
  assert.equal(listCalls, 1);
  assert.equal(a.revision, b.revision);
  assert.equal(b.revision, c.revision);
  // Slow RPC (>30ms) backs off the interval from 100ms to 200ms.
  assert.equal(fleetService.currentPollIntervalMs(), 200);
});
