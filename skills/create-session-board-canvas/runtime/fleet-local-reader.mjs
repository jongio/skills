import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_PLAN_BYTES = 64 * 1024;
const MAX_BOARD_BYTES = 512 * 1024;
const EVENTS_TAIL_BYTES = 64 * 1024;
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function safeStat(filePath) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function readBoundedUtf8(filePath, maxBytes, fromEnd = false) {
  const info = safeStat(filePath);
  if (!info || !info.isFile()) return null;
  const length = Math.min(info.size, maxBytes);
  if (length <= 0) return { content: "", size: info.size, mtimeMs: info.mtimeMs };
  const offset = fromEnd ? Math.max(0, info.size - length) : 0;
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    let content = buffer.subarray(0, bytesRead).toString("utf8");
    if (fromEnd && offset > 0) {
      const firstNewline = content.indexOf("\n");
      content = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
    }
    return { content, size: info.size, mtimeMs: info.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

export function parseWorkspaceYaml(raw) {
  const out = {};
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value === "null" || value === "~") value = null;
    out[key] = value;
  }
  return out;
}

// Explicitly allowlist only non-sensitive metadata from $COPILOT_HOME/servers/*.json.
// Never retain or forward bearer tokens, host addresses, or loopback ports.
function sanitizeServerEntry(raw, mtimeMs) {
  if (!raw || typeof raw !== "object") return null;
  const pid = Number(raw.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    schemaVersion: Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 1,
    kind: raw.kind === "managed-server" ? "managed-server" : "ui-server",
    pid,
    sessionId: typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : null,
    sessionName: typeof raw.sessionName === "string" && raw.sessionName ? raw.sessionName : null,
    cwd: typeof raw.cwd === "string" && raw.cwd ? raw.cwd : null,
    branch: typeof raw.branch === "string" && raw.branch ? raw.branch : null,
    model: typeof raw.model === "string" && raw.model ? raw.model : null,
    status: typeof raw.status === "string" ? raw.status : null,
    attentionKind: typeof raw.attentionKind === "string" ? raw.attentionKind : null,
    statusRevision: Number.isInteger(raw.statusRevision) ? raw.statusRevision : 0,
    lastTerminalEvent: typeof raw.lastTerminalEvent === "string" ? raw.lastTerminalEvent : null,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    copilotVersion: typeof raw.copilotVersion === "string" ? raw.copilotVersion : null,
    lastSeenMs: mtimeMs,
  };
}

function readSanitizedServers(copilotHome, cache, pidAlive) {
  const serversDir = join(copilotHome, "servers");
  const dirStat = safeStat(serversDir);
  if (!dirStat || !dirStat.isDirectory()) return new Map();

  const bySessionId = new Map();
  let entries = [];
  try {
    entries = readdirSync(serversDir, { withFileTypes: true });
  } catch {
    return bySessionId;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.includes(".tmp.")) continue;
    const fullPath = join(serversDir, entry.name);
    const info = safeStat(fullPath);
    if (!info) continue;
    const prev = cache.servers.get(fullPath);
    let sanitized = prev && prev.mtimeMs === info.mtimeMs ? prev.data : null;
    if (!sanitized) {
      try {
        const parsed = JSON.parse(readFileSync(fullPath, "utf8"));
        sanitized = sanitizeServerEntry(parsed, info.mtimeMs);
        cache.servers.set(fullPath, { mtimeMs: info.mtimeMs, data: sanitized });
      } catch {
        continue;
      }
    }
    if (sanitized && sanitized.sessionId && pidAlive(sanitized.pid)) {
      bySessionId.set(sanitized.sessionId, sanitized);
    }
  }
  return bySessionId;
}

function readJsonCacheFile(filePath, cacheSlot) {
  const info = safeStat(filePath);
  if (!info || !info.isFile()) return {};
  if (cacheSlot.mtimeMs === info.mtimeMs && cacheSlot.data) return cacheSlot.data;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const safeData = parsed && typeof parsed === "object" ? parsed : {};
    cacheSlot.mtimeMs = info.mtimeMs;
    cacheSlot.data = safeData;
    return safeData;
  } catch {
    return cacheSlot.data || {};
  }
}

function probeSessionLocks(sessionDir, entries, pidAlive) {
  let pid = null;
  let alive = false;
  let hasLockFile = false;
  for (const entry of entries) {
    const match = entry.name.match(/^inuse\.(\d+)\.(lock|hold)$/);
    if (!match) continue;
    hasLockFile = true;
    const candidatePid = Number(match[1]);
    if (pidAlive(candidatePid)) {
      pid = candidatePid;
      alive = true;
      break;
    }
    pid ??= candidatePid;
  }
  return { hasLockFile, pid, alive };
}

