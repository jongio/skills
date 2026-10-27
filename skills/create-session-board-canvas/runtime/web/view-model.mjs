const list = (value) => Array.isArray(value) ? value.filter(Boolean) : [];
export const childTaskIds = (task) => [...new Set(list(task.childIds))];
export const isLeaf = (task) => childTaskIds(task).length === 0;

export function leafProgress(tasks) {
  const leaves = [...new Map(tasks.filter(isLeaf).map((task) => [task.id, task])).values()];
  const done = leaves.filter((task) => task.status === "done").length;
  const total = leaves.length;
  return { leaves, done, total, percent: total ? Math.floor(done * 100 / total) : null };
}

export function milestoneProgress(task, taskMap) {
  const pending = [...childTaskIds(task)];
  const seen = new Set([task.id]);
  const leaves = [];
  let incomplete = false;
  while (pending.length) {
    const id = pending.pop();
    if (id === task.id) incomplete = true;
    if (seen.has(id)) continue;
    seen.add(id);
    const child = taskMap.get(id);
    if (!child) {
      incomplete = true;
      continue;
    }
    if (isLeaf(child)) leaves.push(child);
    else pending.push(...childTaskIds(child));
  }
  const progress = leafProgress(leaves);
  const provided = task.subtaskProgress;
  const validProvided = provided && Number.isInteger(provided.done) && Number.isInteger(provided.total)
    && provided.done >= 0 && provided.total >= provided.done;
  if (incomplete && validProvided) return {
    done: provided.done,
    total: provided.total,
    percent: provided.percent === null || !provided.total ? null : Math.floor(provided.done * 100 / provided.total),
    incomplete: true,
    fromBackend: true,
  };
  return { ...progress, percent: incomplete ? null : progress.percent, incomplete, fromBackend: false };
}

