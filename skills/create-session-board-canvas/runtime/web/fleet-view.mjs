import { html, useState } from "/kit/core-client.mjs";
import { Icon } from "/kit/icons.mjs";
import {
  buildChatsDeepLink,
  buildNewAutomationDeepLink,
  safeDeepLinkUrl,
} from "./deeplinks.mjs";
import { safeHttpsUrl } from "./view-model.mjs";

const KANBAN_COLS = [
  { id: "pending", label: "To do", tone: "muted" },
  { id: "in_progress", label: "Doing", tone: "accent" },
  { id: "blocked", label: "Blocked", tone: "danger" },
  { id: "done", label: "Done", tone: "success" },
];

const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
const text = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const pretty = (v) => text(v).replace(/[_-]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function Badge({ children, tone = "muted" }) {
  return html`<span class=${`ck-badge ck-badge-${tone}`}>${children}</span>`;
}

function activityTone(activity) {
  if (activity === "busy") return "accent";
  if (activity === "waiting") return "attention";
  return "muted";
}

function surfaceLabel(surface) {
  if (surface === "cli") return "CLI";
  if (surface === "chat") return "Chat";
  return "Desktop";
}

function ciTone(status) {
  if (status === "passed") return "success";
  if (status === "failed") return "danger";
  if (status === "running" || status === "pending") return "attention";
  return "muted";
}

export function ScopeNav({ activeScope, inboxCount = 0, switching, onSelectScope }) {
  const tabs = [
    { id: "session", label: "This session", icon: "layout-list" },
    { id: "projects", label: "Projects & sessions", icon: "folder-git-2" },
    { id: "inbox", label: "Attention inbox", icon: "inbox", count: inboxCount },
  ];
  return html`<nav class="scope-nav" aria-label="Board scope">
    ${tabs.map((tab) => html`
      <button
        key=${tab.id}
        type="button"
        class=${`scope-tab ${activeScope === tab.id ? "scope-tab-active" : ""}`}
        aria-pressed=${activeScope === tab.id}
        disabled=${switching}
        onClick=${() => onSelectScope(tab.id)}
      >
        <${Icon} name=${tab.icon} size=${14} />
        <span>${tab.label}</span>
        ${tab.count > 0 && html`<span class="scope-count">${tab.count}</span>`}
      </button>
    `)}
  </nav>`;
}

function InboxCard({ item, invoke, onInspectSession }) {
  const [freeform, setFreeform] = useState("");
  const [planFeedback, setPlanFeedback] = useState("");
  const [planMode, setPlanMode] = useState("autopilot");
  const [busy, setBusy] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState("");
  const [needsDeepLink, setNeedsDeepLink] = useState(false);
  const [copied, setCopied] = useState(false);

  const safeLink = safeDeepLinkUrl(item.deepLink);
  const safeRestart = safeDeepLinkUrl(item.restartDeepLink);

  async function submitAnswer(answerText) {
    if (busy || !text(answerText).trim()) return;
    setBusy(true);
    setFeedbackMsg("");
    try {
      await invoke("answer_input", {
        targetSessionId: item.sessionId,
        requestId: item.requestId,
        answer: text(answerText).trim(),
      });
      setFreeform("");
      setFeedbackMsg("Answer sent.");
    } catch (err) {
      setFeedbackMsg(err?.message || "Could not submit answer.");
    } finally {
      setBusy(false);
    }
  }

  async function submitPlanDecision(approved) {
    if (busy) return;
    setBusy(true);
    setFeedbackMsg("");
    try {
      const res = await invoke("respond_plan", {
        targetSessionId: item.sessionId,
        requestId: item.requestId,
        approved,
        ...(planFeedback.trim() ? { feedback: planFeedback.trim() } : {}),
        ...(approved ? { selectedAction: planMode } : {}),
      });
      if (res?.requiresDeepLink) {
        setNeedsDeepLink(true);
        setFeedbackMsg(res.message || "Open the session directly to confirm this plan.");
      } else {
        setFeedbackMsg(approved ? "Plan approved." : "Plan returned for changes.");
      }
    } catch (err) {
      setFeedbackMsg(err?.message || "Could not resolve plan.");
    } finally {
      setBusy(false);
    }
  }

  async function submitWake() {
    if (busy) return;
    setBusy(true);
    setFeedbackMsg("");
    try {
      await invoke("trigger_recovery", { targetSessionId: item.sessionId });
      setFeedbackMsg("Recovery wake sent.");
    } catch (err) {
      setFeedbackMsg(err?.message || "Recovery failed.");
    } finally {
      setBusy(false);
    }
  }

  async function copyResume() {
    if (!item.resumeCommand) return;
    try {
      await navigator.clipboard.writeText(item.resumeCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFeedbackMsg(`Run in terminal: ${item.resumeCommand}`);
    }
  }

  const kindTone = item.kind === "ask_user" || item.kind === "pending_plan" ? "attention"
    : item.kind === "circuit_open" || item.kind === "attention_only" ? "danger" : "accent";

  return html`<article class="ck-card inbox-card">
    <div class="inbox-card-header">
      <div class="inbox-identity">
        <${Badge} tone=${kindTone}>${pretty(item.kind)}</${Badge}>
        <strong>${item.sessionTitle}</strong>
        <span class="ck-caption">${item.projectName} · ${surfaceLabel(item.surface)}</span>
      </div>
      <div class="inbox-links">
        <button type="button" class="ck-btn ck-btn-sm" onClick=${() => onInspectSession(item.sessionId)}>Inspect</button>
        ${safeLink && html`<a class=${`ck-btn ck-btn-sm ${needsDeepLink ? "ck-btn-primary" : ""}`} href=${safeLink} target="_blank" rel="noopener noreferrer">
          Open session <${Icon} name="arrow-up-right" size=${12} />
        </a>`}
      </div>
    </div>

    ${item.kind === "ask_user" && html`<div class="inbox-body">
      <p class="inbox-prompt">${item.question}</p>
      ${item.canAnswerInline ? html`
        ${list(item.choices).length > 0 && html`<div class="choice-row">
          ${list(item.choices).map((choice) => html`
            <button key=${choice} type="button" class="ck-btn ck-btn-sm" disabled=${busy} onClick=${() => submitAnswer(choice)}>
              ${choice}
            </button>
          `)}
        </div>`}
        ${item.allowFreeform && html`<form class="inline-reply-form" onSubmit=${(e) => { e.preventDefault(); submitAnswer(freeform); }}>
          <input class="ck-input" type="text" placeholder="Type response…" value=${freeform} onInput=${(e) => setFreeform(e.target.value)} disabled=${busy} />
          <button type="submit" class="ck-btn ck-btn-sm" disabled=${busy || !freeform.trim()}>
            <${Icon} name="send" size=${12} /> Reply
          </button>
        </form>`}
      ` : html`<p class="ck-caption">Respond inside the target ${item.surface === "cli" ? "terminal" : "session"}.</p>`}
    </div>`}

    ${item.kind === "pending_plan" && html`<div class="inbox-body">
      <p class="inbox-prompt preserve-lines">${item.summary}</p>
      ${item.planContent && html`<details class="plan-disclosure">
        <summary>Preview full plan.md</summary>
        <pre class="plan-content">${text(item.planContent).slice(0, 12000)}</pre>
      </details>`}
      ${item.canRespondInline && !needsDeepLink && html`<div class="plan-actions">
        <select class="ck-select" value=${planMode} onChange=${(e) => setPlanMode(e.target.value)} disabled=${busy} aria-label="Approval execution mode">
          <option value="autopilot">Build on autopilot</option>
          <option value="interactive">Build interactively</option>
        </select>
        <button type="button" class="ck-btn ck-btn-sm" disabled=${busy} onClick=${() => submitPlanDecision(true)}>
          <${Icon} name="check" size=${12} /> Approve coordinated plan
        </button>
        <input class="ck-input" type="text" placeholder="Optional feedback if rejecting…" value=${planFeedback} onInput=${(e) => setPlanFeedback(e.target.value)} disabled=${busy} />
        <button type="button" class="ck-btn ck-btn-sm" disabled=${busy} onClick=${() => submitPlanDecision(false)}>
          Request changes
        </button>
      </div>`}
    </div>`}

    ${(item.kind === "permission" || item.kind === "elicitation" || item.kind === "operator_attention") && html`<div class="inbox-body">
      <p class="inbox-prompt">${item.message || "Approval or interactive sign-in required in the session."}</p>
    </div>`}

    ${["wake_verify", "attention_only", "cli_resume", "zombie_stall", "circuit_open"].includes(item.kind) && html`<div class="inbox-body">
      <p class="inbox-prompt">${item.reason || "Session requires recovery attention."}</p>
      <div class="choice-row">
        ${item.attempts > 0 && html`<span class="ck-caption">Recovery attempts: ${item.attempts} / ${item.maxRetries}</span>`}
        ${item.canWakeInline && html`<button type="button" class="ck-btn ck-btn-sm" disabled=${busy} onClick=${submitWake}>
          <${Icon} name="play" size=${12} /> Wake & verify state
        </button>`}
        ${safeRestart && html`<a class="ck-btn ck-btn-sm" href=${safeRestart} target="_blank" rel="noopener noreferrer">
          <${Icon} name="rotate-ccw" size=${12} /> Restart CLI
        </a>`}
        ${item.resumeCommand && html`<button type="button" class="ck-btn ck-btn-sm" onClick=${copyResume}>
          <${Icon} name="terminal" size=${12} /> ${copied ? "Copied!" : item.resumeCommand}
        </button>`}
      </div>
    </div>`}

    ${feedbackMsg && html`<p class="ck-caption inbox-feedback" role="status">${feedbackMsg}</p>`}
  </article>`;
}

function SessionDrillDown({ session, recoveryHistory = [], invoke, onClose }) {
  const [msg, setMsg] = useState("");
  const [deliveryMode, setDeliveryMode] = useState("immediate");
  const [modeOverride, setModeOverride] = useState("");
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState("");

  if (!session) return null;

  const safeOpen = safeDeepLinkUrl(session.deepLink);
  const safeRestart = safeDeepLinkUrl(session.restartDeepLink);
  const todos = list(session.todos);
  const subagents = list(session.subagents);
  const prs = list(session.prs);
  const sessionLogs = list(recoveryHistory).filter((h) => h.sessionId === session.id);

  async function handleSend(event) {
    event.preventDefault();
    if (sending || !msg.trim()) return;
    setSending(true);
    setSendStatus("");
    try {
      const payload = {
        targetSessionId: session.id,
        message: msg.trim(),
        deliveryMode,
      };
      if (modeOverride) payload.mode = modeOverride;
      await invoke("send_message", payload);
      setMsg("");
      setSendStatus(deliveryMode === "immediate" ? "Immediate steer delivered." : "Message queued behind current turn.");
    } catch (err) {
      setSendStatus(err?.message || "Failed to send message.");
    } finally {
      setSending(false);
    }
  }

  return html`<section class="ck-card drilldown-panel" aria-label=${`Session details for ${session.title}`}>
    <div class="drilldown-header">
      <div class="drilldown-title-group">
        <${Badge} tone=${activityTone(session.activity)}>${pretty(session.activity)}</${Badge}>
        <${Badge}>${surfaceLabel(session.surface)}</${Badge}>
        <${Badge}>${pretty(session.mode || "interactive")}</${Badge}>
        <h2>${session.title}</h2>
        ${session.branch && html`<code><${Icon} name="git-branch" size=${11} /> ${session.branch}</code>`}
      </div>
      <div class="inbox-links">
        ${safeOpen && html`<a class="ck-btn ck-btn-sm" href=${safeOpen} target="_blank" rel="noopener noreferrer">
          Open session <${Icon} name="arrow-up-right" size=${12} />
        </a>`}
        ${safeRestart && html`<a class="ck-btn ck-btn-sm" href=${safeRestart} target="_blank" rel="noopener noreferrer">
          Restart CLI
        </a>`}
        <button type="button" class="ck-btn ck-btn-sm" onClick=${onClose} aria-label="Close session inspector">
          <${Icon} name="x" size=${14} /> Close
        </button>
      </div>
    </div>

    <p class="ck-caption drilldown-meta">
      <code>${session.id}</code> · Project: <strong>${session.projectName}</strong>
      · Leaf tasks: <strong>${session.taskProgress?.done ?? 0} / ${session.taskProgress?.total ?? 0}</strong>
      ${session.taskProgress?.percent != null ? ` (${session.taskProgress.percent}%)` : ""}
    </p>

    ${session.surface !== "cli" ? html`<form class="composer-box" onSubmit=${handleSend}>
      <label class="sr-only" for="session-composer">Message or steer session</label>
      <textarea
        id="session-composer"
        class="ck-input composer-textarea"
        rows="2"
        placeholder=${session.awaitingInput ? "Answer the pending input prompt in the Attention Inbox before sending a message…" : "Send instructions, steer an active run, or wake this dormant session…"}
        value=${msg}
        onInput=${(e) => setMsg(e.target.value)}
        disabled=${sending || Boolean(session.awaitingInput)}
      ></textarea>
      <div class="composer-controls">
        <select class="ck-select" value=${deliveryMode} onChange=${(e) => setDeliveryMode(e.target.value)} disabled=${sending} aria-label="Delivery mode">
          <option value="immediate">Immediate steer</option>
          <option value="enqueue">Enqueue after turn</option>
        </select>
        <select class="ck-select" value=${modeOverride} onChange=${(e) => setModeOverride(e.target.value)} disabled=${sending} aria-label="Optional session mode switch">
          <option value="">Keep current mode</option>
          <option value="autopilot">Switch to autopilot</option>
          <option value="interactive">Switch to interactive</option>
          <option value="plan">Switch to plan</option>
        </select>
        <button type="submit" class="ck-btn ck-btn-sm" disabled=${sending || !msg.trim() || Boolean(session.awaitingInput)}>
          <${Icon} name="send" size=${12} /> ${sending ? "Sending…" : "Send"}
        </button>
        ${sendStatus && html`<span class="ck-caption" role="status">${sendStatus}</span>`}
      </div>
    </form>` : html`<p class="ck-caption composer-cli-note">
      Standalone CLI session — attach in terminal via <code>copilot --resume ${session.id}</code>.
    </p>`}

    <div class="drilldown-grid">
      <div>
        <h4>Canonical tasks (${todos.length})</h4>
        <div class="kanban drilldown-kanban">
          ${KANBAN_COLS.map((col) => {
            const colTasks = todos.filter((t) => (KANBAN_COLS.some((c) => c.id === t.status) ? t.status : "pending") === col.id);
            return html`<div class="kanban-column" key=${col.id}>
              <div class="column-heading">
                <span class=${`status-dot tone-${col.tone}`}></span>
                <h3>${col.label}</h3>
                <span class="column-count"><span class="count">${colTasks.length}</span></span>
              </div>
              <div class="column-tasks">
                ${colTasks.length ? colTasks.map((t) => html`<div class="task-card drilldown-task" key=${t.id}>
                  <div class="drilldown-task-body">
                    <strong>${t.title || t.id}</strong>
                    <code>${t.id}</code>
                  </div>
                </div>`) : html`<p class="column-empty">Empty</p>`}
              </div>
            </div>`;
          })}
        </div>
      </div>

      <div class="drilldown-side">
        <div class="ck-card section-card">
          <div class="section-heading"><h2>Subagents & PRs</h2><span class="count">${subagents.length + prs.length}</span></div>
          ${prs.length > 0 && html`<ul class="plain-list">
            ${prs.map((pr) => {
              const safePrUrl = safeHttpsUrl(pr.url);
              return html`<li key=${pr.url}>
                ${safePrUrl ? html`<a href=${safePrUrl} target="_blank" rel="noopener noreferrer">${pr.reference}</a>` : pr.reference}
                ${" · "}<${Badge} tone=${ciTone(pr.ciStatus)}>CI ${pr.ciStatus}${pr.ciTotal != null ? ` (${pr.ciPassed}/${pr.ciTotal})` : ""}</${Badge}>
              </li>`;
            })}
          </ul>`}
          ${subagents.length > 0 && html`<ul class="plain-list">
            ${subagents.map((a) => html`<li key=${a.id}>
              <strong>${a.name || a.id}</strong> · <${Badge} tone=${a.state === "failed" ? "danger" : a.state === "completed" ? "success" : "accent"}>${pretty(a.state)}</${Badge}>
              ${a.error && html`<p class="ck-caption tone-danger">${a.error}</p>`}
            </li>`)}
          </ul>`}
          ${prs.length === 0 && subagents.length === 0 && html`<p class="ck-caption">No tracked PRs or subagents recorded.</p>`}
        </div>

        ${session.plan?.exists && session.plan?.content && html`<div class="ck-card section-card">
          <details class="plan-disclosure" open>
            <summary>Session plan.md</summary>
            <pre class="plan-content">${text(session.plan.content).slice(0, 15000)}</pre>
          </details>
        </div>`}

        ${sessionLogs.length > 0 && html`<div class="ck-card section-card">
          <div class="section-heading"><h2>Recovery log</h2><span class="count">${sessionLogs.length}</span></div>
          <ul class="plain-list">
            ${sessionLogs.slice(-5).map((entry, idx) => html`<li key=${idx}>
              <strong>Attempt ${entry.attempt} (${entry.mode})</strong> · <span class="ck-caption">${entry.reason}</span>
            </li>`)}
          </ul>
        </div>`}
      </div>
    </div>
  </section>`;
}

export function FleetWorkspace({ fleet, activeScope, invoke, onSelectScope }) {
  const [search, setSearch] = useState("");
  const [surfaceFilter, setSurfaceFilter] = useState("");
  const [activityFilter, setActivityFilter] = useState("");
  const [policyBusy, setPolicyBusy] = useState(false);

  const model = fleet || {};
  const summary = model.summary || { totalSessions: 0, busy: 0, waiting: 0, attention: 0, idle: 0, totalProjects: 0 };
  const inbox = list(model.inbox);
  const projects = list(model.projects);
  const chatsLink = buildChatsDeepLink();
  const newAutoLink = buildNewAutomationDeepLink({});

  async function handlePolicyChange(nextPolicy) {
    setPolicyBusy(true);
    try {
      await invoke("set_recovery_policy", { policy: nextPolicy });
    } finally {
      setPolicyBusy(false);
    }
  }

  async function inspectSession(sessionId) {
    await invoke("select_session", { targetSessionId: sessionId });
  }

  const q = search.trim().toLowerCase();
  const filteredProjects = projects
    .map((proj) => {
      const matchingSessions = list(proj.sessions).filter((s) => {
        if (surfaceFilter && s.surface !== surfaceFilter) return false;
        if (activityFilter && s.activity !== activityFilter) return false;
        if (!q) return true;
        return [s.title, s.id, s.branch, proj.name, ...list(s.prs).map((p) => p.reference)]
          .some((field) => text(field).toLowerCase().includes(q));
      });
      return { ...proj, matchingSessions };
    })
    .filter((proj) => proj.matchingSessions.length > 0 || (!q && !surfaceFilter && !activityFilter && proj.workflowCount > 0));

  return html`<div class="fleet-container">
    <section class="fleet-kpi-bar ck-card" aria-label="Fleet summary and recovery policy">
      <div class="kpi-metrics">
        <div class="kpi-cell"><span class="ck-caption">Projects</span><strong>${summary.totalProjects}</strong></div>
        <div class="kpi-cell"><span class="ck-caption">Sessions</span><strong>${summary.totalSessions}</strong></div>
        <div class="kpi-cell"><span class="ck-caption">Busy</span><strong class="tone-accent">${summary.busy}</strong></div>
        <div class="kpi-cell"><span class="ck-caption">Waiting</span><strong class="tone-attention">${summary.waiting}</strong></div>
        <div class="kpi-cell"><span class="ck-caption">Inbox</span><strong class=${summary.attention > 0 ? "tone-danger" : ""}>${summary.attention}</strong></div>
      </div>
      <div class="kpi-controls">
        <label class="policy-label">
          <span class="ck-caption">Auto-recover</span>
          <select
            class="ck-select"
            value=${model.recoveryPolicy || "off"}
            disabled=${policyBusy}
            onChange=${(e) => handlePolicyChange(e.target.value)}
          >
            <option value="off">Off (manual)</option>
            <option value="autopilot_only">Autopilot only</option>
            <option value="all_active">All active</option>
          </select>
        </label>
        ${chatsLink && html`<a class="ck-btn ck-btn-sm" href=${chatsLink} target="_blank" rel="noopener noreferrer">Chats</a>`}
        ${newAutoLink && html`<a class="ck-btn ck-btn-sm" href=${newAutoLink} target="_blank" rel="noopener noreferrer">+ Automation</a>`}
      </div>
    </section>

    ${model.coordinatorScoped && html`<div class="ck-callout freshness-notice" role="status">
      Coordinator-scoped live status detected: sibling sessions outside this coordinator are enriched from local session-state artifacts.
    </div>`}
    ${model.hostToolsAvailable === false && html`<div class="ck-callout freshness-notice" role="status">
      Running in local session-state mode: desktop session controls are unavailable on this host, showing $COPILOT_HOME sessions read-only.
    </div>`}

    ${model.selectedDetail && html`<${SessionDrillDown}
      key=${model.selectedDetail.id}
      session=${model.selectedDetail}
      recoveryHistory=${model.recoveryHistory}
      invoke=${invoke}
      onClose=${() => inspectSession(null)}
    />`}

    ${activeScope === "inbox" ? html`<section aria-labelledby="fleet-inbox-heading">
      <div class="board-toolbar">
        <div>
          <h2 id="fleet-inbox-heading">Operator attention inbox</h2>
          <p class="ck-caption">Answer questions, review plans, jump to permissions, and wake stalled runs across all sessions.</p>
        </div>
      </div>
      ${inbox.length > 0 ? html`<div class="inbox-stack">
        ${inbox.map((item) => html`<${InboxCard} key=${item.id} item=${item} invoke=${invoke} onInspectSession=${inspectSession} />`)}
      </div>` : html`<div class="ck-card board-empty"><p class="ck-muted">Zero sessions awaiting operator action.</p></div>`}
    </section>` : html`<section aria-labelledby="fleet-projects-heading">
      ${inbox.length > 0 && html`<div class="ck-card inbox-banner">
        <div class="minor-spread">
          <span><${Icon} name="bell" size=${14} /> <strong>${inbox.length} ${inbox.length === 1 ? "session needs" : "sessions need"} operator attention</strong></span>
          <button type="button" class="ck-btn ck-btn-sm" onClick=${() => onSelectScope("inbox")}>Open attention inbox</button>
        </div>
      </div>`}

      <div class="board-toolbar">
        <div>
          <h2 id="fleet-projects-heading">Projects & active sessions</h2>
          <p class="ck-caption">${filteredProjects.length} ${filteredProjects.length === 1 ? "group" : "groups"} · leaf-only task rollups · zero background model tokens</p>
        </div>
        <div class="board-filters">
          <input class="ck-input" type="search" placeholder="Filter repo, session, branch, PR…" value=${search} onInput=${(e) => setSearch(e.target.value)} aria-label="Filter projects and sessions" />
          <select class="ck-select" value=${surfaceFilter} onChange=${(e) => setSurfaceFilter(e.target.value)} aria-label="Filter surface">
            <option value="">All surfaces</option>
            <option value="desktop">Desktop</option>
            <option value="chat">Chats</option>
            <option value="cli">CLI terminals</option>
          </select>
          <select class="ck-select" value=${activityFilter} onChange=${(e) => setActivityFilter(e.target.value)} aria-label="Filter activity">
            <option value="">All states</option>
            <option value="busy">Busy</option>
            <option value="waiting">Waiting</option>
            <option value="idle">Idle</option>
          </select>
        </div>
      </div>

      ${filteredProjects.length === 0 ? html`<div class="ck-card board-empty"><p class="ck-muted">No sessions match your current filters.</p></div>` : html`
        <div class="project-grid">
          ${filteredProjects.map((proj) => {
            const safeNew = safeDeepLinkUrl(proj.newSessionDeepLink);
            return html`<section class="ck-card project-card" key=${proj.key} aria-label=${proj.name}>
              <div class="project-card-header">
                <div class="project-title-row">
                  <${Icon} name="folder-git-2" size=${16} />
                  <h3>${proj.name}</h3>
                  <${Badge}>${proj.matchingSessions.length} ${proj.matchingSessions.length === 1 ? "session" : "sessions"}</${Badge}>
                  ${proj.busyCount > 0 && html`<${Badge} tone="accent">${proj.busyCount} busy</${Badge}>`}
                  ${proj.attentionCount > 0 && html`<${Badge} tone="attention">${proj.attentionCount} attention</${Badge}>`}
                  ${proj.workflowCount > 0 && html`<${Badge}>${proj.workflowCount} ${proj.workflowCount === 1 ? "automation" : "automations"}</${Badge}>`}
                </div>
                <div class="inbox-links">
                  ${proj.taskProgress.total > 0 && html`<span class="ck-caption">${proj.taskProgress.done}/${proj.taskProgress.total} leaves${proj.taskProgress.percent != null ? ` (${proj.taskProgress.percent}%)` : " · % unknown"}</span>`}
                  ${safeNew && html`<a class="ck-btn ck-btn-sm" href=${safeNew} target="_blank" rel="noopener noreferrer">
                    <${Icon} name="plus" size=${12} /> New session
                  </a>`}
                </div>
              </div>
              ${proj.taskProgress.total > 0 && html`<div class="progress-track project-progress-track">
                <span style=${{ width: `${proj.taskProgress.percent ?? 0}%` }}></span>
              </div>`}
              <div class="session-table">
                ${proj.matchingSessions.map((session) => {
                  const safeOpen = safeDeepLinkUrl(session.deepLink);
                  return html`<div class=${`session-row ${model.selectedSessionId === session.id ? "session-row-selected" : ""}`} key=${session.id}>
                    <div class="session-row-main">
                      <span class=${`status-dot tone-${activityTone(session.activity)}`}></span>
                      <button type="button" class="session-title-btn" onClick=${() => inspectSession(session.id)}>
                        ${session.title}
                      </button>
                      <${Badge}>${surfaceLabel(session.surface)}</${Badge}>
                      <${Badge} tone=${activityTone(session.activity)}>${pretty(session.activity)}</${Badge}>
                      ${session.branch && html`<code class="branch-pill">${session.branch}</code>`}
                    </div>
                    <div class="session-row-meta">
                      ${session.taskProgress.total > 0 && html`<span class="ck-caption">${session.taskProgress.done}/${session.taskProgress.total} tasks</span>`}
                      ${list(session.subagents).length > 0 && html`<span class="ck-caption"><${Icon} name="bot" size=${12} /> ${list(session.subagents).length}</span>`}
                      ${list(session.prs).map((pr) => {
                        const safePr = safeHttpsUrl(pr.url);
                        return html`<span key=${pr.url} class="pr-chip">
                          ${safePr ? html`<a href=${safePr} target="_blank" rel="noopener noreferrer">${pr.reference}</a>` : pr.reference}
                          <${Badge} tone=${ciTone(pr.ciStatus)}>${pr.ciStatus}</${Badge}>
                        </span>`;
                      })}
                      <button type="button" class="ck-btn ck-btn-sm" onClick=${() => inspectSession(session.id)}>Inspect</button>
                      ${safeOpen && html`<a class="ck-btn ck-btn-sm" href=${safeOpen} target="_blank" rel="noopener noreferrer" title="Open session">
                        <${Icon} name="arrow-up-right" size=${12} />
                      </a>`}
                    </div>
                  </div>`;
                })}
              </div>
            </section>`;
          })}
        </div>
      `}
    </section>`}
  </div>`;
}
