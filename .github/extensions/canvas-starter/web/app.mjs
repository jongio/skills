// web/app.mjs — Preact view for the Canvas Starter canvas.
//
// SHARED state arrives over /events (SSE); the agent mutates the same data.
// LOCAL UI state (the draft input) lives in useState. Because Preact DIFFS the
// DOM (no innerHTML repaint), live pushes never clobber what you're typing.

import { html, mountCanvas, useState, Icon } from "/kit/client.mjs";

const TITLE = "Canvas Starter";

function NewItem({ invoke }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await invoke("add_item", { text: t });
      setText("");
    } finally {
      setBusy(false);
    }
  }

  return html`
    <div class="ck-card ck-row" style="margin:12px 0 16px">
      <input
        class="ck-input ck-grow"
        placeholder="Add an item…"
        value=${text}
        onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => { if (e.key === "Enter") add(); }}
      />
      <button class="ck-btn ck-btn-primary" disabled=${!text.trim() || busy} onClick=${add}>
        <${Icon} name="plus" size=${16} />Add
      </button>
    </div>
  `;
}

function Item({ item, invoke }) {
  return html`
    <div class="ck-card ck-spread">
      <button class="ck-btn ck-btn-sm" onClick=${() => invoke("toggle_item", { id: item.id })}>
        <${Icon} name=${item.done ? "circle-check" : "circle"} size=${16} />
        <span style=${item.done ? "text-decoration:line-through;opacity:.6" : ""}>${item.text}</span>
      </button>
      <button class="ck-btn ck-btn-sm ck-btn-danger" onClick=${() => invoke("remove_item", { id: item.id })}>
        <${Icon} name="trash-2" size=${14} />
      </button>
    </div>
  `;
}

function App({ state, invoke, connected }) {
  if (!state) return html`<p class="ck-muted">Loading…</p>`;
  const items = state.items ?? [];

  return html`
    <div>
      <div class="ck-spread" style="margin-bottom:14px">
        <div class="ck-row" style="gap:8px">
          <${Icon} name="layout-list" size=${20} />
          <h1 style="margin:0">${TITLE}</h1>
        </div>
        <span class="ck-status">
          <span class=${`ck-dot ${connected ? "ck-dot-live" : "ck-dot-off"}`}></span>
          ${connected ? "live" : "reconnecting…"}
        </span>
      </div>

      <${NewItem} invoke=${invoke} />

      <div class="ck-col" style="gap:10px">
        ${items.length
          ? items.map((item) => html`<${Item} key=${item.id} item=${item} invoke=${invoke} />`)
          : html`<div class="ck-empty"><${Icon} name="inbox" size=${20} />No items yet.</div>`}
      </div>
    </div>
  `;
}

mountCanvas({ view: (model) => html`<${App} ...${model} />` });
