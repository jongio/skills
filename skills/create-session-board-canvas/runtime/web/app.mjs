import { html, mountCanvas, useState } from "/kit/core-client.mjs";
import { Icon } from "/kit/icons.mjs";
import {
  activeWorkView, blockerEntries, blockingReportLabel, childTaskIds, dependencyIds, isBlockingReport, isLeaf,
  latestReports, leafProgress, milestoneProgress, operatorRequests, scopedReports, scopedTaskReports,
  sessionBlockerReports, taskGoalIds, timestamp, waitingFor,
} from "./view-model.mjs";

const COLUMNS = [
  { id: "pending", label: "To do", tone: "muted" },
  { id: "in_progress", label: "Doing", tone: "accent" },
  { id: "blocked", label: "Blocked", tone: "danger" },
  { id: "done", label: "Done", tone: "success" },
];
const SESSION_VIEW = "__session_overview__";
const list = (value) => Array.isArray(value) ? value.filter(Boolean) : [];
const text = (value) => {
  if (value == null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};
const label = (value) => text(value).replace(/[_-]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const taskStatus = (task) => COLUMNS.some((column) => column.id === task.status) ? task.status : "unknown";
const isPrimary = (agent) => /^(primary|main|coordinator)$/i.test(text(agent.role)) || agent.id === "primary";
const taskAnchor = (id) => `task-${encodeURIComponent(text(id))}`;

function selectedTasks(goal, canonicalTasks, taskMap) {
  const roots = !goal ? canonicalTasks : [
    ...list(goal.tasks),
    ...list(goal.taskIds).map((id) => taskMap.get(id)).filter(Boolean),
  ];
  const selected = new Map(roots.map((task) => [task.id, taskMap.get(task.id) || task]));
  for (const task of selected.values()) {
    childTaskIds(task).forEach((id) => {
      if (!selected.has(id) && taskMap.has(id)) selected.set(id, taskMap.get(id));
    });
  }
  return [...selected.values()];
}

function Time({ at }) {
  if (!timestamp(at)) return html`<span class="ck-muted">Time unavailable</span>`;
  const date = new Date(at);
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  const short = seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago`
    : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : date.toLocaleDateString();
  return html`<time dateTime=${date.toISOString()} title=${date.toLocaleString()}>${short}</time>`;
}

function Badge({ children, tone = "muted" }) {
  return html`<span class=${`ck-badge ck-badge-${tone}`}>${children}</span>`;
}

function Empty({ children }) {
  return html`<div class="ck-empty compact-empty"><${Icon} name="inbox" size=${20} /><span>${children}</span></div>`;
}

function Evidence({ value, collapsed = false }) {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  if (!entries.length) return null;
  const content = html`<ul class="evidence-list">${entries.slice(0, 4).map((entry, index) => html`
    <li key=${index}>${text(entry)}</li>
  `)}${entries.length > 4 && html`<li class="ck-muted">${entries.length - 4} more evidence entries</li>`}</ul>`;
  return collapsed ? html`<details class="evidence-disclosure"><summary>Evidence</summary>${content}</details>` : content;
}

function operatorAttention(model) {
  const activeGoal = list(model.goals).find((goal) => goal.id === model.activeGoalId);
  const canonicalTasks = list(model.tasks);
  const taskMap = new Map([...list(model.goals).flatMap((goal) => list(goal.tasks)), ...canonicalTasks].map((task) => [task.id, task]));
  const activeTasks = activeGoal ? selectedTasks(activeGoal, canonicalTasks, taskMap) : canonicalTasks;
  const activeTaskIds = new Set([
    ...list(activeGoal?.taskIds),
    ...(activeGoal ? activeTasks : canonicalTasks).map((task) => task.id),
  ]);
  const agents = list(model.agents);
  const attention = list(model.attention).map((entry, index) => ({
    id: `event:${entry.id || index}`,
    title: label(entry.kind || "operator action requested"),
    message: text(entry.message) || "Respond in the primary session.",
    at: entry.at,
  }));
  operatorRequests(model, activeTaskIds, taskMap).forEach((report, index) => {
    attention.push({
      id: `report:${report.id || JSON.stringify([report.actorId, report.taskId, index])}`,
      title: taskMap.get(report.taskId)?.title
        || agents.find((agent) => agent.id === report.actorId)?.name
        || "Operator input requested",
      message: text(report.message) || "Operator input required.",
      at: report.at,
    });
  });
  const delivery = model.delivery || activeGoal?.delivery;
  if (delivery?.phase === "awaiting_merge_approval") attention.push({
    id: "delivery:merge-approval",
    title: "Merge approval",
    message: "Approve in the primary session.",
  });
  return attention;
}

function ownership(taskId, agents, relativeTaskId) {
  const owners = agents.filter((agent) => list(agent.taskIds).includes(taskId));
  const relatedOwners = agents.filter((agent) => list(agent.taskIds).includes(relativeTaskId));
  return owners.length ? owners.map((agent) => {
    const role = isPrimary(agent) ? "Primary"
      : relativeTaskId && !relatedOwners.some((owner) => owner.id === agent.id) ? "Other subagent" : "Subagent";
    return `${role} · ${agent.name || agent.id || "Unnamed agent"}`;
  }).join("; ") : "Unassigned";
}

function DependencyLink({ id, taskMap, agents, goals, selectedTaskIds, sourceTaskId, reports, reportScope }) {
  const task = taskMap.get(id);
  const resolved = task?.status === "done";
  const dependencyScope = selectedTaskIds.has(id) ? reportScope : { ...reportScope, selectedGoalId: null };
  const goalIds = taskGoalIds(id, dependencyScope);
  const goal = goals.find((entry) => entry.id === dependencyScope.selectedGoalId)
    || goals.find((entry) => goalIds.includes(entry.id));
  const dependencyReports = scopedTaskReports(reports, id, dependencyScope);
  return html`<li class="dependency-item">
    <div class="dependency-heading"><span class=${`task-symbol tone-${resolved ? "success" : "attention"}`}>
      <${Icon} name=${resolved ? "circle-check" : "circle"} size=${14} />
    </span><strong>${task?.title || id}</strong>
      <${Badge} tone=${resolved ? "success" : "attention"}>${resolved ? "Done · resolved" : `${label(task?.status || "not in snapshot")} · waiting`}</${Badge}>
    </div>
    <div class="dependency-context">
      <code>${id}</code><span>${ownership(id, agents, sourceTaskId)}</span>
      ${goal && html`<span>Goal · ${goal.title || goal.id}</span>`}
      ${!selectedTaskIds.has(id) && html`<span class="cross-goal-label">Outside selected work</span>`}
    </div>
    ${dependencyReports.filter(isBlockingReport).map((report, index) => html`
      <div class="blocker-report" key=${report.id || index}>
        <strong>${agents.find((agent) => agent.id === report.actorId)?.name || report.actorId || "Agent"} · ${blockingReportLabel(report)}</strong>
        <p>${text(report.message) || `Dependency report status: ${report.status}.`}</p>
        <span class="ck-caption"><${Time} at=${report.at} /></span>
      </div>
    `)}
  </li>`;
}

function Blockers({ tasks, dependencies, taskMap, reports, agents, goals, selectedTaskIds, selectedGoal, reportScope }) {
  const entries = blockerEntries(tasks, dependencies, taskMap, reports, reportScope);
  const sessionReports = sessionBlockerReports(reports, selectedGoal?.id);
  const count = entries.length + sessionReports.length;
  return html`<section class="ck-card section-card blockers-card" aria-labelledby="blockers-heading">
    <div class="section-heading"><h2 id="blockers-heading">Blockers & dependencies</h2><span class="count">${count}</span></div>
    ${count ? html`<div class="blocker-list">
      ${entries.map(({ task, waiting, reports: taskReports }) => html`<article class="blocker-entry" key=${task.id}>
        <div class="blocker-heading"><h3>${task.title || task.id}</h3>
          <${Badge} tone=${task.status === "blocked" ? "danger" : task.status === "done" ? "success" : "muted"}>Canonical · ${label(task.status || "unknown")}</${Badge}>
        </div>
        <p class="ck-caption blocker-owner"><code>${task.id}</code><span>${ownership(task.id, agents)}</span></p>
        ${waiting.length > 0 && html`<p class="dependency-label">Waiting on ${waiting.length} ${waiting.length === 1 ? "task" : "tasks"}</p>
          <ul class="dependency-list">${waiting.map((id) => html`
            <${DependencyLink} key=${id} id=${id} taskMap=${taskMap} agents=${agents} goals=${goals}
              selectedTaskIds=${selectedTaskIds} sourceTaskId=${task.id} reports=${reports} reportScope=${reportScope} />
          `)}</ul>`}
        ${taskReports.map((report, index) => html`<div class="blocker-report" key=${report.id || index}>
          <strong>${agents.find((agent) => agent.id === report.actorId)?.name || report.actorId || "Agent"} · ${blockingReportLabel(report)}</strong>
          <p>${text(report.message) || `Agent report status: ${report.status}.`}</p>
          <span class="ck-caption"><${Time} at=${report.at} /></span>
        </div>`)}
      </article>`)}
      ${sessionReports.map((report, index) => html`<article class="blocker-entry" key=${`session:${report.id || index}`}>
        <div class="blocker-heading"><h3>${agents.find((agent) => agent.id === report.actorId)?.name || report.actorId || "Agent"}</h3>
          <${Badge} tone="danger">${blockingReportLabel(report)}</${Badge}>
        </div>
        <p class="ck-caption">Session report</p>
        <p class="blocker-report-message">${text(report.message) || `Agent report status: ${report.status}.`}</p>
        <span class="ck-caption"><${Time} at=${report.at} /></span>
      </article>`)}
    </div>` : html`<${Empty}>None</${Empty}>`}
  </section>`;
}

function reportTone(status) {
  return /blocked|failed|error/.test(text(status)) ? "danger"
    : status === "accepted" ? "success" : status === "result_ready" ? "attention" : "muted";
}

function TaskReference({ id, taskMap, onSelect }) {
  const task = taskMap.get(id);
  return task ? html`<a href=${`#${encodeURIComponent(taskAnchor(id))}`} onClick=${(event) => {
    event.preventDefault();
    onSelect(id);
  }}>${task.title || id}</a>` : html`<span>${id} <span class="ck-muted">· not in snapshot</span></span>`;
}

function TaskCard({ task, dependencies, taskMap, reports, agents, goals, selectedTaskIds, selectedTaskId, onTaskSelect, expanded, onExpandedChange, reportScope }) {
  const status = taskStatus(task);
  const waiting = waitingFor(task, dependencies, taskMap);
  const linkedTasks = dependencyIds(task, dependencies);
  const children = childTaskIds(task);
  const rollup = children.length ? milestoneProgress(task, taskMap) : null;
  const parent = task.parentId ? taskMap.get(task.parentId) : null;
  const issues = list(task.issues);
  const taskReports = scopedTaskReports(reports, task.id, reportScope);
  const liveBlockers = taskReports.filter(isBlockingReport);
  const owners = agents.filter((agent) => list(agent.taskIds).includes(task.id));
  const actorName = (id) => agents.find((agent) => agent.id === id)?.name || id || "Agent";
  return html`
    <details id=${taskAnchor(task.id)} class=${`task-card task-${status}${children.length ? " milestone-card" : ""}${selectedTaskId === task.id ? " selected-task" : ""}`}
      open=${expanded || selectedTaskId === task.id} onToggle=${(event) => {
        const open = event.currentTarget.open;
        onExpandedChange(task.id, open);
        if (!open && selectedTaskId === task.id) onTaskSelect("");
      }}>
      <summary>
        <div class="task-title-row">
          <span class=${`task-symbol tone-${status === "unknown" ? "attention" : COLUMNS.find((c) => c.id === status)?.tone}`}>
            <${Icon} name=${status === "done" ? "circle-check" : "circle"} size=${16} />
          </span>
          <span class="task-title">${task.title || "Untitled task"}</span>
          <span class="detail-chevron" aria-hidden="true">›</span>
        </div>
        <div class="task-meta">
          ${children.length > 0 && html`<${Badge} tone="accent">Milestone</${Badge}>`}
          ${task.parentId && html`<${Badge}>Subtask</${Badge}>`}
          ${status === "unknown" && html`<${Badge} tone="attention">Unknown status</${Badge}>`}
          ${owners.length > 0 && html`<span class="task-owner" title=${owners.map((agent) => agent.name || agent.id).join(", ")}>${owners.map((agent) => agent.name === "Primary agent" ? "Primary" : agent.name || agent.id).join(", ")}</span>`}
          ${waiting.length > 0 && html`<span>${waiting.length} waiting</span>`}
        </div>
        ${rollup && html`<div class="subtask-rollup">
          <div class="rollup-label"><span>${rollup.done} / ${rollup.total}${rollup.incomplete && !rollup.fromBackend ? " known" : ""}</span>
            <strong>${rollup.percent == null ? "—" : `${rollup.percent}%`}</strong>
          </div>
          <div class="progress-track" role="progressbar" aria-label="Milestone leaf-subtask rollup" aria-valuemin="0" aria-valuemax="100"
            aria-valuenow=${rollup.percent ?? undefined} aria-valuetext=${`${rollup.done} of ${rollup.total} leaf subtasks done${rollup.incomplete ? "; child details incomplete" : ""}`}>
            <span style=${{ width: `${rollup.percent ?? 0}%` }}></span>
          </div>
          ${rollup.incomplete && html`<p class="ck-caption">${rollup.fromBackend ? "Backend rollup · some child details unavailable" : "Child snapshot incomplete · percentage unavailable"}</p>`}
        </div>`}
        ${liveBlockers.length > 0 && html`<p class="task-note tone-danger">
          ${blockingReportLabel(liveBlockers[0])}: ${text(liveBlockers[0].message) || `Agent report status: ${liveBlockers[0].status}.`}
        </p>`}
        ${issues.length > 0 && html`<p class="task-note tone-attention">${text(issues[0])}</p>`}
      </summary>
      <div class="task-detail">
        <code>${task.id || "No task ID"}</code>
        <p class="detail-label">${status === "unknown" ? "Canonical status not recognized" : `Canonical status · ${COLUMNS.find((c) => c.id === status).label}`}</p>
        <p class="preserve-lines">${task.description || "No description provided."}</p>
        <p class="task-detail-owner">${ownership(task.id, agents)}</p>
        ${task.parentId && html`<h4>Parent milestone</h4>
          <p><${TaskReference} id=${task.parentId} taskMap=${taskMap} onSelect=${onTaskSelect} />
            ${parent && html`<span class="ck-muted"> · canonical ${label(parent.status || "unknown")}</span>`}
          </p>
        `}
        ${children.length > 0 && html`<h4>Child tasks · ${children.length} direct</h4>
          <p class="ck-caption">Rollup counts descendant leaves once. It does not change this milestone's canonical status.</p>
          <ul class="child-task-list">${children.map((id) => {
            const child = taskMap.get(id);
            return html`<li key=${id}>
              <div class="child-task-heading"><${TaskReference} id=${id} taskMap=${taskMap} onSelect=${onTaskSelect} />
                <${Badge} tone=${child?.status === "done" ? "success" : child?.status === "blocked" ? "danger" : "muted"}>${label(child?.status || "unknown")}</${Badge}>
              </div>
              <p class="ck-caption">${ownership(id, agents, task.id)}${child && !isLeaf(child) ? " · nested milestone" : ""}</p>
            </li>`;
          })}</ul>
        `}
        ${linkedTasks.length > 0 && html`
          <h4>Dependencies · ${waiting.length} waiting · ${linkedTasks.length - waiting.length} resolved</h4>
          <ul class="dependency-list">${linkedTasks.map((id) => html`
            <${DependencyLink} key=${id} id=${id} taskMap=${taskMap} agents=${agents} goals=${goals}
              selectedTaskIds=${selectedTaskIds} sourceTaskId=${task.id} reports=${reports} reportScope=${reportScope} />
          `)}</ul>
        `}
        ${issues.length > 0 && html`<h4>Issues</h4><ul class="plain-list">${issues.map((issue, index) => html`<li key=${index}>${text(issue)}</li>`)}</ul>`}
        ${taskReports.length > 0 && html`<h4>Latest agent reports</h4>
          ${taskReports.slice(0, 4).map((report, index) => html`
            <div class="report-note" key=${report.id || index}>
              <div class="minor-spread"><strong>${actorName(report.actorId)}</strong>
                <${Badge} tone=${reportTone(report.status)}>${label(report.status || "reported")}</${Badge}>
              </div>
              <p class="preserve-lines">${text(report.message) || "No report message."}</p>
              ${report.status === "result_ready" && html`<p class="tone-attention">Result ready is not primary acceptance.</p>`}
              <${Evidence} value=${report.evidence} />
              <span class="ck-caption"><${Time} at=${report.at} />${report.relayed ? " · relayed" : ""}</span>
            </div>
          `)}
          <p class="ck-caption">Reports do not move the canonical task status.</p>
        `}
      </div>
    </details>
  `;
}

function Team({ agents, reports }) {
  return html`<section class="ck-card section-card" aria-labelledby="team-heading">
    <div class="section-heading"><h2 id="team-heading">Team</h2><span class="count">${agents.length}</span></div>
    <div class="roster">${agents.map((agent) => {
      const primary = isPrimary(agent);
      const actorReports = reports.filter((report) => report.actorId === agent.id);
      const blocked = actorReports.filter(isBlockingReport);
      const fallbackReport = agent.report?.superseded === true ? null : agent.report;
      const note = blocked[0]?.message || actorReports[0]?.message || fallbackReport?.message || fallbackReport;
      return html`<details class="agent-row" key=${agent.id}>
        <summary>
          <span class=${`avatar ${primary ? "avatar-primary" : ""}`} aria-hidden="true">${text(agent.name || agent.id || "A").slice(0, 1).toUpperCase()}</span>
          <span class="agent-identity"><strong>${agent.name || agent.id || "Unnamed agent"}</strong>
            <span class="ck-caption">${primary ? "Primary agent" : label(agent.role || "subagent")}</span>
          </span>
          <${Badge} tone=${reportTone(blocked.length ? blocked[0].status : agent.state)}>${blocked.length ? blockingReportLabel(blocked[0]) : label(agent.state || "unknown")}</${Badge}>
        </summary>
        <div class="agent-detail">
          ${agent.state === "result_ready" && html`<p class="tone-attention">Result ready · awaiting primary acceptance.</p>`}
          ${agent.state === "accepted" && html`<p class="tone-success">Acceptance reported. Task totals still use canonical statuses.</p>`}
          <p class="preserve-lines">${text(note) || "No agent report available."}</p>
          ${list(agent.taskIds).length > 0 && html`<p class="ck-caption">Assigned: ${list(agent.taskIds).join(", ")}</p>`}
          <span class="ck-caption">Updated <${Time} at=${agent.updatedAt} /></span>
        </div>
      </details>`;
    })}</div>
  </section>`;
}

function Delivery({ delivery, allDone, total }) {
  const phase = text(delivery?.phase);
  const status = text(delivery?.status);
  const merged = status.toLowerCase() === "merged" || phase.toLowerCase() === "merged";
  const approved = status.toLowerCase() === "approved";
  const headline = merged ? "Merged" : approved ? "Approved · delivery pending"
    : status ? label(status) : allDone ? "Awaiting approval" : total ? "Not reported" : "Not started";
  return html`<section class="ck-card section-card delivery-card" aria-labelledby="delivery-heading">
    <div class="section-heading"><h2 id="delivery-heading">Delivery</h2>
      <span class=${`status-dot ${merged ? "tone-success" : "tone-attention"}`}></span>
    </div>
    <p class=${`delivery-status ${merged ? "tone-success" : ""}`}>${headline}</p>
    ${phase && html`<p class="ck-caption">${label(phase)}</p>`}
    <${Evidence} value=${delivery?.evidence} collapsed=${true} />
  </section>`;
}

function ReferenceIdentity({ item }) {
  const tone = item.state === "OPEN" ? "success" : item.state === "MERGED" ? "accent" : "muted";
  return html`<div class="reference-identity">
    <div class="reference-heading">
      ${item.url ? html`<a href=${item.url} target="_blank" rel="noopener noreferrer" title=${item.url}>${item.reference || "Open reference"}</a>`
        : html`<span class="reference-id">${item.reference || "Reference unavailable"}</span>`}
      <${Badge} tone=${tone}>${label(item.state.toLowerCase())}</${Badge}>
    </div>
    ${item.title && html`<p class="reference-title">${item.title}</p>`}
    ${!item.url && html`<p class="ck-caption">Safe HTTPS link unavailable.</p>`}
  </div>`;
}

function PrCi({ ci }) {
  const tone = { unknown: "muted", pending: "attention", running: "accent", passed: "success", failed: "danger" }[ci.status];
  return html`<div class="pr-ci">
    <div class="minor-spread"><${Badge} tone=${tone}>CI · ${label(ci.status)}</${Badge}>
      ${ci.total != null && html`<span class="ci-count">${ci.headVerified ? "" : "Reported · "}${ci.passed} / ${ci.total} passed</span>`}
    </div>
    ${ci.reason && ci.status !== "passed" && html`<p class="ci-reason">${ci.reason}</p>`}
    ${ci.total == null && html`<p class="ck-caption">Check totals unavailable.</p>`}
    <p class="ci-head"><span>PR head</span><code title=${ci.prHead || ""}>${ci.prHead ? ci.prHead.slice(0, 8) : "unknown"}</code>
      ${(!ci.headVerified || ci.ciHead !== ci.prHead) && html`<span>CI head</span><code title=${ci.ciHead || ""}>${ci.ciHead ? ci.ciHead.slice(0, 8) : "unknown"}</code>`}
    </p>
    ${(ci.failedChecks.length > 0 || ci.pendingChecks.length > 0) && html`<details class="ci-checks">
      <summary>${ci.failedChecks.length} failed · ${ci.pendingChecks.length} pending checks</summary>
      ${!ci.headVerified && html`<p class="ck-caption">Names below belong to the unverified CI snapshot.</p>`}
      ${ci.failedChecks.length > 0 && html`<h4 class="tone-danger">Failed checks</h4>
        <ul>${ci.failedChecks.map((name, index) => html`<li key=${index}>${name}</li>`)}</ul>`}
      ${ci.pendingChecks.length > 0 && html`<h4>Pending checks</h4>
        <ul>${ci.pendingChecks.map((name, index) => html`<li key=${index}>${name}</li>`)}</ul>`}
    </details>`}
    <p class="ck-caption ci-observed">CI observed <${Time} at=${ci.observedAt} /></p>
  </div>`;
}

function ActiveWork({ references }) {
  const work = activeWorkView(references);
  const sourceTone = work.source.status === "verified" ? "success" : work.source.status === "partial" ? "attention" : "muted";
  return html`<section class="ck-card section-card active-work-card" aria-labelledby="active-work-heading">
    <div class="section-heading"><h2 id="active-work-heading">Active work</h2>
      <${Badge} tone=${sourceTone}>${label(work.source.status)}</${Badge}>
    </div>
    ${work.source.error && html`<p class="reference-error" role="status">${work.source.error}</p>`}
    <section class="reference-group" aria-label="Session-owned pull requests">
      <div class="reference-group-heading"><h3>PRs</h3><span class="count">${work.prs.length}</span></div>
      ${work.prs.length ? html`<div class="reference-list">${work.prs.map((pr, index) => html`
        <article class="reference-item" key=${pr.reference || index}>
          <${ReferenceIdentity} item=${pr} /><${PrCi} ci=${pr.ci} />
        </article>
      `)}</div>` : html`<p class="reference-empty">${work.emptyPrs}</p>`}
    </section>
    <section class="reference-group" aria-label="Session-owned issues">
      <div class="reference-group-heading"><h3>Issues</h3><span class="count">${work.issues.length}</span></div>
      ${work.issues.length ? html`<div class="reference-list">${work.issues.map((issue, index) => html`
        <article class="reference-item" key=${issue.reference || index}><${ReferenceIdentity} item=${issue} /></article>
      `)}</div>` : html`<p class="reference-empty">${work.emptyIssues}</p>`}
    </section>
    <p class="ck-caption references-updated">References updated <${Time} at=${work.source.updatedAt} /></p>
  </section>`;
}

function Plan({ plan, drafts }) {
  const content = text(plan?.content);
  const exists = plan?.exists === true || (plan?.exists !== false && Boolean(content));
  return html`<section class="ck-card section-card" aria-labelledby="plan-heading">
    <div class="section-heading"><h2 id="plan-heading">Plan</h2><${Badge}>${exists ? "Available" : "Not found"}</${Badge}></div>
    ${exists && !content && html`<p class="plan-summary">Content unavailable.</p>`}
    ${content && exists && html`<details class="plan-disclosure"><summary>Read plan</summary>
      ${plan?.path && html`<p class="source-path">${text(plan.path)}</p>`}
      <pre class="plan-content">${content.slice(0, 20000)}</pre>
      ${content.length > 20000 && html`<p class="ck-caption">Showing the first 20,000 characters.</p>`}
    </details>`}
    ${drafts.length > 0 && html`<details class="plan-disclosure"><summary>Untracked drafts <span class="count">${drafts.length}</span></summary>
      <ul class="plain-list">${drafts.slice(0, 8).map((draft) => html`<li key=${draft.id}>${draft.title || "Untitled draft"}</li>`)}</ul>
      <p class="ck-caption">Drafts are excluded from leaf-task totals.${drafts.length > 8 ? ` Showing 8 of ${drafts.length}.` : ""}</p>
    </details>`}
  </section>`;
}

function Activity({ activity, reports, agents }) {
  const events = (activity.length ? activity : reports.map((report) => ({
    ...report, type: "report", message: report.message || label(report.status),
  }))).map((event, index) => ({ ...event, localIndex: index }))
    .sort((a, b) => timestamp(b.at) - timestamp(a.at) || b.localIndex - a.localIndex);
  return html`<section class="ck-card section-card activity-card" aria-labelledby="activity-heading">
    <details class="activity-disclosure"><summary class="section-heading"><h2 id="activity-heading">Activity</h2><span class="count">${events.length}</span></summary>
    ${events.length ? html`<ol class="timeline">${events.slice(0, 12).map((event) => html`<li key=${event.id || event.localIndex}>
      <span class="timeline-marker" aria-hidden="true"><${Icon} name="circle" size=${12} /></span>
      <div><p class="activity-message">${text(event.message) || label(event.type || "update")}</p>
        <p class="ck-caption">${agents.find((agent) => agent.id === event.actorId)?.name || event.actorId || "Session"}
          <span class="separator">·</span><${Time} at=${event.at} />
        </p>
      </div>
    </li>`)}</ol>` : html`<${Empty}>No activity recorded yet.</${Empty}>`}
    ${events.length > 12 && html`<p class="ck-caption">Showing the latest 12 of ${events.length} events.</p>`}
    </details>
  </section>`;
}

function App({ state, invoke, connected }) {
  const [query, setQuery] = useState("");
  const [goalChoice, setGoalChoice] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [expandedTaskIds, setExpandedTaskIds] = useState([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const model = state || {};
  const source = model.source || {};
  const goals = list(model.goals);
  const activeGoal = goals.find((goal) => goal.id === model.activeGoalId);
  const selectedGoal = goalChoice === SESSION_VIEW ? null : goalChoice
    ? goals.find((goal) => goal.id === goalChoice) : activeGoal || goals[0];
  const unavailableGoal = Boolean(goalChoice && goalChoice !== SESSION_VIEW && !selectedGoal);
  const canonicalTasks = list(model.tasks);
  const taskMap = new Map([...goals.flatMap((goal) => list(goal.tasks)), ...canonicalTasks].map((task) => [task.id, task]));
  const tasks = unavailableGoal ? [] : selectedTasks(selectedGoal, canonicalTasks, taskMap);
  const selectedTaskIds = new Set(tasks.map((task) => task.id));
  const dependencies = list(model.dependencies);
  const reports = latestReports(model.reports);
  const reportScope = { selectedGoalId: selectedGoal?.id ?? null, goals, taskMap };
  const liveReports = scopedReports(reports, reportScope);
  const agents = [...list(model.agents)];
  if (!agents.some(isPrimary)) agents.unshift({
    id: "primary", name: "Primary agent", role: "primary", state: "unknown", report: "No primary status reported.",
  });
  agents.sort((a, b) => Number(isPrimary(b)) - Number(isPrimary(a)));
  const { leaves, done, total, percent } = leafProgress(tasks);
  const milestones = tasks.filter((task) => !isLeaf(task));
  const missingChildren = new Set(tasks.flatMap(childTaskIds).filter((id) => !taskMap.has(id)));
  const percentage = missingChildren.size ? null : percent;
  const allDone = total > 0 && done === total && !missingChildren.size;
  const unknown = leaves.filter((task) => taskStatus(task) === "unknown");
  const search = query.trim().toLowerCase();
  const visible = tasks.filter((task) => (!statusFilter || taskStatus(task) === statusFilter)
    && [task.id, task.title, task.description, ...list(task.issues)].some((value) => text(value).toLowerCase().includes(search)));
  const attention = operatorAttention(model);
  const ready = leaves.filter((task) => task.status === "pending"
    && waitingFor(task, dependencies, taskMap).length === 0
    && list(task.issues).length === 0
    && !scopedTaskReports(reports, task.id, reportScope).some(isBlockingReport));
  const historical = selectedGoal && model.activeGoalId && selectedGoal.id !== model.activeGoalId;
  const history = goals.filter((goal) => goal.id !== model.activeGoalId);
  const loading = !state || source.status === "loading";
  const freshness = loading ? "Loading source" : source.status === "stale" ? "Stale snapshot"
    : !connected ? "Reconnecting" : source.status === "live" ? "Live updates" : "Connected";
  const delivery = unavailableGoal ? {} : selectedGoal ? selectedGoal.delivery || {} : model.delivery || {};

  function setTaskExpanded(id, open) {
    setExpandedTaskIds((current) => open
      ? current.includes(id) ? current : [...current, id]
      : current.includes(id) ? current.filter((entry) => entry !== id) : current);
  }

  function selectTask(id) {
    setSelectedTaskId(id);
    if (!id) return;
    setQuery("");
    setStatusFilter("");
    if (!selectedTaskIds.has(id)) {
      const goal = goals.find((entry) => selectedTasks(entry, canonicalTasks, taskMap).some((task) => task.id === id));
      setGoalChoice(goal?.id || SESSION_VIEW);
    }
    requestAnimationFrame(() => {
      const card = document.getElementById(taskAnchor(id));
      card?.scrollIntoView({ block: "nearest" });
      card?.querySelector("summary")?.focus({ preventScroll: true });
    });
  }

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError("");
    try {
      await invoke("refresh", {});
    } catch (error) {
      setRefreshError(`Refresh failed: ${error?.message || text(error) || "Unknown error"}`);
    } finally {
      setRefreshing(false);
    }
  }

  return html`<main class="dashboard">
    <header class="page-header">
      <div class="page-brand"><span class="brand-icon"><${Icon} name="layout-list" size=${20} /></span>
        <div><h1>Session Board Canvas</h1></div>
      </div>
      <div class="header-actions">
        <span class="ck-status" role="status"><span class=${`ck-dot ${!loading && connected && source.status !== "stale" ? "ck-dot-live" : "ck-dot-off"}`}></span>${freshness}</span>
        <button class="ck-btn ck-btn-sm" type="button" onClick=${refresh} disabled=${refreshing} aria-busy=${refreshing}>${refreshing ? "Refreshing…" : "Refresh"}</button>
      </div>
    </header>

    <div class="session-meta">
      <span class="read-only-label">Read-only</span>
      <span class="session-id" title=${text(model.sessionId)}>${model.sessionId ? `Session ${model.sessionId}` : "Waiting for session"}</span>
      ${model.revision != null && html`<span class="revision">rev ${text(model.revision)}</span>`}
      <span class="last-refresh">Refreshed <${Time} at=${source.lastRefresh} /></span>
    </div>

    ${(source.error || refreshError) && html`<div class="ck-callout ck-error error-notice" role="alert">
      <${Icon} name="circle" size=${16} /><div>
        ${source.error && html`<p>${text(source.error)}</p>`}
        ${refreshError && html`<p>${refreshError}</p>`}
        <p class="ck-caption">Saved snapshot. Refresh to retry.</p>
      </div>
    </div>`}
    ${source.status === "stale" && !source.error && html`<div class="ck-callout freshness-notice" role="status">Source data is stale. Treat progress as the last known snapshot, not current confirmation.</div>`}
    ${!connected && state && html`<p class="connection-note">Live connection interrupted. Showing the last snapshot while reconnecting.</p>`}

    <section class="goal-overview ck-card" aria-labelledby="goal-title">
      <div class="goal-copy">
        <div class="minor-spread">
          <${Badge} tone=${historical ? "muted" : "accent"}>${historical ? "Historical" : "Tracked work"}</${Badge}>
        </div>
        <h2 id="goal-title">${unavailableGoal ? "Selected goal unavailable" : selectedGoal?.title || (loading ? "Connecting to your session…" : "All session tasks")}</h2>
        <p class="ck-caption">${unavailableGoal ? "This goal is absent from the latest snapshot. Choose another goal below."
          : missingChildren.size ? `${missingChildren.size} child task records unavailable · waiting for a complete hierarchy snapshot.`
          : total === 0 ? "No tracked tasks."
          : allDone ? "Tasks complete."
          : `${total - done} ${total - done === 1 ? "task" : "tasks"} remaining.`}</p>
        <div class="goal-controls">
          <label class="sr-only" for="goal-select">Choose goal</label>
          <select id="goal-select" class="ck-select" value=${goalChoice} onChange=${(event) => setGoalChoice(event.target.value)}>
            <option value="">${activeGoal ? "Current goal" : "Default goal"}</option>
            <option value=${SESSION_VIEW}>All session tasks</option>
            ${unavailableGoal && html`<option value=${goalChoice}>Selected goal (unavailable)</option>`}
            ${goals.map((goal) => html`<option key=${goal.id} value=${goal.id}>${goal.title || goal.id}${goal.id === model.activeGoalId ? " · active" : " · history"}</option>`)}
          </select>
          <button class="ck-btn ck-btn-sm" type="button" aria-expanded=${showHistory} aria-controls="goal-history" onClick=${() => setShowHistory(!showHistory)}>History (${history.length})</button>
        </div>
      </div>
      <div class="progress-metric">
        <span class="ck-caption">Progress</span>
        <div class="metric-value" aria-live="polite" aria-atomic="true"><strong>${percentage ?? "—"}${percentage != null && html`<span>%</span>`}</strong>
          <span class="metric-count"><strong>${done} / ${total}</strong><small>${total === 1 ? "leaf task done" : "leaf tasks done"}</small></span>
        </div>
        <div class="progress-track" role="progressbar" aria-label="Canonical leaf tasks done" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${percentage ?? undefined} aria-valuetext=${`${done} of ${total} recorded leaf tasks done${missingChildren.size ? "; hierarchy incomplete" : total ? "" : "; not started"}`}>
          <span style=${{ width: `${percentage ?? 0}%` }}></span>
        </div>
        <p class="ck-caption">${missingChildren.size ? "Incomplete hierarchy · percentage unavailable" : total === 0 ? "Not started"
          : unknown.length ? `${unknown.length} unknown` : `${milestones.length} milestones excluded`}</p>
      </div>
    </section>

    ${showHistory && html`<section class="ck-card history-panel" id="goal-history" aria-label="Goal history">
      <div class="section-heading"><h2>Goal history</h2><span class="ck-caption">Local view only</span></div>
      ${history.length ? html`<div class="history-list">${history.map((goal) => {
        const progress = leafProgress(selectedTasks(goal, canonicalTasks, taskMap));
        return html`<button class="history-goal" key=${goal.id} type="button" aria-pressed=${selectedGoal?.id === goal.id} onClick=${() => setGoalChoice(goal.id)}>
          <${Icon} name="layout-list" size=${14} /><span>${goal.title || goal.id}</span>
          <span class="ck-caption">${progress.done} / ${progress.total} leaves done</span>
        </button>`;
      })}</div>` : html`<${Empty}>No previous goals recorded.</${Empty}>`}
    </section>`}

    ${!state ? html`<section class="loading-panel" aria-label="Loading progress" aria-busy="true">
      <div class="ck-skeleton loading-line"></div>
      <div class="loading-columns">${COLUMNS.map((column) => html`<div class="ck-skeleton loading-column" key=${column.id}></div>`)}</div>
      <p class="ck-caption">Waiting for the first session snapshot. Refresh is available if the source cannot connect.</p>
    </section>` : html`<div class="workspace-grid">
      <div class="main-column">
        <section class="board-section" aria-labelledby="board-heading">
          <div class="board-toolbar">
            <div><h2 id="board-heading">Tasks</h2><p class="ck-caption">${query || statusFilter ? `${visible.length} / ` : ""}${tasks.length} cards · ${total} tasks · ${milestones.length} milestones</p></div>
            <div class="board-filters">
              <label class="sr-only" for="task-search">Search tasks</label>
              <input id="task-search" class="ck-input" type="search" placeholder="Search tasks…" value=${query} onInput=${(event) => setQuery(event.target.value)} />
              <label class="sr-only" for="status-filter">Filter task status</label>
              <select id="status-filter" class="ck-select" value=${statusFilter} onChange=${(event) => setStatusFilter(event.target.value)}>
                <option value="">All statuses</option>
                ${COLUMNS.map((column) => html`<option value=${column.id} key=${column.id}>${column.label}</option>`)}
                <option value="unknown">Unknown</option>
              </select>
            </div>
          </div>
          ${tasks.length === 0 && html`<div class="board-empty ck-card"><${Empty}>${unavailableGoal ? "No snapshot for this goal." : "No tracked tasks yet. Progress begins when leaf tasks are recorded."}</${Empty}></div>`}
          ${tasks.length > 0 && visible.length === 0 && html`<div class="board-empty ck-card"><${Empty}>No tasks match your filters.</${Empty}>
            <button type="button" class="ck-btn ck-btn-sm" onClick=${() => { setQuery(""); setStatusFilter(""); }}>Clear filters</button>
          </div>`}
          <div class="kanban">${COLUMNS.map((column) => {
            const columnTasks = visible.filter((task) => taskStatus(task) === column.id);
            return html`<section class=${`kanban-column column-${column.id}`} key=${column.id} aria-label=${column.label}>
              <div class="column-heading"><span class=${`status-dot tone-${column.tone}`}></span><h3>${column.label}</h3>
                <span class="column-count" title="Cards, including milestone rollups"><span class="count">${columnTasks.length}</span><small>${columnTasks.length === 1 ? "card" : "cards"}</small></span>
              </div>
              <div class="column-tasks">${columnTasks.length ? columnTasks.map((task) => html`
                <${TaskCard} key=${task.id} task=${task} dependencies=${dependencies} taskMap=${taskMap} reports=${reports} agents=${agents}
                  goals=${goals} selectedTaskIds=${selectedTaskIds} selectedTaskId=${selectedTaskId} onTaskSelect=${selectTask}
                  expanded=${expandedTaskIds.includes(task.id)} onExpandedChange=${setTaskExpanded} reportScope=${reportScope} />
              `) : html`<p class="column-empty">${column.id === "done" ? "Nothing done yet" : "No tasks"}</p>`}</div>
            </section>`;
          })}</div>
          ${visible.some((task) => taskStatus(task) === "unknown") && html`<section class="unknown-tasks" aria-label="Tasks with unknown status">
            <div class="section-heading"><h3 class="tone-attention">Unclassified tasks</h3><span class="ck-caption">Not counted as complete</span></div>
            <div class="unknown-list">${visible.filter((task) => taskStatus(task) === "unknown").map((task) => html`
              <${TaskCard} key=${task.id} task=${task} dependencies=${dependencies} taskMap=${taskMap} reports=${reports} agents=${agents}
                goals=${goals} selectedTaskIds=${selectedTaskIds} selectedTaskId=${selectedTaskId} onTaskSelect=${selectTask}
                expanded=${expandedTaskIds.includes(task.id)} onExpandedChange=${setTaskExpanded} reportScope=${reportScope} />
            `)}</div>
          </section>`}
        </section>

        <${Blockers} tasks=${tasks} dependencies=${dependencies} taskMap=${taskMap} reports=${reports} agents=${agents}
          goals=${goals} selectedTaskIds=${selectedTaskIds} selectedGoal=${selectedGoal} reportScope=${reportScope} />

        <div class="insights-grid">
          <section class="ck-card section-card" aria-labelledby="attention-heading">
            <div class="section-heading"><h2 id="attention-heading">Needs attention</h2><span class="count">${attention.length}</span></div>
            ${attention.length ? html`<ul class="attention-list">
              ${attention.slice(0, 6).map((entry) => html`<li key=${entry.id}><span class="status-dot tone-attention"></span>
                <div><strong>${entry.title}</strong><p>${entry.message}</p>
                  ${entry.at && html`<span class="ck-caption"><${Time} at=${entry.at} /></span>`}
                </div>
              </li>`)}
            </ul>` : html`<${Empty}>None</${Empty}>`}
            ${attention.length > 6 && html`<p class="ck-caption">Showing 6 of ${attention.length} operator action requests.</p>`}
          </section>
          <section class="ck-card section-card" aria-labelledby="ready-heading">
            <div class="section-heading"><h2 id="ready-heading">Ready next</h2><span class="count">${ready.length}</span></div>
            ${ready.length ? html`<ol class="ready-list">${ready.slice(0, 6).map((task, index) => html`<li key=${task.id}>
              <span class="ready-number">${String(index + 1).padStart(2, "0")}</span><div><strong title=${task.id}>${task.title || "Untitled task"}</strong></div>
            </li>`)}</ol>` : html`<${Empty}>None</${Empty}>`}
            ${ready.length > 6 && html`<p class="ck-caption">Showing the first 6 of ${ready.length} ready tasks.</p>`}
          </section>
        </div>
        <${Activity} activity=${list(model.activity)} reports=${list(model.reports)} agents=${agents} />
      </div>
      <aside class="sidebar" aria-label="Session context">
        <${Delivery} delivery=${delivery} allDone=${allDone} total=${total} />
        <${ActiveWork} references=${model.references} />
        <${Team} agents=${agents} reports=${liveReports} />
        <${Plan} plan=${model.plan} drafts=${list(model.drafts)} />
      </aside>
    </div>`}
  </main>`;
}

mountCanvas({ view: (model) => html`<${App} ...${model} />` });