function readSessionSqliteEphemeral(dbPath, timeoutMs) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: timeoutMs });
    db.exec("PRAGMA query_only = ON;");
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)),
    );
    const todos = tables.has("todos")
      ? db.prepare("SELECT id, title, description, status, updated_at FROM todos LIMIT 500").all().map((row) => ({
          id: String(row.id || ""),
          title: String(row.title || row.id || ""),
          description: String(row.description || ""),
          status: String(row.status || "pending"),
          updatedAt: row.updated_at ? String(row.updated_at) : null,
        })).filter((row) => row.id)
      : [];
    const dependencies = tables.has("todo_deps")
      ? db.prepare("SELECT todo_id, depends_on FROM todo_deps LIMIT 1000").all().map((row) => ({
          todoId: String(row.todo_id || ""),
          dependsOn: String(row.depends_on || ""),
        })).filter((row) => row.todoId && row.dependsOn)
      : [];
    const workflows = tables.has("workflow_runs")
      ? db.prepare("SELECT id, status FROM workflow_runs LIMIT 50").all().map((row) => ({
          id: String(row.id || ""),
          status: String(row.status || ""),
        }))
      : [];
    const factories = tables.has("factory_runs")
      ? db.prepare("SELECT id, status FROM factory_runs LIMIT 50").all().map((row) => ({
          id: String(row.id || ""),
          status: String(row.status || ""),
        }))
      : [];
    return { ok: true, todos, dependencies, workflows, factories };
  } catch (error) {
    return { ok: false, locked: true, error: String(error?.message || error).slice(0, 200) };
  } finally {
    try { db?.close(); } catch { /* ensure zero retained handles */ }
  }
}

