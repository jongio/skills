import { createHash } from "node:crypto";
import {
  buildPullRequestDeepLink,
  buildSessionDeepLink,
  buildSessionDetailDeepLink,
  buildSessionRestartDeepLink,
  isRepoFullName,
  safeDeepLinkUrl,
} from "./web/deeplinks.mjs";

const DELIVERY_MODES = new Set(["immediate", "enqueue"]);
const SESSION_MODES = new Set(["plan", "interactive", "autopilot"]);

function extractJsonPayload(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") {
    if (raw.resultType && raw.resultType !== "success") {
      throw new Error(String(raw.error || raw.textResultForLlm || "Host tool call failed"));
    }
    if (typeof raw.textResultForLlm === "string") {
      return extractJsonPayload(raw.textResultForLlm);
    }
    return raw;
  }
  const text = String(raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const startArr = text.indexOf("[");
    const startObj = text.indexOf("{");
    const candidates = [startArr, startObj].filter((idx) => idx >= 0).sort((a, b) => a - b);
    for (const idx of candidates) {
      try {
        return JSON.parse(text.slice(idx));
      } catch {
        /* try next JSON start */
      }
    }
    return { text };
  }
}

function asArray(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of keys) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
}

function computeLeafMetrics(todos = [], hierarchy = [], { truncated = false } = {}) {
  const validTodos = Array.isArray(todos) ? todos.filter((t) => t && typeof t.id === "string" && t.id) : [];
  if (validTodos.length === 0) {
    return { done: 0, total: 0, incomplete: truncated ? 1 : 0, percent: null, truncated: Boolean(truncated) };
  }
  const byId = new Set(validTodos.map((t) => t.id));
  const parentWithValidChild = new Set();
  for (const entry of Array.isArray(hierarchy) ? hierarchy : []) {
    if (!entry?.parentId || !Array.isArray(entry.childIds)) continue;
    if (entry.childIds.some((childId) => byId.has(childId))) {
      parentWithValidChild.add(entry.parentId);
    }
  }
  const leaves = validTodos.filter((t) => !parentWithValidChild.has(t.id));
  const done = leaves.filter((t) => t.status === "done").length;
  const total = leaves.length;
  if (truncated) {
    return {
      done,
      total,
      incomplete: Math.max(1, total - done),
      percent: null,
      truncated: true,
    };
  }
  return {
    done,
    total,
    incomplete: Math.max(0, total - done),
    percent: total > 0 ? Math.floor((done * 100) / total) : null,
    truncated: false,
  };
}

function normalizeAwaitingInput(raw) {
  if (!raw || typeof raw !== "object") return null;
  const requestId = String(raw.request_id || raw.requestId || "").trim();
  const question = String(raw.question || raw.prompt || raw.message || "").trim();
  if (!question && !requestId) return null;
  const choices = Array.isArray(raw.choices) ? raw.choices.map((c) => String(c)) : [];
  const isElicitation = Boolean(raw.is_elicitation || raw.kind === "elicitation" || raw.mcp_server);
  const allowFreeform = raw.allow_freeform !== undefined
    ? Boolean(raw.allow_freeform)
    : raw.allowFreeform !== undefined
      ? Boolean(raw.allowFreeform)
      : choices.length === 0;
  return {
    requestId,
    question: question || "Input required",
    choices,
    allowFreeform,
    isElicitation,
  };
}

function normalizePendingPlan(raw) {
  if (!raw || typeof raw !== "object") return null;
  const requestId = String(raw.request_id || raw.requestId || "").trim();
  const summary = String(raw.summary || raw.plan_summary || "").trim();
  if (!requestId && !summary) return null;
  return {
    requestId,
    summary: summary || "Plan awaiting review.",
  };
}

function buildProgressFingerprint({ todos = [], headSha = "" }) {
  const todoSummary = todos.map((t) => `${t.id}:${t.status}`).sort().join(",");
  const hash = createHash("sha256").update(todoSummary).digest("hex").slice(0, 12);
  return `todos:${hash}|head:${headSha || "-"}`;
}

function normalizeRepoSlug(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return isRepoFullName(trimmed) ? trimmed : null;
}

function normalizeCachedPr(cached) {
  if (!cached || typeof cached !== "object") return null;
  // Support canonical pr-statusline/pr-cache.json format: { info: { state, title, mergedAt, statusCheckRollup }, checkedAt, lastError }
  if ("info" in cached || "checkedAt" in cached || "lastError" in cached) {
    const info = cached.info && typeof cached.info === "object" ? cached.info : null;
    if (!info) {
      return {
        state: null,
        title: null,
        headRefOid: null,
        ciStatus: "unknown",
        ciPassed: null,
        ciTotal: null,
        checkedAt: Number.isFinite(cached.checkedAt) ? cached.checkedAt : null,
        stale: Boolean(cached.lastError),
      };
    }
    const rawState = String(info.state || "").toUpperCase();
    const state = rawState === "MERGED" || info.mergedAt ? "MERGED" : rawState === "CLOSED" ? "CLOSED" : rawState === "OPEN" ? "OPEN" : null;
    const checks = Array.isArray(info.statusCheckRollup) ? info.statusCheckRollup : null;
    let ciStatus = "unknown";
    let ciPassed = null;
    let ciTotal = null;
    if (checks && checks.length > 0 && !cached.lastError) {
      let passed = 0;
      let running = 0;
      let failed = 0;
      let unknown = 0;
      for (const check of checks) {
        const conclusion = String(check?.conclusion ?? "").toUpperCase();
        const status = String(check?.status ?? "").toUpperCase();
        const checkState = String(check?.state ?? "").toUpperCase();
        if (
          ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"].includes(status) ||
          checkState === "PENDING" ||
          (status && status !== "COMPLETED" && !conclusion)
        ) {
          running += 1;
        } else if (
          ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion) ||
          ["FAILURE", "ERROR"].includes(checkState)
        ) {
          failed += 1;
        } else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion) || checkState === "SUCCESS") {
          passed += 1;
        } else {
          unknown += 1;
        }
      }
      const total = checks.length;
      ciPassed = passed;
      ciTotal = total;
      ciStatus = running > 0 ? "running" : failed > 0 ? "failed" : unknown > 0 ? "unknown" : "passed";
    }
    const headFromCommits = info.commits?.nodes?.[0]?.commit?.oid;
    const rawHead = info.headRefOid || info.headOid || headFromCommits || null;
    return {
      state,
      title: typeof info.title === "string" && info.title.trim() ? info.title.trim() : null,
      headRefOid: typeof rawHead === "string" && rawHead.trim() ? rawHead.trim().toLowerCase() : null,
      ciStatus,
      ciPassed,
      ciTotal,
      checkedAt: Number.isFinite(cached.checkedAt) ? cached.checkedAt : null,
      stale: Boolean(cached.lastError),
    };
  }
  return {
    state: typeof cached.state === "string" ? cached.state.toUpperCase() : null,
    title: typeof cached.title === "string" ? cached.title : null,
    headRefOid: typeof cached.headRefOid === "string" && cached.headRefOid.trim() ? cached.headRefOid.trim().toLowerCase() : null,
    ciStatus: cached.status || cached.ciStatus || "unknown",
    ciPassed: cached.passed ?? null,
    ciTotal: cached.total ?? null,
    checkedAt: null,
    stale: false,
  };
}

