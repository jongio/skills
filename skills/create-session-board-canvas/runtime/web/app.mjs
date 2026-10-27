import { html, mountCanvas, useState } from "/kit/core-client.mjs";
import { Icon } from "/kit/icons.mjs";
import {
  blockerEntries, blockingReportLabel, dependencyIds, isBlockingReport, latestReports,
  operatorRequests, sessionBlockerReports, timestamp, waitingFor,
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
const childTaskIds = (task) => [...new Set(list(task.childIds))];
const isLeaf = (task) => childTaskIds(task).length === 0;
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

function leafProgress(tasks) {
  const leaves = [...new Map(tasks.filter(isLeaf).map((task) => [task.id, task])).values()];
  const done = leaves.filter((task) => task.status === "done").length;
  const total = leaves.length;
  return { leaves, done, total, percent: total ? Math.floor(done / total * 100) : null };
}

function milestoneProgress(task, taskMap) {
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
    percent: provided.percent === null || !provided.total ? null : Math.floor(provided.done / provided.total * 100),
    incomplete: true,
    fromBackend: true,
  };
  return { ...progress, percent: incomplete ? null : progress.percent, incomplete, fromBackend: false };
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

function Evidence({ value }) {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  if (!entries.length) return null;
  return html`<ul class="evidence-list">${entries.slice(0, 4).map((entry, index) => html`
    <li key=${index}>${text(entry)}</li>
  `)}${entries.length > 4 && html`<li class="ck-muted">${entries.length - 4} more evidence entries</li>`}</ul>`;
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
    message: text(entry.message) || "Operator input is required in the primary session.",
    at: entry.at,
  }));
  operatorRequests(model, activeTaskIds, taskMap).forEach((report, index) => {
    attention.push({
      id: `report:${report.id || JSON.stringify([report.actorId, report.taskId, index])}`,
      title: taskMap.get(report.taskId)?.title
        || agents.find((agent) => agent.id === report.actorId)?.name
        || "Operator input requested",
      message: text(report.message) || "This agent explicitly requests operator input.",
      at: report.at,
    });
  });
  const delivery = model.delivery || activeGoal?.delivery;
  if (delivery?.phase === "awaiting_merge_approval") attention.push({
    id: "delivery:merge-approval",
    title: "Merge approval requested",
    message: "Review delivery evidence and respond to the merge approval request in the primary session.",
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

function DependencyLink({ id, taskMap, agents, goals, selectedTaskIds, sourceTaskId, reports }) {
  const task = taskMap.get(id);
  const resolved = task?.status === "done";
  const goal = goals.find((entry) => list(entry.taskIds).includes(id)
    || list(entry.tasks).some((goalTask) => goalTask.id === id));
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
    ${reports.filter((report) => report.taskId === id && isBlockingReport(report)).map((report, index) => html`
      <div class="blocker-report" key=${report.id || index}>
        <strong>${agents.find((agent) => agent.id === report.actorId)?.name || report.actorId || "Agent"} · ${blockingReportLabel(report)}</strong>
        <p>${text(report.message) || `Dependency report status: ${report.status}.`}</p>
        <span class="ck-caption"><${Time} at=${report.at} /></span>
      </div>
    `)}
  </li>`;
}

function Blockers({ tasks, dependencies, taskMap, reports, agents, goals, selectedTaskIds, selectedGoal }) {
  const entries = blockerEntries(tasks, dependencies, taskMap, reports);
  const sessionReports = sessionBlockerReports(reports, selectedGoal?.id);
  const count = entries.length + sessionReports.length;
  return html`<section class="ck-card section-card blockers-card" aria-labelledby="blockers-heading">
    <div class="section-heading"><h2 id="blockers-heading">Blockers & dependencies</h2><span class="count">${count}</span></div>
    <p class="ck-caption section-intro">Work coordination · canonical blockers, unresolved dependencies, and latest blocked or failed reports</p>
    ${count ? html`<div class="blocker-list">
      ${entries.map(({ task, waiting, reports: taskReports }) => html`<article class="blocker-entry" key=${task.id}>
        <div class="blocker-heading"><h3>${task.title || task.id}</h3>
          <${Badge} tone=${task.status === "blocked" ? "danger" : task.status === "done" ? "success" : "muted"}>Canonical · ${label(task.status || "unknown")}</${Badge}>
        </div>
        <p class="ck-caption blocker-owner"><code>${task.id}</code><span>${ownership(task.id, agents)}</span></p>
        ${waiting.length > 0 && html`<p class="dependency-label">Waiting on ${waiting.length} ${waiting.length === 1 ? "task" : "tasks"}</p>
          <ul class="dependency-list">${waiting.map((id) => html`
            <${DependencyLink} key=${id} id=${id} taskMap=${taskMap} agents=${agents} goals=${goals}
              selectedTaskIds=${selectedTaskIds} sourceTaskId=${task.id} reports=${reports} />
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
        <p class="ck-caption">Session-level report · no task assigned</p>
        <p class="blocker-report-message">${text(report.message) || `Agent report status: ${report.status}.`}</p>
        <span class="ck-caption"><${Time} at=${report.at} /></span>
      </article>`)}
    </div>` : html`<${Empty}>No blockers or unresolved dependencies in the selected work.</${Empty}>`}
    <p class="ck-caption">Reports do not change canonical task status or imply primary acceptance. Operator requests are listed separately in Needs attention.</p>
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

function TaskCard({ task, dependencies, taskMap, reports, agents, goals, selectedTaskIds, selectedTaskId, onTaskSelect, expanded, onExpandedChange }) {
  const status = taskStatus(task);
  const waiting = waitingFor(task, dependencies, taskMap);
  const linkedTasks = dependencyIds(task, dependencies);
  const children = childTaskIds(task);
  const rollup = children.length ? milestoneProgress(task, taskMap) : null;
  const parent = task.parentId ? taskMap.get(task.parentId) : null;
  const issues = list(task.issues);
  const taskReports = reports.filter((report) => report.taskId === task.id);
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
          <code>${task.id || "No task ID"}</code>
          ${children.length > 0 && html`<${Badge} tone="accent">Milestone</${Badge}>`}
          ${task.parentId && html`<${Badge}>Subtask</${Badge}>`}
          ${status === "unknown" && html`<${Badge} tone="attention">Unknown status</${Badge}>`}
          ${owners.length > 0 && html`<span class="task-owner">${owners.map((agent) => agent.name || agent.id).join(", ")}</span>`}
          ${waiting.length > 0 && html`<span>${waiting.length} waiting</span>`}
        </div>
        ${task.parentId && html`<p class="parent-context">Subtask of <strong>${parent?.title || task.parentId}</strong></p>`}
        ${rollup && html`<div class="subtask-rollup">
          <div class="rollup-label"><span>${rollup.done} / ${rollup.total} ${rollup.incomplete && !rollup.fromBackend ? "known " : ""}leaf subtasks done</span>
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
              selectedTaskIds=${selectedTaskIds} sourceTaskId=${task.id} reports=${reports} />
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
    <div class="section-heading"><h2 id="team-heading">Session team</h2><span class="count">${agents.length}</span></div>
    <div class="roster">${agents.map((agent) => {
      const primary = isPrimary(agent);
      const actorReports = reports.filter((report) => report.actorId === agent.id);
      const blocked = actorReports.filter(isBlockingReport);
      const note = blocked[0]?.message || agent.report?.message || agent.report;
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
    <div class="section-heading"><h2 id="delivery-heading">Approval & delivery</h2>
      <span class=${`status-dot ${merged ? "tone-success" : "tone-attention"}`}></span>
    </div>
    <p class=${`delivery-status ${merged ? "tone-success" : ""}`}>${headline}</p>
    ${phase && html`<p class="ck-caption">Phase · ${label(phase)}</p>`}
    <p class="ck-caption">${merged ? "Confirmed by explicit delivery status." : allDone && !approved
      ? "100% of tracked leaf tasks are done; approval and delivery are separate."
      : "Leaf-task progress does not imply approval or merge."}</p>
    <${Evidence} value=${delivery?.evidence} />
  </section>`;
}

function Plan({ plan, drafts }) {
  const content = text(plan?.content);
  const exists = plan?.exists === true || (plan?.exists !== false && Boolean(content));
  const summary = content.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !/^#|^---$/.test(line)).slice(0, 3).join(" ").slice(0, 260);
  return html`<section class="ck-card section-card" aria-labelledby="plan-heading">
    <div class="section-heading"><h2 id="plan-heading">Plan source</h2><${Badge}>${exists ? "Available" : "Not found"}</${Badge}></div>
    ${plan?.path && html`<p class="source-path">${text(plan.path)}</p>`}
    <p class="plan-summary">${exists ? summary || "Plan exists; no preview was provided." : "No plan is available in this snapshot. Only tracked leaf tasks count toward progress."}</p>
    ${content && exists && html`<details class="plan-disclosure"><summary>Read plan</summary>
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
    <div class="section-heading"><h2 id="activity-heading">Activity</h2><span class="ck-caption">Latest ${Math.min(events.length, 12)}</span></div>
    ${events.length ? html`<ol class="timeline">${events.slice(0, 12).map((event) => html`<li key=${event.id || event.localIndex}>
      <span class="timeline-marker" aria-hidden="true"><${Icon} name="circle" size=${12} /></span>
      <div><p class="activity-message">${text(event.message) || label(event.type || "update")}</p>
        <p class="ck-caption">${agents.find((agent) => agent.id === event.actorId)?.name || event.actorId || "Session"}
          <span class="separator">·</span><${Time} at=${event.at} />
        </p>
      </div>
    </li>`)}</ol>` : html`<${Empty}>No activity recorded yet.</${Empty}>`}
    ${events.length > 12 && html`<p class="ck-caption">Showing the latest 12 of ${events.length} events.</p>`}
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
    && !reports.some((report) => report.taskId === task.id && isBlockingReport(report)));
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
        <div><p class="eyebrow">Live tasks & subtasks</p><h1>Session Board Canvas</h1></div>
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
        <p class="ck-caption">The last available snapshot is preserved. Refresh to try again.</p>
      </div>
    </div>`}
    ${source.status === "stale" && !source.error && html`<div class="ck-callout freshness-notice" role="status">Source data is stale. Treat progress as the last known snapshot, not current confirmation.</div>`}
    ${!connected && state && html`<p class="connection-note">Live connection interrupted. Showing the last snapshot while reconnecting.</p>`}

    <section class="goal-overview ck-card" aria-labelledby="goal-title">
      <div class="goal-copy">
        <div class="minor-spread"><span class="eyebrow">${historical ? "Goal history" : selectedGoal ? "Current focus" : "Session overview"}</span>
          <${Badge} tone=${historical ? "muted" : "accent"}>${historical ? "Historical" : "Tracked work"}</${Badge}>
        </div>
        <h2 id="goal-title">${unavailableGoal ? "Selected goal unavailable" : selectedGoal?.title || (loading ? "Connecting to your session…" : "All session tasks")}</h2>
        <p class="ck-caption">${unavailableGoal ? "This goal is absent from the latest snapshot. Choose another goal below."
          : missingChildren.size ? `${missingChildren.size} child task records unavailable · waiting for a complete hierarchy snapshot.`
          : total === 0 ? "Not started · no tracked leaf tasks yet."
          : allDone ? "All tracked leaf tasks done. Milestone status, approval, and delivery remain separate."
          : `${total - done} leaf tasks remaining · canonical status is the source of truth.`}</p>
        <div class="goal-controls">
          <label class="sr-only" for="goal-select">Choose goal</label>
          <select id="goal-select" class="ck-select" value=${goalChoice} onChange=${(event) => setGoalChoice(event.target.value)}>
            <option value="">${activeGoal ? `Follow active: ${activeGoal.title}` : "Default goal"}</option>
            <option value=${SESSION_VIEW}>All session tasks</option>
            ${unavailableGoal && html`<option value=${goalChoice}>Selected goal (unavailable)</option>`}
            ${goals.map((goal) => html`<option key=${goal.id} value=${goal.id}>${goal.title || goal.id}${goal.id === model.activeGoalId ? " · active" : " · history"}</option>`)}
          </select>
          <button class="ck-btn ck-btn-sm" type="button" aria-expanded=${showHistory} aria-controls="goal-history" onClick=${() => setShowHistory(!showHistory)}>History (${history.length})</button>
        </div>
      </div>
      <div class="progress-metric">
        <span class="eyebrow">Verified leaf-task progress</span>
        <div class="metric-value" aria-live="polite" aria-atomic="true"><strong>${percentage ?? "—"}${percentage != null && html`<span>%</span>`}</strong><span>${done}<span class="ck-muted"> / ${total} leaves done</span></span></div>
        <div class="progress-track" role="progressbar" aria-label="Canonical leaf tasks done" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${percentage ?? undefined} aria-valuetext=${`${done} of ${total} recorded leaf tasks done${missingChildren.size ? "; hierarchy incomplete" : total ? "" : "; not started"}`}>
          <span style=${{ width: `${percentage ?? 0}%` }}></span>
        </div>
        <p class="ck-caption">${missingChildren.size ? "Incomplete hierarchy · percentage unavailable" : total === 0 ? "Not started"
          : unknown.length ? `${unknown.length} unknown leaves · not counted as done` : "All selected leaves · unaffected by filters"}</p>
        <p class="ck-caption">${milestones.length} milestone ${milestones.length === 1 ? "rollup" : "rollups"} excluded from totals</p>
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
            <div><h2 id="board-heading">Tasks & subtasks</h2><p class="ck-caption">${visible.length} of ${tasks.length} cards${query || statusFilter ? " match filters" : " tracked"} · ${total} leaf tasks · ${milestones.length} milestones</p></div>
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
              <div class="column-heading"><span class=${`status-dot tone-${column.tone}`}></span><h3>${column.label}</h3><span class="count" title="Cards, including milestone rollups">${columnTasks.length}</span></div>
              <p class="column-breakdown">${columnTasks.filter(isLeaf).length} leaves · ${columnTasks.filter((task) => !isLeaf(task)).length} milestones</p>
              <div class="column-tasks">${columnTasks.length ? columnTasks.map((task) => html`
                <${TaskCard} key=${task.id} task=${task} dependencies=${dependencies} taskMap=${taskMap} reports=${reports} agents=${agents}
                  goals=${goals} selectedTaskIds=${selectedTaskIds} selectedTaskId=${selectedTaskId} onTaskSelect=${selectTask}
                  expanded=${expandedTaskIds.includes(task.id)} onExpandedChange=${setTaskExpanded} />
              `) : html`<p class="column-empty">${column.id === "done" ? "Nothing done yet" : "No tasks"}</p>`}</div>
            </section>`;
          })}</div>
          ${visible.some((task) => taskStatus(task) === "unknown") && html`<section class="unknown-tasks" aria-label="Tasks with unknown status">
            <div class="section-heading"><h3 class="tone-attention">Unclassified tasks</h3><span class="ck-caption">Not counted as complete</span></div>
            <div class="unknown-list">${visible.filter((task) => taskStatus(task) === "unknown").map((task) => html`
              <${TaskCard} key=${task.id} task=${task} dependencies=${dependencies} taskMap=${taskMap} reports=${reports} agents=${agents}
                goals=${goals} selectedTaskIds=${selectedTaskIds} selectedTaskId=${selectedTaskId} onTaskSelect=${selectTask}
                expanded=${expandedTaskIds.includes(task.id)} onExpandedChange=${setTaskExpanded} />
            `)}</div>
          </section>`}
        </section>

        <${Blockers} tasks=${tasks} dependencies=${dependencies} taskMap=${taskMap} reports=${reports} agents=${agents}
          goals=${goals} selectedTaskIds=${selectedTaskIds} selectedGoal=${selectedGoal} />

        <div class="insights-grid">
          <section class="ck-card section-card" aria-labelledby="attention-heading">
            <div class="section-heading"><h2 id="attention-heading">Needs attention</h2><span class="count">${attention.length}</span></div>
            <p class="ck-caption section-intro">Operator action · current session, independent of board filters</p>
            ${attention.length ? html`<ul class="attention-list">
              ${attention.slice(0, 6).map((entry) => html`<li key=${entry.id}><span class="status-dot tone-attention"></span>
                <div><strong>${entry.title}</strong><p>${entry.message}</p>
                  ${entry.at && html`<span class="ck-caption"><${Time} at=${entry.at} /></span>`}
                </div>
              </li>`)}
            </ul>` : html`<${Empty}>No operator action needed.</${Empty}>`}
            ${attention.length > 6 && html`<p class="ck-caption">Showing 6 of ${attention.length} operator action requests.</p>`}
          </section>
          <section class="ck-card section-card" aria-labelledby="ready-heading">
            <div class="section-heading"><h2 id="ready-heading">Ready next</h2><span class="count">${ready.length}</span></div>
            <p class="ck-caption section-intro">Leaf tasks to do · dependencies resolved · no reported blocker</p>
            ${ready.length ? html`<ol class="ready-list">${ready.slice(0, 6).map((task, index) => html`<li key=${task.id}>
              <span class="ready-number">${String(index + 1).padStart(2, "0")}</span><div><strong>${task.title || "Untitled task"}</strong><code>${task.id}</code></div>
            </li>`)}</ol>` : html`<${Empty}>${allDone ? "All tracked leaf tasks are done." : "No leaf task is ready to start yet."}</${Empty}>`}
            ${ready.length > 6 && html`<p class="ck-caption">Showing the first 6 of ${ready.length} ready tasks.</p>`}
          </section>
        </div>
        <${Activity} activity=${list(model.activity)} reports=${list(model.reports)} agents=${agents} />
      </div>
      <aside class="sidebar" aria-label="Session context">
        <${Delivery} delivery=${delivery} allDone=${allDone} total=${total} />
        <${Team} agents=${agents} reports=${reports} />
        <${Plan} plan=${model.plan} drafts=${list(model.drafts)} />
      </aside>
    </div>`}
    <footer class="page-footer"><span>Canonical leaf tasks · milestone rollups · explicit delivery evidence</span><span>No edits or model calls from this view</span></footer>
  </main>`;
}

mountCanvas({ view: (model) => html`<${App} ...${model} />` });