function parseEventsTail(content) {
  let activity = "idle";
  let awaitingInput = null;
  let pendingPlan = null;
  let pendingPermission = null;
  let pendingElicitation = null;
  let lastError = null;
  let completedTurns = 0;
  let lastEventAt = null;
  const subagents = new Map();

  for (const line of String(content || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const type = String(event?.type || "");
    const at = typeof event?.timestamp === "string" ? event.timestamp : null;
    if (at) lastEventAt = at;
    const data = event?.data && typeof event.data === "object" ? event.data : {};

    if (type === "assistant.turn_start") {
      activity = "busy";
      lastError = null;
    } else if (type === "assistant.turn_end") {
      activity = "idle";
      completedTurns += 1;
    } else if (type === "session.idle") {
      activity = "idle";
    } else if (type === "abort" || type === "session.shutdown") {
      if (!event.agentId && !data.agentId) {
        activity = "idle";
        awaitingInput = null;
        pendingPlan = null;
        pendingPermission = null;
        pendingElicitation = null;
      }
    } else if (type === "session.error") {
      activity = "idle";
      lastError = {
        message: String(data.message || data.error || "Session error").slice(0, 500),
        at,
      };
    } else if (type === "user_input.requested") {
      awaitingInput = {
        requestId: String(data.requestId || data.request_id || ""),
        question: String(data.question || data.prompt || "Input requested").slice(0, 1000),
        choices: Array.isArray(data.choices) ? data.choices.map((c) => String(c)) : [],
        allowFreeform: data.allowFreeform !== false && data.allow_freeform !== false,
        at,
      };
    } else if (type === "user_input.completed") {
      awaitingInput = null;
    } else if (type === "exit_plan_mode.requested") {
      pendingPlan = {
        requestId: String(data.requestId || data.request_id || ""),
        summary: String(data.summary || "").slice(0, 2000),
        at,
      };
    } else if (type === "exit_plan_mode.completed") {
      pendingPlan = null;
    } else if (type === "permission.requested") {
      pendingPermission = {
        requestId: String(data.requestId || data.request_id || ""),
        message: String(data.message || data.toolName || "Permission approval required").slice(0, 500),
        at,
      };
    } else if (type === "permission.completed") {
      pendingPermission = null;
    } else if (type === "elicitation.requested") {
      pendingElicitation = {
        requestId: String(data.requestId || data.request_id || ""),
        message: String(data.message || "MCP input required").slice(0, 500),
        at,
      };
    } else if (type === "elicitation.completed") {
      pendingElicitation = null;
    } else if (type.startsWith("subagent.")) {
      const id = String(data.agentId || event.agentId || data.name || "");
      if (id) {
        const current = subagents.get(id) || { id, name: String(data.name || id), state: "working", error: null };
        if (type === "subagent.completed") {
          current.state = "completed";
          current.error = null;
        } else if (type === "subagent.failed") {
          current.state = "failed";
          current.error = String(data.error || data.message || "Subagent failed").slice(0, 300);
        } else if (type === "subagent.started") {
          current.state = "working";
        }
        subagents.set(id, current);
      }
    }
  }

  if (awaitingInput || pendingPlan || pendingPermission || pendingElicitation) {
    activity = "waiting";
  }

  return {
    activity,
    awaitingInput,
    pendingPlan,
    pendingPermission,
    pendingElicitation,
    lastError,
    completedTurns,
    lastEventAt,
    subagents: [...subagents.values()],
  };
}

export function createLocalFleetCache() {
  return {
    sessions: new Map(),
    servers: new Map(),
    prCache: { mtimeMs: -1, data: {} },
    issueCache: { mtimeMs: -1, data: {} },
  };
}

export function readLocalFleetSnapshot({
  copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot"),
  maxSessions = 50,
  cache = createLocalFleetCache(),
  sqliteTimeoutMs = 50,
  pidAlive = defaultPidAlive,
} = {}) {
  const home = resolve(copilotHome);
  const stats = {
    totalDiscoveredDirs: 0,
    inspectedSessions: 0,
    sqliteOpens: 0,
    sqliteBusySkips: 0,
    tailReads: 0,
  };

  const serversBySession = readSanitizedServers(home, cache, pidAlive);
  const prCache = readJsonCacheFile(join(home, "pr-statusline", "pr-cache.json"), cache.prCache);
  const issueCache = readJsonCacheFile(join(home, "issue-statusline", "issue-cache.json"), cache.issueCache);

  const stateRoot = join(home, "session-state");
  const rootStat = safeStat(stateRoot);
  if (!rootStat || !rootStat.isDirectory()) {
    return { sessions: [], prCache, issueCache, stats };
  }

  let dirEntries = [];
  try {
    dirEntries = readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return { sessions: [], prCache, issueCache, stats };
  }

  const candidates = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory() || !SAFE_SESSION_ID.test(entry.name)) continue;
    const sessionDir = join(stateRoot, entry.name);
    const wsStat = safeStat(join(sessionDir, "workspace.yaml"));
    const dirStat = safeStat(sessionDir);
    if (!wsStat && !dirStat) continue;
    const recencyMs = Math.max(wsStat?.mtimeMs || 0, dirStat?.mtimeMs || 0);
    candidates.push({ id: entry.name, sessionDir, wsStat, recencyMs });
  }

  stats.totalDiscoveredDirs = candidates.length;
  candidates.sort((a, b) => b.recencyMs - a.recencyMs);
  const selected = candidates.slice(0, Math.max(1, maxSessions));

  const sessions = [];
  for (const item of selected) {
    stats.inspectedSessions += 1;
    const cached = cache.sessions.get(item.id) || {};

    let subEntries = [];
    try {
      subEntries = readdirSync(item.sessionDir, { withFileTypes: true });
    } catch {
      continue;
    }

    // 1. workspace.yaml
    let workspace = cached.workspace || {};
    if (item.wsStat && item.wsStat.mtimeMs !== cached.workspaceMtimeMs) {
      const boundedWs = readBoundedUtf8(join(item.sessionDir, "workspace.yaml"), 16 * 1024);
      if (boundedWs) {
        workspace = parseWorkspaceYaml(boundedWs.content);
        cached.workspace = workspace;
        cached.workspaceMtimeMs = boundedWs.mtimeMs;
      }
    }

    // 2. Lock / PID liveness
    const lockState = probeSessionLocks(item.sessionDir, subEntries, pidAlive);

    // 3. Ephemeral read-only SQLite (todos, todo_deps, workflow_runs, factory_runs)
    const dbPath = join(item.sessionDir, "session.db");
    const dbStat = safeStat(dbPath);
    const walStat = dbStat ? safeStat(`${dbPath}-wal`) : null;
    const dbSignature = dbStat ? `${dbStat.mtimeMs}:${walStat?.mtimeMs || 0}:${walStat?.size || 0}` : null;

    let todos = cached.todos || [];
    let dependencies = cached.dependencies || [];
    let workflows = cached.workflows || [];
    let factories = cached.factories || [];

    if (dbStat && dbSignature !== cached.dbSignature) {
      stats.sqliteOpens += 1;
      const dbResult = readSessionSqliteEphemeral(dbPath, sqliteTimeoutMs);
      if (dbResult.ok) {
        const postDbStat = safeStat(dbPath) || dbStat;
        const postWalStat = safeStat(`${dbPath}-wal`);
        const postSignature = `${postDbStat.mtimeMs}:${postWalStat?.mtimeMs || 0}:${postWalStat?.size || 0}`;
        todos = dbResult.todos;
        dependencies = dbResult.dependencies;
        workflows = dbResult.workflows;
        factories = dbResult.factories;
        cached.todos = todos;
        cached.dependencies = dependencies;
        cached.workflows = workflows;
        cached.factories = factories;
        cached.dbSignature = postSignature;
      } else {
        stats.sqliteBusySkips += 1;
      }
    } else if (!dbStat) {
      todos = [];
      dependencies = [];
      workflows = [];
      factories = [];
      cached.dbSignature = null;
    }

    // 4. plan.md
    const planPath = join(item.sessionDir, "plan.md");
    const planStat = safeStat(planPath);
    let plan = cached.plan || { exists: false, content: null };
    if (planStat && planStat.mtimeMs !== cached.planMtimeMs) {
      const boundedPlan = readBoundedUtf8(planPath, MAX_PLAN_BYTES);
      if (boundedPlan) {
        plan = { exists: true, content: boundedPlan.content };
        cached.plan = plan;
        cached.planMtimeMs = boundedPlan.mtimeMs;
      }
    } else if (!planStat) {
      plan = { exists: false, content: null };
      cached.planMtimeMs = null;
    }

    // 5. Optional session-progress board.json
    const boardPath = join(item.sessionDir, "files", "session-progress", "board.json");
    const boardStat = safeStat(boardPath);
    let board = cached.board || null;
    if (boardStat && boardStat.mtimeMs !== cached.boardMtimeMs) {
      const boundedBoard = readBoundedUtf8(boardPath, MAX_BOARD_BYTES);
      if (boundedBoard) {
        try {
          const parsedBoard = JSON.parse(boundedBoard.content);
          board = {
            activeGoalId: parsedBoard.activeGoalId || null,
            goals: Array.isArray(parsedBoard.goals) ? parsedBoard.goals : [],
            hierarchy: Array.isArray(parsedBoard.hierarchy) ? parsedBoard.hierarchy : [],
            agents: Array.isArray(parsedBoard.agents) ? parsedBoard.agents : [],
            reports: Array.isArray(parsedBoard.reports) ? parsedBoard.reports.slice(-40) : [],
            delivery: parsedBoard.delivery || null,
            references: parsedBoard.references || null,
          };
          cached.board = board;
          cached.boardMtimeMs = boundedBoard.mtimeMs;
        } catch {
          /* ignore partial write */
        }
      }
    } else if (!boardStat) {
      board = null;
      cached.boardMtimeMs = null;
    }

    // 6. Bounded 64 KB events.jsonl tail
    const eventsPath = join(item.sessionDir, "events.jsonl");
    const eventsStat = safeStat(eventsPath);
    const eventsSig = eventsStat ? `${eventsStat.mtimeMs}:${eventsStat.size}` : null;
    let tailState = cached.tailState || null;
    if (eventsStat && eventsSig !== cached.eventsSig) {
      stats.tailReads += 1;
      const tail = readBoundedUtf8(eventsPath, EVENTS_TAIL_BYTES, true);
      if (tail) {
        tailState = parseEventsTail(tail.content);
        cached.tailState = tailState;
        cached.eventsSig = eventsSig;
      }
    } else if (!eventsStat) {
      tailState = null;
      cached.eventsSig = null;
    }

    cache.sessions.set(item.id, cached);
    const sessionId = String(workspace.id || item.id);
    sessions.push({
      id: sessionId,
      mcSessionId: workspace.mc_session_id ? String(workspace.mc_session_id) : null,
      name: workspace.name ? String(workspace.name) : null,
      cwd: workspace.cwd ? String(workspace.cwd) : null,
      gitRoot: workspace.git_root ? String(workspace.git_root) : null,
      repository: workspace.repository ? String(workspace.repository) : null,
      branch: workspace.branch ? String(workspace.branch) : null,
      clientName: workspace.client_name ? String(workspace.client_name) : null,
      createdAt: workspace.created_at ? String(workspace.created_at) : null,
      updatedAt: workspace.updated_at ? String(workspace.updated_at) : new Date(item.recencyMs).toISOString(),
      recencyMs: item.recencyMs,
      lockState,
      liveServer: serversBySession.get(sessionId) || null,
      todos,
      dependencies,
      workflows,
      factories,
      plan,
      board,
      tailState,
    });
  }

  return { sessions, prCache, issueCache, stats };
}
