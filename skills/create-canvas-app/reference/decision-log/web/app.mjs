// web/app.mjs — Preact view for the Decision Log canvas.
//
// Two kinds of state, deliberately separated:
//   * SHARED domain state (the decisions) arrives over /events (SSE) and is the
//     same data the agent mutates. mountCanvas re-renders on every push.
//   * LOCAL UI state (the new-decision draft + the active filter) lives in
//     Preact useState. Because Preact DIFFS the DOM instead of replacing
//     innerHTML, a live state push does NOT clobber the text you're typing or
//     move your caret — the core fix over the hand-rolled innerHTML canvases.

import { html, mountCanvas, useState, Icon, relativeTime } from "/kit/client.mjs";

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

function DecisionItem({ d, invoke }) {
  const others = ["open", "decided", "parked"].filter((s) => s !== d.status);
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
        ? html`<div class="ck-caption" style="margin-top:6px">updated ${relativeTime(d.updatedAt)}</div>`
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
          ? shown.map((d) => html`<${DecisionItem} key=${d.id} d=${d} invoke=${invoke} />`)
          : html`<div class="ck-empty">
              <${Icon} name="lightbulb" size=${20} />
              No ${filter === "all" ? "" : filter + " "}decisions yet.
            </div>`}
      </div>
    </div>
  `;
}

mountCanvas({ view: (model) => html`<${App} ...${model} />` });