function mergeSubagentRecords(boardAgents = [], tailAgents = []) {
  const merged = new Map();
  for (const agent of Array.isArray(boardAgents) ? boardAgents : []) {
    if (!agent?.id || agent.role === "primary" || agent.id === "primary") continue;
    merged.set(String(agent.id), {
      id: String(agent.id),
      name: String(agent.name || agent.id),
      state: String(agent.state || "unknown"),
      error: typeof agent.error === "string" && agent.error ? agent.error : null,
      updatedAt: typeof agent.updatedAt === "string" ? agent.updatedAt : null,
    });
  }
  for (const tail of Array.isArray(tailAgents) ? tailAgents : []) {
    if (!tail?.id || tail.id === "primary") continue;
    const id = String(tail.id);
    const existing = merged.get(id);
    if (!existing) {
      merged.set(id, {
        id,
        name: String(tail.name || id),
        state: String(tail.state || "working"),
        error: typeof tail.error === "string" && tail.error ? tail.error : null,
        updatedAt: typeof tail.updatedAt === "string" ? tail.updatedAt : null,
      });
      continue;
    }
    const existingMs = existing.updatedAt ? Date.parse(existing.updatedAt) : NaN;
    const tailMs = tail.updatedAt ? Date.parse(tail.updatedAt) : NaN;
    const tailIsNewerOrSame = !Number.isFinite(existingMs) || (Number.isFinite(tailMs) && tailMs >= existingMs);
    if (tailIsNewerOrSame) {
      existing.state = String(tail.state || existing.state);
      if (tail.updatedAt) existing.updatedAt = tail.updatedAt;
    }
    if (existing.state === "failed" && !existing.error && typeof tail.error === "string" && tail.error) {
      existing.error = tail.error;
    } else if (existing.state !== "failed") {
      existing.error = null;
    }
  }
  return [...merged.values()];
}

function enrichPrList(catalogEntry, localEntry, prCache = {}) {
  const byUrl = new Map();
  const catUrl = catalogEntry?.pr_url || catalogEntry?.pull_request_url || catalogEntry?.created_pr_html_url || null;
  const catRepo = normalizeRepoSlug(catalogEntry?.repo_full_name || catalogEntry?.repository || localEntry?.repository);
  const catNum = Number(catalogEntry?.pr_number || catalogEntry?.pull_request_number || catalogEntry?.created_pr_number || 0);
  const synthesizedCatUrl = catUrl || (catRepo && catNum > 0 ? `https://github.com/${catRepo}/pull/${catNum}` : null);
  const catHead = typeof catalogEntry?.pr_head_sha === "string" && catalogEntry.pr_head_sha.trim()
    ? catalogEntry.pr_head_sha.trim().toLowerCase()
    : null;
  const catState = typeof catalogEntry?.pr_state === "string" && catalogEntry.pr_state.trim()
    ? catalogEntry.pr_state.trim().toUpperCase()
    : null;
  const catTitle = typeof catalogEntry?.pr_title === "string" && catalogEntry.pr_title.trim()
    ? catalogEntry.pr_title.trim()
    : null;

  function buildReconciledPr({ url, reference, boardPr = null, matchesCatalog = false }) {
    const rawCached = prCache[url] || (reference ? prCache[reference] : null) || null;
    const cached = normalizeCachedPr(rawCached);
    const boardHead = typeof boardPr?.headRefOid === "string" && boardPr.headRefOid.trim()
      ? boardPr.headRefOid.trim().toLowerCase()
      : null;
    const boardObservedMs = boardPr?.ci?.observedAt ? Date.parse(boardPr.ci.observedAt) : NaN;
    const cacheNewerThanBoard =
      cached &&
      !cached.stale &&
      cached.checkedAt != null &&
      (!Number.isFinite(boardObservedMs) || cached.checkedAt >= boardObservedMs);

    const selectedHead =
      (matchesCatalog && catHead) ||
      (cacheNewerThanBoard && cached?.headRefOid ? cached.headRefOid : null) ||
      boardHead ||
      cached?.headRefOid ||
      null;

    // State reconciliation: prefer explicit catalog state, then terminal/newer non-stale cache state, then board state.
    const boardState = typeof boardPr?.state === "string" ? boardPr.state.toUpperCase() : null;
    const cachedTerminalUpgrade =
      cached && !cached.stale && cached.state && (cached.state === "MERGED" || cached.state === "CLOSED");
    const state =
      (matchesCatalog && catState) ||
      (cached && !cached.stale && cached.state && (cacheNewerThanBoard || cachedTerminalUpgrade || !boardState) ? cached.state : null) ||
      boardState ||
      "OPEN";

    const title =
      (matchesCatalog && catTitle) ||
      (cached && !cached.stale && cached.title && (cacheNewerThanBoard || !boardPr?.title) ? cached.title : null) ||
      boardPr?.title ||
      reference ||
      "Pull request";

    // Strict head-verified CI selection: reuse CI only when its recorded head matches selectedHead!
    const cacheHeadMatches = Boolean(
      cached &&
      !cached.stale &&
      selectedHead &&
      cached.headRefOid &&
      cached.headRefOid === selectedHead,
    );
    const boardCiHead = typeof boardPr?.ci?.headRefOid === "string" ? boardPr.ci.headRefOid.trim().toLowerCase() : null;
    const boardHeadMatches = Boolean(selectedHead && boardCiHead && boardCiHead === selectedHead);

    let ciStatus = "unknown";
    let ciPassed = null;
    let ciTotal = null;
    if (cacheHeadMatches && (!boardHeadMatches || cacheNewerThanBoard)) {
      ciStatus = cached.ciStatus || "unknown";
      ciPassed = cached.ciPassed ?? null;
      ciTotal = cached.ciTotal ?? null;
    } else if (boardHeadMatches) {
      ciStatus = boardPr.ci?.status || "unknown";
      ciPassed = boardPr.ci?.passed ?? null;
      ciTotal = boardPr.ci?.total ?? null;
    }

    const parts = catRepo ? catRepo.split("/") : [];
    const parsedNum = Number((url.match(/\/pull\/([1-9]\d*)/) || [])[1] || (matchesCatalog ? catNum : 0));
    return {
      url,
      deepLink: parts.length === 2 && parsedNum > 0 ? buildPullRequestDeepLink({ owner: parts[0], repo: parts[1], number: parsedNum }) : null,
      reference: reference || url,
      title: String(title).trim(),
      state,
      headRefOid: selectedHead,
      ciStatus,
      ciPassed,
      ciTotal,
      stale: Boolean(cached?.stale),
    };
  }

  const boardPrs = localEntry?.board?.references?.prs;
  if (Array.isArray(boardPrs)) {
    for (const pr of boardPrs) {
      if (pr?.url) {
        byUrl.set(
          pr.url,
          buildReconciledPr({
            url: pr.url,
            reference: pr.reference || pr.url,
            boardPr: pr,
            matchesCatalog: Boolean(synthesizedCatUrl && pr.url === synthesizedCatUrl),
          }),
        );
      }
    }
  }

  if (synthesizedCatUrl && !byUrl.has(synthesizedCatUrl)) {
    byUrl.set(
      synthesizedCatUrl,
      buildReconciledPr({
        url: synthesizedCatUrl,
        reference: catRepo && catNum > 0 ? `${catRepo}#${catNum}` : synthesizedCatUrl,
        boardPr: null,
        matchesCatalog: true,
      }),
    );
  }

  return [...byUrl.values()];
}