export function timestamp(value) {
  const parsed = new Date(value ?? "").getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function latestReports(reports) {
  const latest = new Map();
  list(reports).forEach((report, index) => {
    const key = JSON.stringify([report.goalId ?? null, report.actorId ?? "", report.taskId ?? ""]);
    const previous = latest.get(key);
    const order = previous && Number.isFinite(report.sequence) && Number.isFinite(previous.report.sequence)
      ? report.sequence - previous.report.sequence
      : timestamp(report.at) - timestamp(previous?.report.at);
    if (!previous || order > 0 || (order === 0 && index > previous.index)) {
      latest.set(key, { report, index });
    }
  });
  return [...latest.values()].map(({ report }) => report);
}

export function taskGoalIds(taskId, { goals = [], taskMap } = {}) {
  const explicitGoal = taskMap?.get(taskId)?.goalId;
  if (explicitGoal != null) return [explicitGoal];
  return list(goals).filter((goal) => list(goal.taskIds).includes(taskId)).map((goal) => goal.id);
}

export function scopedReports(reports, scope = {}) {
  return latestReports(reports).filter((report) => {
    if (report.superseded === true) return false;
    if (scope.selectedGoalId != null) {
      return report.goalId === scope.selectedGoalId || (!report.taskId && report.goalId == null);
    }
    if (!report.taskId) return true;
    const goalIds = taskGoalIds(report.taskId, scope);
    return goalIds.length ? goalIds.includes(report.goalId) : report.goalId == null;
  });
}

export function scopedTaskReports(reports, taskId, scope) {
  return scopedReports(reports, scope).filter((report) => report.taskId === taskId);
}

export function operatorRequests(model, activeTaskIds, taskMap) {
  return latestReports(model.reports).filter((report) => {
    if (report.superseded === true || report.requiresOperator !== true
      || taskMap.get(report.taskId)?.status === "done") return false;
    if (report.goalId != null) return report.goalId === model.activeGoalId;
    if (!model.activeGoalId) return true;
    if (report.taskId) return activeTaskIds.has(report.taskId);
    return list(model.agents).some((agent) => agent.id === report.actorId && agent.goalId === model.activeGoalId);
  });
}

export function dependencyIds(task, dependencies) {
  return [...new Set([
    ...list(task.waitingOn),
    ...dependencies.filter((dependency) => dependency.todoId === task.id).map((dependency) => dependency.dependsOn),
  ])].filter((id) => id != null && id !== "");
}

export function waitingFor(task, dependencies, taskMap) {
  return dependencyIds(task, dependencies).filter((id) => taskMap.get(id)?.status !== "done");
}

export function isBlockingReport(report) {
  return report.status === "blocked" || report.status === "failed";
}

export function blockingReportLabel(report) {
  return report.status === "failed" ? "Failed report" : "Blocked report";
}

export function blockerEntries(tasks, dependencies, taskMap, reports, scope) {
  const blockers = scopedReports(reports, scope).filter(isBlockingReport);
  return tasks.map((task) => ({
    task,
    waiting: waitingFor(task, dependencies, taskMap),
    reports: blockers.filter((report) => report.taskId === task.id),
  })).filter((entry) => entry.task.status === "blocked" || entry.waiting.length || entry.reports.length);
}

export function sessionBlockerReports(reports, selectedGoalId) {
  return scopedReports(reports, { selectedGoalId }).filter((report) => isBlockingReport(report) && !report.taskId);
}

export function safeHttpsUrl(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function ciSnapshot(pr) {
  const ci = pr?.ci || {};
  const prHead = typeof pr?.headRefOid === "string" && pr.headRefOid ? pr.headRefOid : null;
  const ciHead = typeof ci.headRefOid === "string" && ci.headRefOid ? ci.headRefOid : null;
  const headVerified = Boolean(prHead && ciHead && prHead === ciHead);
  const names = (checks) => list(checks).map((check) => typeof check === "string"
    ? check : typeof check.name === "string" ? check.name : typeof check.context === "string" ? check.context : "Unnamed check");
  const pendingChecks = names(ci.pendingChecks);
  const failedChecks = names(ci.failedChecks);
  const countsKnown = Number.isInteger(ci.passed) && Number.isInteger(ci.total)
    && ci.total > 0 && ci.passed >= 0 && ci.passed <= ci.total;
  let status = headVerified && ["pending", "running", "passed", "failed"].includes(ci.status) ? ci.status : "unknown";
  let reason = !prHead ? "PR head unavailable; CI is unverified."
    : !ciHead ? "No head-bound CI observation yet."
    : !headVerified ? "Unverified CI: observed head does not match the current PR head."
    : status === "unknown" ? "CI status has not been verified." : "";
  if (status === "passed" && (ci.total === 0 || pendingChecks.length || failedChecks.length
    || (countsKnown && ci.passed !== ci.total))) {
    status = "unknown";
    reason = "Passing CI is unverified: check details are empty or inconsistent.";
  }
  return {
    status, reason, headVerified, prHead, ciHead,
    passed: countsKnown ? ci.passed : null,
    total: countsKnown ? ci.total : null,
    pendingChecks, failedChecks,
    observedAt: ci.observedAt || null,
  };
}

export function activeWorkView(references) {
  const model = references || {};
  const rawSource = model.source || {};
  const status = ["unknown", "partial", "verified", "unavailable"].includes(rawSource.status) ? rawSource.status : "unknown";
  const project = (kind) => list(model[kind]).filter((entry) => entry.owned === true).map((entry) => ({
    ...entry,
    reference: typeof entry.reference === "string" ? entry.reference : "",
    title: typeof entry.title === "string" ? entry.title : "",
    url: safeHttpsUrl(entry.url),
    state: ["OPEN", "CLOSED", ...(kind === "prs" ? ["MERGED"] : [])].includes(entry.state) ? entry.state : "UNKNOWN",
    ...(kind === "prs" ? { ci: ciSnapshot(entry) } : {}),
  }));
  const emptyMessage = (kind) => {
    const noun = kind === "prs" ? "pull requests" : "issues";
    if (status === "verified" && rawSource.known?.[kind] === true) return `No session-owned ${noun}.`;
    if (status === "unavailable") return `Session-owned ${noun} are unavailable.`;
    if (status === "partial") return `Session-owned ${noun} are only partially observed.`;
    return `Session-owned ${noun} have not been verified.`;
  };
  return {
    prs: project("prs"),
    issues: project("issues"),
    source: {
      status,
      updatedAt: rawSource.updatedAt || null,
      error: typeof rawSource.error === "string" ? rawSource.error : null,
    },
    emptyPrs: emptyMessage("prs"),
    emptyIssues: emptyMessage("issues"),
  };
}
