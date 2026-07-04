// web/app.mjs — Preact view for the Decision Log canvas.
//
// Two kinds of state, deliberately separated:
//   * SHARED domain state (the decisions) arrives over /events (SSE) and is the
//     same data the agent mutates. mountCanvas re-renders on every push.
//   * LOCAL UI state (the new-decision draft + the active filter) lives in
//     Preact useState. Because Preact DIFFS the DOM instead of replacing
//     innerHTML, a live state push does NOT clobber the text you're typing or
//     move your caret — the core fix over the hand-rolled innerHTML canvases.

import {
  html,
  mountCanvas,
  useState,
  Icon,
  relativeTime,
  buildSessionDeepLink,
  buildSessionDetailDeepLink,
  buildChatsDeepLink,
  buildNewAutomationDeepLink,
  buildIssueDeepLink,
  buildPullRequestDeepLink,
  hostedLauncherUrl,
  quoteUntrusted,
  isRepoFullName,
} from "/kit/client.mjs";

const FILTERS = ["all", "open", "decided", "parked"];

// Semantic status -> Lucide name (same glyphs github-app maps these to:
// IssueOpenIcon=CircleDot, CheckCircleIcon=CircleCheck, BookmarkIcon=Bookmark).
const STATUS_ICON = { open: "circle-dot", decided: "circle-check", parked: "bookmark" };

// Map this canvas's statuses to the kit's generic badge variants. The kit theme
// ships semantic classes (ck-badge-success/accent/muted/…), not app-specific
// status names, so each canvas owns its own status -> variant mapping here.
const STATUS_BADGE = { open: "success", decided: "accent", parked: "muted" };

function Badge({ status }) {
  return html`<span class=${`ck-badge ck-badge-${STATUS_BADGE[status] ?? "muted"}`}>
    <${Icon} name=${STATUS_ICON[status]} size=${12} />${status}
  </span>`;
}

// Build the kickoff prompt for a decision handed to a NEW github-app session.
// Untrusted fields (title, note) are wrapped with quoteUntrusted so they read as
// data, not instructions, to the agent on the other side of the deep link.
function sessionPromptFor(d) {
  const bits = [
    `Work on this decision from our decision log: ${quoteUntrusted(d.title)}.`,
    `Status: ${d.status}.`,
  ];
  if (d.note) bits.push(`Note: ${quoteUntrusted(d.note)}.`);
  return bits.join(" ");
}

// A deep link rendered as a button-styled anchor. target="_blank" is REQUIRED:
// the canvas webview only routes _blank clicks into the app's deeplink pipeline.
// When href is null (invalid or insufficient input) we render a disabled button so
// the control still shows but can never open a dead link.
function LinkButton({ href, icon, label, title, small = true }) {
  const cls = `ck-btn${small ? " ck-btn-sm" : ""}`;
  const size = small ? 14 : 16;
  return href
    ? html`<a class=${cls} href=${href} target="_blank" rel="noopener noreferrer" title=${title}>
        <${Icon} name=${icon} size=${size} />${label}
      </a>`
    : html`<button class=${cls} disabled title=${title}>
        <${Icon} name=${icon} size=${size} />${label}
      </button>`;
}