function resolveBoardOperatorState(board, todos, rootCancelled = false) {
  if (!board || typeof board !== "object" || rootCancelled) {
    return { waiting: false, message: null };
  }
  const activeGoalId = board.activeGoalId || null;
  const goals = Array.isArray(board.goals) ? board.goals : [];
  const activeGoal = activeGoalId ? goals.find((goal) => goal?.id === activeGoalId) || null : null;
  const effectiveDelivery = activeGoal?.delivery || board.delivery || null;
  const awaitingMergeApproval = effectiveDelivery?.phase === "awaiting_merge_approval";

  const todoStatusById = new Map((todos || []).map((t) => [t.id, t.status]));
  for (const gt of activeGoal?.tasks || []) {
    if (gt?.id && !todoStatusById.has(gt.id)) todoStatusById.set(gt.id, gt.status);
  }
  const activeTaskIds = activeGoal && Array.isArray(activeGoal.taskIds)
    ? new Set(activeGoal.taskIds)
    : new Set(todoStatusById.keys());
  const agents = Array.isArray(board.agents) ? board.agents : [];

  const boardAttentionItem = Array.isArray(board.attention) && board.attention.length > 0
    ? board.attention[0]
    : null;
  const boardOperatorReport = Array.isArray(board.operatorReports)
    ? board.operatorReports.find((report) => {
        if (!report || report.superseded === true || report.requiresOperator !== true) return false;
        if (report.taskId && todoStatusById.get(report.taskId) === "done") return false;
        if (report.taskId && activeGoal && !activeTaskIds.has(report.taskId)) return false;
        if (!report.taskId && report.goalId === null) return true;
        if (report.goalId != null) return report.goalId === activeGoalId;
        if (!activeGoalId) return true;
        if (report.taskId) return activeTaskIds.has(report.taskId);
        return agents.some((agent) => agent?.id === report.actorId && agent.goalId === activeGoalId);
      }) || null
    : null;

  const waiting = Boolean(boardAttentionItem || boardOperatorReport || awaitingMergeApproval);
  const message =
    boardAttentionItem?.message ||
    boardOperatorReport?.message ||
    (awaitingMergeApproval ? "Awaiting final merge approval." : null);
  return { waiting, message };
}

