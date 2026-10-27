const list = (value) => Array.isArray(value) ? value.filter(Boolean) : [];

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

export function operatorRequests(model, activeTaskIds, taskMap) {
  return latestReports(model.reports).filter((report) => {
    if (report.requiresOperator !== true || taskMap.get(report.taskId)?.status === "done") return false;
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

export function blockerEntries(tasks, dependencies, taskMap, reports) {
  const blockers = latestReports(reports).filter(isBlockingReport);
  return tasks.map((task) => ({
    task,
    waiting: waitingFor(task, dependencies, taskMap),
    reports: blockers.filter((report) => report.taskId === task.id),
  })).filter((entry) => entry.task.status === "blocked" || entry.waiting.length || entry.reports.length);
}

export function sessionBlockerReports(reports, selectedGoalId) {
  return latestReports(reports).filter((report) => isBlockingReport(report) && !report.taskId
    && (report.goalId == null || !selectedGoalId || report.goalId === selectedGoalId));
}