// Showcase of EVERY github-app deep-link builder the kit ships (kit/deeplinks.mjs).
// Each link is built + validated by the kit and rendered by LinkButton as a
// target="_blank" anchor; the canvas webview routes the click into the app's
// confirmation-gated deeplink pipeline. The "web links" toggle wraps each link in
// the hosted dotcom launcher (hostedLauncherUrl) so it also works from a browser.
// The project repo is SHARED state (state.repo, set via set_repo so the agent can
// set it too); the issue/PR number and session id are LOCAL drafts (useState), used
// only to build a link, so a live push never clobbers what you're typing.
function AppIntegrations({ state, invoke }) {
  const [draft, setDraft] = useState(state.repo ?? "");
  const [savingRepo, setSavingRepo] = useState(false);
  const [repoErr, setRepoErr] = useState("");
  const [web, setWeb] = useState(false);
  const [itemNo, setItemNo] = useState("");
  const [sessionId, setSessionId] = useState("");

  const repo = state.repo; // authoritative value (shared state)
  const trimmed = draft.trim();
  const repoValid = trimmed === "" || isRepoFullName(trimmed);
  const repoDirty = trimmed !== (repo ?? "");

  // In "web links" mode, wrap a ghapp:// link in the dotcom launcher so it opens
  // from a browser too; otherwise link the app scheme directly.
  const linkFor = (deep) => (deep && web ? hostedLauncherUrl(deep, { entryPoint: "decision_log" }) : deep);

  async function saveRepo() {
    if (savingRepo || !repoValid || !repoDirty) return;
    setSavingRepo(true);
    setRepoErr("");
    try {
      await invoke("set_repo", { repo: trimmed });
    } catch (e) {
      setRepoErr(e?.message || "Couldn't set the repo");
    } finally {
      setSavingRepo(false);
    }
  }

  const [owner, name] = (repo ?? "").split("/");
  const num = itemNo.trim();
  const repoHint = repo ? undefined : "Set a project repo first";
  const chatsUrl = linkFor(buildChatsDeepLink());
  const automationUrl = linkFor(
    buildNewAutomationDeepLink({
      name: "Daily decision log review",
      prompt: "Summarize the open decisions in our log and recommend the next step.",
      trigger: "daily",
      time: "09:00",
    })
  );
  const issueUrl = repo ? linkFor(buildIssueDeepLink({ owner, repo: name, number: num })) : null;
  const prUrl = repo ? linkFor(buildPullRequestDeepLink({ owner, repo: name, number: num })) : null;
  const sessionUrl = linkFor(buildSessionDetailDeepLink(sessionId.trim()));

  return html`
    <div class="ck-card dl-integrations ck-col">
      <div class="ck-spread">
        <div class="ck-row" style="gap:6px">
          <${Icon} name="external-link" size=${16} />
          <span class="dl-item-title">Open in github-app</span>
        </div>
        <label class="ck-row ck-caption" style="gap:6px; cursor:pointer" title="Wrap links in the hosted launcher so they open from a browser too">
          <input type="checkbox" checked=${web} onChange=${(e) => setWeb(e.target.checked)} />
          Shareable web links
        </label>
      </div>

      <div class="ck-row">
        <${Icon} name="folder-git-2" size=${16} />
        <input
          class="ck-input"
          placeholder="owner/repo"
          value=${draft}
          aria-invalid=${String(!repoValid)}
          onInput=${(e) => setDraft(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter") saveRepo(); }}
        />
        <button class="ck-btn" disabled=${!repoValid || !repoDirty || savingRepo} onClick=${saveRepo}>
          <${Icon} name=${savingRepo ? "loader-circle" : "check"} size=${16} class=${savingRepo ? "ck-spinner" : ""} />Save
        </button>
        ${repo ? html`<span class="ck-badge ck-badge-accent">${repo}</span>` : null}
      </div>
      ${!repoValid
        ? html`<div class="ck-caption ck-muted">Enter a repo as <code>owner/repo</code>.</div>`
        : html`<span class="ck-caption">Enables each decision's "Open in session" link, plus the issue/PR links below.</span>`}
      ${repoErr
        ? html`<div class="ck-callout ck-error"><${Icon} name="circle-x" size=${16} /><span>${repoErr}</span></div>`
        : null}

      <div class="ck-caption ck-muted" style="margin-top:4px">App surfaces</div>
      <div class="ck-row dl-actions">
        <${LinkButton} href=${chatsUrl} icon="message-circle" label="Open Chats" title="Open the Chats surface" />
        <${LinkButton} href=${automationUrl} icon="calendar-clock" label="Automate daily review" title="Pre-fill a daily automation to review this log" />
      </div>

      <div class="ck-caption ck-muted" style="margin-top:4px">Jump to an issue or PR</div>
      <div class="ck-row dl-actions">
        <input
          class="ck-input"
          style="max-width:120px"
          placeholder="number"
          inputmode="numeric"
          value=${itemNo}
          onInput=${(e) => setItemNo(e.target.value)}
        />
        <${LinkButton} href=${issueUrl} icon="circle-dot" label="Open issue" title=${repoHint ?? "Open this issue in github-app"} />
        <${LinkButton} href=${prUrl} icon="git-pull-request" label="Open PR" title=${repoHint ?? "Open this pull request in github-app"} />
      </div>

      <div class="ck-caption ck-muted" style="margin-top:4px">Open an existing session</div>
      <div class="ck-row dl-actions">
        <input
          class="ck-input"
          placeholder="session id"
          value=${sessionId}
          onInput=${(e) => setSessionId(e.target.value)}
        />
        <${LinkButton} href=${sessionUrl} icon="app-window" label="Open session" title="Open an existing session by its id" />
      </div>
    </div>
  `;
}

function NewDecision({ invoke }) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await invoke("add_decision", { title: t, note: note.trim() || undefined });
      setTitle("");
      setNote("");
    } finally {
      setBusy(false);
    }
  }

  return html`
    <div class="ck-card dl-add ck-col">
      <input
        class="ck-input"
        placeholder="New decision or open question…"
        value=${title}
        onInput=${(e) => setTitle(e.target.value)}
        onKeyDown=${(e) => { if (e.key === "Enter") add(); }}
      />
      <input
        class="ck-input"
        placeholder="Note / rationale (optional)"
        value=${note}
        onInput=${(e) => setNote(e.target.value)}
        onKeyDown=${(e) => { if (e.key === "Enter") add(); }}
      />
      <div class="ck-row">
        <button class="ck-btn ck-btn-primary" disabled=${!title.trim() || busy} onClick=${add}>
          <${Icon} name="plus" size=${16} />Add decision
        </button>
        <span class="ck-caption">Enter to add · agent and you share this log</span>
      </div>
    </div>
  `;
}

function DecisionItem({ d, repo, invoke }) {
  const others = ["open", "decided", "parked"].filter((s) => s !== d.status);
  const [handing, setHanding] = useState(false);
  // A github-app deep link that opens a NEW session in the project repo, seeded
  // with this decision. Built by the kit (validated + encoded) and rendered as a
  // target="_blank" anchor so the canvas webview routes it into the app's
  // deeplink pipeline. Null when no valid repo is set, so we hide the control.
  const sessionUrl = repo
    ? buildSessionDeepLink({ repo, prompt: sessionPromptFor(d), mode: "interactive" })
    : null;

  async function handToAgent() {
    if (handing) return;
    setHanding(true);
    try { await invoke("hand_to_agent", { id: d.id }); } finally { setHanding(false); }
  }

  return html`
    <div class="ck-card">
      <div class="ck-spread">
        <span class="dl-item-title">${d.title}</span>
        <${Badge} status=${d.status} />
      </div>
      ${d.note
        ? html`<div class="dl-item-note ck-muted">${d.note}</div>`
        : null}
      ${d.updatedAt
        ? html`<div class="ck-caption" style="margin-top:6px">
            updated ${relativeTime(d.updatedAt)}${d.handedToAgentAt ? " · handed to agent" : ""}
          </div>`
        : null}
      <div class="ck-row dl-actions" style="margin-top:10px">
        ${others.map(
          (s) => html`
            <button
              class="ck-btn ck-btn-sm"
              onClick=${() => invoke("set_status", { id: d.id, status: s })}
            >
              <${Icon} name=${STATUS_ICON[s]} size=${14} />Mark ${s}
            </button>
          `
        )}
        <button class="ck-btn ck-btn-sm" disabled=${handing} onClick=${handToAgent} title="Hand this decision to the main agent in THIS session">
          <${Icon} name=${handing ? "loader-circle" : "send"} size=${14} class=${handing ? "ck-spinner" : ""} />Hand to agent
        </button>
        ${sessionUrl
          ? html`<a
              class="ck-btn ck-btn-sm"
              href=${sessionUrl}
              target="_blank"
              rel="noopener noreferrer"
              title=${`Open a NEW github-app session in ${repo}`}
            >
              <${Icon} name="rocket" size=${14} />Open in session
            </a>`
          : null}
        <span class="ck-grow"></span>
        <button
          class="ck-btn ck-btn-sm ck-btn-danger"
          onClick=${() => invoke("remove_decision", { id: d.id })}
        >
          <${Icon} name="trash-2" size=${14} />Delete
        </button>
      </div>
    </div>
  `;
}

// Host-AI summary panel. The model call lives in the "summarize" handler
// (canvas.mjs) — this only TRIGGERS it and renders the derived state it writes
// back (state.summary / state.summaryError), exactly like any shared field.
function Summary({ state, invoke }) {
  const [busy, setBusy] = useState(false);
  const hasDecisions = (state.decisions ?? []).length > 0;

  async function run() {
    if (busy) return;
    setBusy(true);
    try { await invoke("summarize"); } finally { setBusy(false); }
  }

  return html`
    <div class="ck-card dl-summary ck-col">
      <div class="ck-spread">
        <div class="ck-row" style="gap:6px">
          <${Icon} name="sparkles" size=${16} />
          <span class="dl-item-title">AI summary</span>
        </div>
        <button
          class="ck-btn ck-btn-sm"
          disabled=${busy || !hasDecisions}
          onClick=${run}
          title=${hasDecisions ? "Summarize with the host model" : "Add a decision first"}
        >
          <${Icon} name=${busy ? "loader-circle" : "sparkles"} size=${14} class=${busy ? "ck-spinner" : ""} />
          ${busy ? "Summarizing…" : "Summarize"}
        </button>
      </div>
      ${state.summaryError
        ? html`<div class="ck-callout ck-error" style="margin-top:10px">
            <${Icon} name="circle-x" size=${16} /><span>${state.summaryError}</span>
          </div>`
        : state.summary
          ? html`<div style="margin-top:8px">
              <div style="white-space:pre-wrap">${state.summary}</div>
              ${state.summaryAt
                ? html`<div class="ck-caption" style="margin-top:6px">summarized ${relativeTime(state.summaryAt)}</div>`
                : null}
            </div>`
          : html`<div class="ck-muted" style="margin-top:8px">
              ${hasDecisions ? "Summarize the log into a one-line recommendation." : "No decisions to summarize yet."}
            </div>`}
    </div>
  `;
}

function App({ state, invoke, connected }) {
  const [filter, setFilter] = useState("all");
  if (!state) return html`<p class="ck-muted">Loading…</p>`;

  const decisions = state.decisions ?? [];
  const shown = filter === "all" ? decisions : decisions.filter((d) => d.status === filter);
  const openCount = decisions.filter((d) => d.status === "open").length;

  return html`
    <div>
      <div class="ck-spread dl-head">
        <div class="ck-row" style="gap:8px">
          <${Icon} name="list-todo" size=${20} />
          <h1 style="margin:0">Decision Log</h1>
        </div>
        <span class=${`ck-status`}>
          <span class=${`ck-dot ${connected ? "ck-dot-live" : "ck-dot-off"}`}></span>
          ${connected ? "live" : "reconnecting…"}
        </span>
      </div>

      <${NewDecision} invoke=${invoke} />

      <${AppIntegrations} state=${state} invoke=${invoke} />

      <${Summary} state=${state} invoke=${invoke} />

      ${state.agentError
        ? html`<div class="ck-callout ck-error" style="margin-bottom:10px">
            <${Icon} name="circle-x" size=${16} /><span>${state.agentError}</span>
          </div>`
        : null}

      <div class="ck-spread" style="margin-bottom:10px">
        <div class="ck-tabs" role="tablist">
          ${FILTERS.map(
            (f) => html`
              <button
                class="ck-tab"
                role="tab"
                aria-selected=${String(filter === f)}
                onClick=${() => setFilter(f)}
              >
                ${f}${f === "open" && openCount ? ` (${openCount})` : ""}
              </button>
            `
          )}
        </div>
        <span class="ck-caption">${decisions.length} total</span>
      </div>

      <div class="dl-list">
        ${shown.length
          ? shown.map((d) => html`<${DecisionItem} key=${d.id} d=${d} repo=${state.repo} invoke=${invoke} />`)
          : html`<div class="ck-empty">
              <${Icon} name="lightbulb" size=${20} />
              No ${filter === "all" ? "" : filter + " "}decisions yet.
            </div>`}
      </div>
    </div>
  `;
}

mountCanvas({ view: (model) => html`<${App} ...${model} />` });