export function createFleetService({
  hostSessionId,
  executeHostTool = null,
  askHostAgent = null,
  workerClient,
  watchdog = null,
  createWatchdog = null,
  acquireLeader = null,
  pollIntervalMs = 5000,
  maxPollIntervalMs = 30000,
  slowRpcThresholdMs = 250,
  onChange = () => {},
  now = Date.now,
} = {}) {
  const activeViewers = new Set();
  let viewerEpoch = 0;
  let pollTimer = null;
  let effectivePollMs = pollIntervalMs;
  let inFlightRefresh = null;
  let hostToolsAvailable = Boolean(executeHostTool);
  let selectedSessionId = null;
  let stopped = false;
  let leaderLease = null;
  let resolvedWatchdog = watchdog;
  let watchdogInitPromise = null;

  async function releaseLeader() {
    if (!leaderLease) return;
    const current = leaderLease;
    leaderLease = null;
    await current.close?.().catch(() => {});
  }

  async function ensureLeaderIfActive() {
    if (stopped || activeViewers.size === 0 || !acquireLeader || leaderLease) return;
    const epochAtStart = viewerEpoch;
    const acquired = await Promise.resolve(acquireLeader()).catch(() => null);
    if (stopped || activeViewers.size === 0 || viewerEpoch !== epochAtStart) {
      await acquired?.close?.().catch(() => {});
      return;
    }
    leaderLease = acquired;
  }

  async function ensureWatchdog() {
    if (resolvedWatchdog) return resolvedWatchdog;
    if (!createWatchdog) return null;
    watchdogInitPromise ||= Promise.resolve(
      createWatchdog({ isLeader: () => leaderLease !== null }),
    ).then((instance) => {
      resolvedWatchdog = instance;
      return instance;
    });
    return watchdogInitPromise;
  }

  let state = {
    revision: 0,
    lastRefresh: null,
    hostToolsAvailable,
    coordinatorScoped: false,
    pollIntervalMs: effectivePollMs,
    selectedSessionId: null,
    selectedDetail: null,
    recoveryPolicy: watchdog?.getPolicy?.() || "off",
    recoveryHistory: [],
    summary: {
      totalSessions: 0,
      busy: 0,
      waiting: 0,
      attention: 0,
      idle: 0,
      totalProjects: 0,
    },
    projects: [],
    sessions: [],
    inbox: [],
    workflows: [],
    error: null,
  };

  async function safeToolCall(name, args = {}) {
    if (!executeHostTool) return { ok: false, unavailable: true, data: null };
    try {
      const raw = await executeHostTool(name, args);
      return { ok: true, unavailable: false, data: extractJsonPayload(raw) };
    } catch (error) {
      const msg = String(error?.message || error);
      if (/unknown tool|not found|unsupported|unavailable/i.test(msg)) {
        return { ok: false, unavailable: true, error: msg, data: null };
      }
      return { ok: false, unavailable: false, error: msg, data: null };
    }
  }

  function scheduleNextTick() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (stopped || activeViewers.size === 0) return;
    pollTimer = setTimeout(() => {
      if (stopped || activeViewers.size === 0) return;
      void refreshFleet().catch(() => {}).finally(() => {
        if (!stopped && activeViewers.size > 0) scheduleNextTick();
      });
    }, effectivePollMs);
    pollTimer.unref?.();
  }

  async function clearAllViewers() {
    if (activeViewers.size > 0) viewerEpoch += 1;
    inFlightRefresh = null;
    activeViewers.clear();
    clearTimeout(pollTimer);
    pollTimer = null;
    await Promise.all([
      workerClient?.stop?.().catch(() => {}),
      releaseLeader(),
    ]);
  }

  async function setViewerActive(instanceId, active) {
    if (!instanceId || stopped) return;
    if (active) {
      const activateEpoch = viewerEpoch;
      const wasEmpty = activeViewers.size === 0;
      activeViewers.add(instanceId);
      if (wasEmpty) {
        await refreshFleet();
        if (!stopped && activeViewers.has(instanceId) && viewerEpoch === activateEpoch) {
          scheduleNextTick();
        }
      }
    } else {
      activeViewers.delete(instanceId);
      if (activeViewers.size === 0) {
        viewerEpoch += 1;
        inFlightRefresh = null;
        clearTimeout(pollTimer);
        pollTimer = null;
        await Promise.all([
          workerClient?.stop?.().catch(() => {}),
          releaseLeader(),
        ]);
      }
    }
  }

  async function refreshFleet() {
    if (inFlightRefresh) return inFlightRefresh;
    const refreshEpoch = viewerEpoch;
    let currentRefresh = null;
    currentRefresh = (async () => {
      const rpcStart = performance.now();
      const [localResult, reposRes, catalogRes, statusRes, workflowsRes] = await Promise.all([
        workerClient ? workerClient.scan().catch(() => ({ sessions: [], prCache: {}, stats: {} })) : Promise.resolve({ sessions: [], prCache: {}, stats: {} }),
        safeToolCall("list_repositories"),
        safeToolCall("list_sessions_and_chats"),
        safeToolCall("get_sessions_status"),
        safeToolCall("list_workflows"),
      ]);
      const rpcElapsed = performance.now() - rpcStart;
      if (executeHostTool) {
        if (rpcElapsed > slowRpcThresholdMs) {
          effectivePollMs = Math.min(maxPollIntervalMs, effectivePollMs * 2);
        } else {
          effectivePollMs = pollIntervalMs;
        }
      }

      hostToolsAvailable = Boolean(executeHostTool) && !(catalogRes.unavailable && statusRes.unavailable);

      const repositories = asArray(reposRes.data, "repositories", "containers", "items");
      const catalogItems = asArray(catalogRes.data, "sessions", "items");
      const statusItems = asArray(statusRes.data, "sessions", "statuses", "items");
      const workflows = asArray(workflowsRes.data, "workflows", "automations", "items");

      const statusById = new Map();
      for (const st of statusItems) {
        const id = String(st?.id || st?.session_id || st?.project_session_id || "");
        if (id) statusById.set(id, st);
      }

      const localById = new Map();
      for (const loc of localResult.sessions || []) {
        localById.set(loc.id, loc);
        if (loc.mcSessionId) localById.set(loc.mcSessionId, loc);
      }

      // Coordinator scoping check: when get_sessions_status returns a non-empty subset smaller than catalog.
      const unarchivedCatalog = catalogItems.filter((item) => !item?.archived_at);
      const coordinatorScoped =
        statusRes.ok &&
        statusById.size > 0 &&
        unarchivedCatalog.length > statusById.size &&
        unarchivedCatalog.some((item) => {
          const id = String(item?.id || item?.session_id || "");
          return id && !statusById.has(id);
        });

      const mergedSessions = [];
      const consumedLocalIds = new Set();
      for (const item of catalogItems) {
        if (!item?.archived_at) continue;
        const archivedId = String(item?.id || item?.session_id || "");
        if (!archivedId) continue;
        consumedLocalIds.add(archivedId);
        const archivedLocal = localById.get(archivedId);
        if (archivedLocal) {
          consumedLocalIds.add(archivedLocal.id);
          if (archivedLocal.mcSessionId) consumedLocalIds.add(archivedLocal.mcSessionId);
        }
      }

      for (const cat of unarchivedCatalog) {
        const id = String(cat?.id || cat?.session_id || "");
        if (!id) continue;
        const st = statusById.get(id) || null;
        const loc = localById.get(id) || null;
        if (loc) {
          consumedLocalIds.add(loc.id);
          if (loc.mcSessionId) consumedLocalIds.add(loc.mcSessionId);
        }

        const repo = normalizeRepoSlug(
          cat.repo_full_name || cat.github_repo || st?.repo_full_name || loc?.repository,
        );
        const isChat = Boolean(cat.session_kind === "chat" || cat.kind === "chat" || (!repo && !cat.path && !loc?.cwd));
        const surface = isChat ? "chat" : "desktop";

        const rawInputs = Array.isArray(st?.awaiting_inputs) && st.awaiting_inputs.length > 0
          ? st.awaiting_inputs[0]
          : st?.awaiting_input;
        const rawPlans = Array.isArray(st?.pending_plans) && st.pending_plans.length > 0
          ? st.pending_plans[0]
          : st?.pending_plan;

        const awaitingInput = normalizeAwaitingInput(rawInputs) || loc?.tailState?.awaitingInput || null;
        const pendingPlan = normalizePendingPlan(rawPlans) || loc?.tailState?.pendingPlan || null;
        const pendingPermission = loc?.tailState?.pendingPermission || null;
        const pendingElicitation =
          (awaitingInput?.isElicitation ? awaitingInput : null) || loc?.tailState?.pendingElicitation || null;

        const todos = loc?.todos || [];
        const rootCancelled = Boolean(loc?.tailState?.rootCancelled);
        const boardOp = resolveBoardOperatorState(loc?.board, todos, rootCancelled);
        const serverAttention = !rootCancelled && String(loc?.liveServer?.status || "").toLowerCase() === "attention";

        let activity = String(st?.activity || st?.status || loc?.liveServer?.status || loc?.tailState?.activity || "idle").toLowerCase();
        if (activity === "working") activity = "busy";
        if (activity === "attention") activity = "waiting";
        const awaitingOperator = Boolean(
          activity === "waiting" ||
          serverAttention ||
          boardOp.waiting ||
          awaitingInput ||
          pendingPlan ||
          pendingPermission ||
          pendingElicitation,
        );
        if (awaitingOperator) activity = "waiting";
        const operatorAttentionMessage =
          boardOp.message ||
          (serverAttention ? `Awaiting operator (${loc.liveServer.attentionKind || "attention"}).` : null);

        const hierarchy = loc?.board?.hierarchy || [];
        const leafMetrics = computeLeafMetrics(todos, hierarchy, { truncated: Boolean(loc?.todosTruncated) });
        const prs = enrichPrList(cat, loc, localResult.prCache);
        const subagents = mergeSubagentRecords(loc?.board?.agents, loc?.tailState?.subagents);
        const failedSubagents = subagents.filter((a) => a.state === "failed");

        const wasInterrupted = Boolean(st?.was_interrupted || st?.interrupted);
        const interruptionReason = st?.interruption_reason ? String(st.interruption_reason) : null;
        const lastError = loc?.tailState?.lastError || null;
        const errorStamp = lastError?.at ? Date.parse(lastError.at) : NaN;
        const failedAtMs = Number.isFinite(errorStamp) ? errorStamp : null;

        const deepLink = safeDeepLinkUrl(cat.app_url) || buildSessionDetailDeepLink(id);
        const restartDeepLink = buildSessionRestartDeepLink(id);
        const unverifiedCoordinatorOmission = Boolean(
          coordinatorScoped && !st && surface === "desktop" && (!loc?.tailState || loc.tailState.truncatedStart),
        );

        mergedSessions.push({
          id,
          title: String(cat.name || cat.title || loc?.name || id),
          surface,
          repo,
          projectName: repo || String(cat.project_name || (isChat ? "Standalone Chats" : "Local Workspaces")),
          branch: String(cat.branch || st?.branch || loc?.branch || ""),
          mode: String(st?.mode || cat.mode || "interactive"),
          activity,
          lifecycleUnknown: Boolean(
            activity !== "waiting" &&
              ((!st?.activity && !st?.status && !loc?.liveServer?.status && loc?.tailState?.lifecycleUnknown) ||
                unverifiedCoordinatorOmission),
          ),
          rootCancelled,
          busyDurationMs: Number.isFinite(st?.busy_duration_ms) ? st.busy_duration_ms : null,
          wasInterrupted,
          interruptionReason,
          lastError,
          failedAtMs,
          awaitingOperator,
          operatorAttentionMessage,
          awaitingInput: awaitingInput && !awaitingInput.isElicitation ? awaitingInput : null,
          pendingPlan,
          pendingPermission,
          pendingElicitation,
          taskProgress: {
            done: leafMetrics.done,
            total: leafMetrics.total,
            percent: leafMetrics.percent,
            truncated: Boolean(leafMetrics.truncated),
          },
          incompleteLeafCount: leafMetrics.incomplete,
          resumableWorkflowCount: (loc?.workflows || []).filter((w) => w.status === "paused" || w.status === "failed").length,
          todos,
          dependencies: loc?.dependencies || [],
          plan: loc?.plan || { exists: false, content: null },
          subagents,
          failedSubagents,
          prs,
          deepLink,
          restartDeepLink,
          updatedAt: String(cat.updated_at || loc?.updatedAt || new Date(now()).toISOString()),
          progressFingerprint: buildProgressFingerprint({
            todos,
            headSha: prs[0]?.headRefOid || "",
          }),
        });
      }

      // Append standalone CLI or local-only sessions not present in desktop catalog.
      for (const loc of localResult.sessions || []) {
        if (consumedLocalIds.has(loc.id) || (loc.mcSessionId && consumedLocalIds.has(loc.mcSessionId))) continue;
        const isCli = !loc.clientName || /cli/i.test(loc.clientName);
        const surface = isCli ? "cli" : "desktop";
        const repo = normalizeRepoSlug(loc.repository);
        const todos = loc.todos || [];
        const hierarchy = loc.board?.hierarchy || [];
        const leafMetrics = computeLeafMetrics(todos, hierarchy, { truncated: Boolean(loc.todosTruncated) });
        const prs = enrichPrList(null, loc, localResult.prCache);
        const subagents = mergeSubagentRecords(loc.board?.agents, loc.tailState?.subagents);
        const failedSubagents = subagents.filter((a) => a.state === "failed");

        const awaitingInput = loc.tailState?.awaitingInput || null;
        const pendingPlan = loc.tailState?.pendingPlan || null;
        const pendingPermission = loc.tailState?.pendingPermission || null;
        const pendingElicitation = loc.tailState?.pendingElicitation || null;

        const cliProcessAlive = !(surface === "cli" && loc.lockState?.hasLockFile && !loc.lockState.alive);
        const rootCancelled = Boolean(loc.tailState?.rootCancelled);
        const boardOp = resolveBoardOperatorState(loc.board, todos, rootCancelled || !cliProcessAlive);
        const serverAttention = cliProcessAlive && !rootCancelled && String(loc.liveServer?.status || "").toLowerCase() === "attention";

        let activity = String(loc.liveServer?.status || loc.tailState?.activity || (loc.lockState?.alive ? "idle" : "idle")).toLowerCase();
        if (activity === "working") activity = "busy";
        if (activity === "attention") activity = "waiting";
        if (!cliProcessAlive) {
          activity = "idle";
        }
        const awaitingOperator = Boolean(
          cliProcessAlive &&
            (activity === "waiting" ||
              serverAttention ||
              boardOp.waiting ||
              awaitingInput ||
              pendingPlan ||
              pendingPermission ||
              pendingElicitation),
        );
        if (awaitingOperator) {
          activity = "waiting";
        }
        const operatorAttentionMessage =
          boardOp.message ||
          (serverAttention ? `Awaiting operator (${loc.liveServer.attentionKind || "attention"}).` : null);

        const errorStamp = loc.tailState?.lastError?.at ? Date.parse(loc.tailState.lastError.at) : NaN;
        mergedSessions.push({
          id: loc.id,
          title: String(loc.name || loc.liveServer?.sessionName || loc.branch || loc.id),
          surface,
          repo,
          projectName: repo || (surface === "cli" ? "CLI Terminals" : "Local Workspaces"),
          branch: String(loc.branch || loc.liveServer?.branch || ""),
          mode: "interactive",
          activity,
          lifecycleUnknown: Boolean(!loc.liveServer?.status && loc.tailState?.lifecycleUnknown && activity !== "waiting"),
          rootCancelled: Boolean(loc.tailState?.rootCancelled),
          busyDurationMs: null,
          wasInterrupted: false,
          interruptionReason: null,
          lastError: loc.tailState?.lastError || null,
          failedAtMs: Number.isFinite(errorStamp) ? errorStamp : null,
          lockState: loc.lockState,
          awaitingOperator,
          operatorAttentionMessage,
          awaitingInput: cliProcessAlive ? awaitingInput : null,
          pendingPlan: cliProcessAlive ? pendingPlan : null,
          pendingPermission: cliProcessAlive ? pendingPermission : null,
          pendingElicitation: cliProcessAlive ? pendingElicitation : null,
          taskProgress: {
            done: leafMetrics.done,
            total: leafMetrics.total,
            percent: leafMetrics.percent,
            truncated: Boolean(leafMetrics.truncated),
          },
          incompleteLeafCount: leafMetrics.incomplete,
          resumableWorkflowCount: (loc.workflows || []).filter((w) => w.status === "paused" || w.status === "failed").length,
          todos,
          dependencies: loc.dependencies || [],
          plan: loc.plan || { exists: false, content: null },
          subagents,
          failedSubagents,
          prs,
          deepLink: surface === "desktop" ? buildSessionDetailDeepLink(loc.id) : null,
          restartDeepLink: surface === "desktop" ? buildSessionRestartDeepLink(loc.id) : null,
          updatedAt: loc.updatedAt,
          progressFingerprint: buildProgressFingerprint({
            todos,
            headSha: prs[0]?.headRefOid || "",
          }),
        });
      }

      // Bail out immediately if all fleet viewers closed or shutdown ran while discovery RPCs were in flight.
      if (stopped || refreshEpoch !== viewerEpoch) {
        return structuredClone(state);
      }

      // Evaluate recovery watchdog on merged sessions; retry leader acquisition only while fleet views remain active.
      if (!stopped && activeViewers.size > 0 && refreshEpoch === viewerEpoch) {
        await ensureLeaderIfActive();
      }
      const activeWatchdog = await ensureWatchdog();
      const canDispatchRecovery = () =>
        !stopped &&
        activeViewers.size > 0 &&
        refreshEpoch === viewerEpoch &&
        (acquireLeader ? leaderLease !== null : true);
      const recoveryEvaluations = activeWatchdog
        ? await activeWatchdog.evaluate(mergedSessions, { canDispatch: canDispatchRecovery })
        : {};

      // Build unified operator Attention Inbox.
      const inbox = [];
      for (const session of mergedSessions) {
        const rec = recoveryEvaluations[session.id] || null;
        session.recovery = rec;

        if (session.awaitingInput) {
          inbox.push({
            id: `ask:${session.id}:${session.awaitingInput.requestId || "live"}`,
            kind: "ask_user",
            priority: 1,
            sessionId: session.id,
            sessionTitle: session.title,
            projectName: session.projectName,
            surface: session.surface,
            requestId: session.awaitingInput.requestId,
            question: session.awaitingInput.question,
            choices: session.awaitingInput.choices,
            allowFreeform: session.awaitingInput.allowFreeform,
            canAnswerInline: session.surface !== "cli" && Boolean(session.awaitingInput.requestId) && hostToolsAvailable,
            deepLink: session.deepLink,
          });
        }
        if (session.pendingPlan) {
          inbox.push({
            id: `plan:${session.id}:${session.pendingPlan.requestId || "live"}`,
            kind: "pending_plan",
            priority: 2,
            sessionId: session.id,
            sessionTitle: session.title,
            projectName: session.projectName,
            surface: session.surface,
            requestId: session.pendingPlan.requestId,
            summary: session.pendingPlan.summary,
            planContent: session.plan?.content || null,
            canRespondInline: session.surface !== "cli" && Boolean(session.pendingPlan.requestId) && hostToolsAvailable,
            deepLink: session.deepLink,
          });
        }
        if (session.pendingPermission || session.pendingElicitation) {
          const item = session.pendingPermission || session.pendingElicitation;
          inbox.push({
            id: `perm:${session.id}:${item.requestId || "live"}`,
            kind: session.pendingElicitation ? "elicitation" : "permission",
            priority: 2,
            sessionId: session.id,
            sessionTitle: session.title,
            projectName: session.projectName,
            surface: session.surface,
            message: item.message,
            deepLink: session.deepLink,
          });
        } else if (session.awaitingOperator && !session.awaitingInput && !session.pendingPlan) {
          inbox.push({
            id: `attn:${session.id}`,
            kind: "operator_attention",
            priority: 2,
            sessionId: session.id,
            sessionTitle: session.title,
            projectName: session.projectName,
            surface: session.surface,
            message: session.operatorAttentionMessage || "Session is awaiting operator attention.",
            deepLink: session.deepLink,
          });
        }
        if (rec && ["wake_verify", "attention_only", "cli_resume", "zombie_stall"].includes(rec.action)) {
          inbox.push({
            id: `rec:${session.id}`,
            kind: rec.circuitOpen ? "circuit_open" : rec.action,
            priority: 3,
            sessionId: session.id,
            sessionTitle: session.title,
            projectName: session.projectName,
            surface: session.surface,
            reason: rec.reason,
            attempts: rec.attempts,
            maxRetries: rec.maxRetries,
            canWakeInline: session.surface !== "cli" && rec.action !== "attention_only" && hostToolsAvailable,
            resumeCommand: rec.resumeCommand || null,
            deepLink: session.deepLink,
            restartDeepLink: session.restartDeepLink,
          });
        }
      }
      inbox.sort((a, b) => a.priority - b.priority || a.sessionTitle.localeCompare(b.sessionTitle));

      // Group into Project rollups.
      const projectGroups = new Map();
      for (const repoEntry of repositories) {
        const slug = normalizeRepoSlug(repoEntry?.github_repo);
        const key = slug || String(repoEntry?.name || repoEntry?.id || "");
        if (!key) continue;
        projectGroups.set(key, {
          key,
          name: slug || String(repoEntry.name || key),
          repo: slug,
          defaultBranch: String(repoEntry?.default_branch || "main"),
          newSessionDeepLink: slug ? buildSessionDeepLink({ repo: slug }) : null,
          sessions: [],
          workflows: workflows.filter((w) => w?.project_id && w.project_id === repoEntry.id),
        });
      }

      for (const session of mergedSessions) {
        const key = session.repo || session.projectName;
        if (!projectGroups.has(key)) {
          projectGroups.set(key, {
            key,
            name: key,
            repo: session.repo,
            defaultBranch: "main",
            newSessionDeepLink: session.repo ? buildSessionDeepLink({ repo: session.repo }) : null,
            sessions: [],
            workflows: [],
          });
        }
        projectGroups.get(key).sessions.push(session);
      }

      const projects = [...projectGroups.values()]
        .filter((group) => group.sessions.length > 0 || group.workflows.length > 0)
        .map((group) => {
          const done = group.sessions.reduce((sum, s) => sum + (s.taskProgress.done || 0), 0);
          const total = group.sessions.reduce((sum, s) => sum + (s.taskProgress.total || 0), 0);
          const truncated = group.sessions.some((s) => s.taskProgress?.truncated === true);
          const attentionCount = inbox.filter((item) => group.sessions.some((s) => s.id === item.sessionId)).length;
          return {
            key: group.key,
            name: group.name,
            repo: group.repo,
            newSessionDeepLink: group.newSessionDeepLink,
            sessionCount: group.sessions.length,
            busyCount: group.sessions.filter((s) => s.activity === "busy").length,
            waitingCount: group.sessions.filter((s) => s.activity === "waiting").length,
            attentionCount,
            taskProgress: {
              done,
              total,
              percent: !truncated && total > 0 ? Math.floor((done * 100) / total) : null,
              truncated,
            },
            workflowCount: group.workflows.length,
            sessions: group.sessions,
          };
        })
        .sort((a, b) => b.attentionCount - a.attentionCount || b.busyCount - a.busyCount || a.name.localeCompare(b.name));

      const watchdogSnap = activeWatchdog?.snapshot?.() || null;
      const selectedDetail = selectedSessionId
        ? mergedSessions.find((s) => s.id === selectedSessionId) || null
        : null;

      if (stopped || refreshEpoch !== viewerEpoch) {
        return structuredClone(state);
      }

      state = {
        revision: state.revision + 1,
        lastRefresh: new Date(now()).toISOString(),
        hostToolsAvailable,
        coordinatorScoped,
        pollIntervalMs: effectivePollMs,
        selectedSessionId,
        selectedDetail,
        recoveryPolicy: watchdogSnap?.policy || "off",
        recoveryHistory: watchdogSnap?.history || [],
        summary: {
          totalSessions: mergedSessions.length,
          busy: mergedSessions.filter((s) => s.activity === "busy").length,
          waiting: mergedSessions.filter((s) => s.activity === "waiting").length,
          attention: inbox.length,
          idle: mergedSessions.filter((s) => s.activity === "idle").length,
          totalProjects: projects.length,
        },
        projects,
        sessions: mergedSessions,
        inbox,
        workflows,
        error: null,
      };
      await onChange(state);
      return structuredClone(state);
    })().finally(async () => {
      if (inFlightRefresh === currentRefresh) {
        inFlightRefresh = null;
      }
      if (stopped || activeViewers.size === 0) {
        await Promise.all([
          workerClient?.stop?.().catch(() => {}),
          releaseLeader(),
        ]);
      }
    });
    inFlightRefresh = currentRefresh;
    return currentRefresh;
  }

  async function selectSession(targetSessionId) {
    selectedSessionId = targetSessionId ? String(targetSessionId) : null;
    let detail = selectedSessionId ? state.sessions.find((s) => s.id === selectedSessionId) || null : null;
    if (selectedSessionId && executeHostTool && (!detail || detail.surface !== "cli")) {
      const detailRes = await safeToolCall("get_session", { project_session_id: selectedSessionId });
      if (detailRes.ok && detailRes.data && detail) {
        detail = { ...detail, hostMetadata: detailRes.data };
      }
    }
    state = { ...state, revision: state.revision + 1, selectedSessionId, selectedDetail: detail };
    await onChange(state);
    return detail;
  }

  async function answerInput({ targetSessionId, requestId, answer }) {
    const id = String(targetSessionId || "").trim();
    const reqId = String(requestId || "").trim();
    const text = String(answer ?? "").trim();
    if (!id || !reqId || !text) throw new Error("targetSessionId, requestId, and non-empty answer are required");
    if (!executeHostTool) throw new Error("Host input tool is unavailable in this environment");

    const session = state.sessions.find((s) => s.id === id);
    if (session?.surface === "cli") {
      throw new Error("Standalone CLI prompts must be answered in the terminal");
    }
    const prompt = session?.awaitingInput;
    if (prompt?.isElicitation || session?.pendingElicitation) {
      throw new Error("Structured MCP elicitations must be completed in the session view");
    }
    if (prompt && Array.isArray(prompt.choices) && prompt.choices.length > 0 && !prompt.allowFreeform) {
      if (!prompt.choices.includes(text)) {
        throw new Error(`Answer must match one of the allowed choices: ${prompt.choices.join(", ")}`);
      }
    }

    const raw = await executeHostTool("answer_session_input", {
      project_session_id: id,
      request_id: reqId,
      answer: text,
    });
    extractJsonPayload(raw);
    await refreshFleet();
    return { ok: true, targetSessionId: id };
  }

  async function respondPlan({ targetSessionId, requestId, approved, feedback, selectedAction }) {
    const id = String(targetSessionId || "").trim();
    const reqId = String(requestId || "").trim();
    if (!id || !reqId || typeof approved !== "boolean") {
      throw new Error("targetSessionId, requestId, and boolean approved are required");
    }
    const deepLink = buildSessionDetailDeepLink(id);
    if (!executeHostTool) {
      return { ok: false, requiresDeepLink: true, deepLink, message: "Open the session directly to review and approve its plan." };
    }

    try {
      const payload = {
        project_session_id: id,
        request_id: reqId,
        approved,
      };
      if (typeof feedback === "string" && feedback.trim()) payload.feedback = feedback.trim();
      if (approved && typeof selectedAction === "string" && selectedAction) payload.selected_action = selectedAction;
      const raw = await executeHostTool("respond_to_session_plan_v2", payload);
      extractJsonPayload(raw);
      await refreshFleet();
      return { ok: true, targetSessionId: id };
    } catch (error) {
      const msg = String(error?.message || error);
      if (/coordinat|not a child|uncoordinated|autopilot|permission|parent/i.test(msg)) {
        return {
          ok: false,
          requiresDeepLink: true,
          deepLink,
          message: "Uncoordinated root session plans require confirmation inside the session view.",
        };
      }
      throw error;
    }
  }

  async function sendMessage({ targetSessionId, message, deliveryMode = "immediate", mode }) {
    const id = String(targetSessionId || "").trim();
    const text = String(message ?? "").trim();
    if (!id || !text) throw new Error("targetSessionId and non-empty message are required");
    if (!DELIVERY_MODES.has(deliveryMode)) throw new Error("Invalid deliveryMode");
    if (mode != null && mode !== "" && !SESSION_MODES.has(mode)) throw new Error("Invalid session mode");

    const session = state.sessions.find((s) => s.id === id);
    if (session?.surface === "cli") {
      throw new Error(`Standalone CLI sessions cannot be messaged via desktop RPC; resume with: copilot --resume ${id}`);
    }
    if (session?.awaitingInput) {
      throw new Error("Target session is blocked on an input question; answer the question first before sending a message.");
    }

    if (id === hostSessionId) {
      if (!askHostAgent) throw new Error("Host session prompt forwarding is unavailable");
      await askHostAgent(text);
      return { ok: true, targetSessionId: id, selfRouted: true };
    }

    if (!executeHostTool) throw new Error("Cross-session messaging tool is unavailable in this environment");
    const args = {
      session_id: id,
      message: text,
      delivery_mode: deliveryMode,
    };
    if (mode) args.mode = mode;
    const raw = await executeHostTool("send_session_message", args);
    extractJsonPayload(raw);
    await refreshFleet();
    return { ok: true, targetSessionId: id };
  }

  async function setRecoveryPolicy(policy) {
    const activeWatchdog = await ensureWatchdog();
    if (!activeWatchdog) throw new Error("Recovery watchdog is not configured");
    const updated = await activeWatchdog.setPolicy(policy);
    state = { ...state, revision: state.revision + 1, recoveryPolicy: updated };
    if (activeViewers.size > 0) await refreshFleet();
    else await onChange(state);
    return { ok: true, policy: updated };
  }

  async function triggerRecovery({ targetSessionId }) {
    const activeWatchdog = await ensureWatchdog();
    if (!activeWatchdog) throw new Error("Recovery watchdog is not configured");
    const session = state.sessions.find((s) => s.id === targetSessionId);
    if (!session) throw new Error("Unknown session");
    const result = await activeWatchdog.triggerManual(session);
    await refreshFleet();
    return result;
  }

  async function shutdown() {
    stopped = true;
    viewerEpoch += 1;
    inFlightRefresh = null;
    activeViewers.clear();
    clearTimeout(pollTimer);
    pollTimer = null;
    await Promise.all([
      workerClient?.stop?.().catch(() => {}),
      releaseLeader(),
    ]);
  }

  return {
    refreshFleet,
    setViewerActive,
    clearAllViewers,
    selectSession,
    answerInput,
    respondPlan,
    sendMessage,
    setRecoveryPolicy,
    triggerRecovery,
    snapshot: () => structuredClone(state),
    isPolling: () => pollTimer !== null,
    currentPollIntervalMs: () => effectivePollMs,
    shutdown,
  };
}
