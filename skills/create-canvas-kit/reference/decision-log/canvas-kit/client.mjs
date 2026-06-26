// canvas-kit/client.mjs
//
// Browser-side runtime loaded by the canvas document at /kit/client.mjs.
// Re-exports the vendored Preact + htm bundle (no CDN, no build step) and adds
// `mountCanvas`, which wires the loopback transport (GET /state, GET /events
// SSE, POST /action) to a Preact render loop.
//
// Why Preact (vs the hand-rolled innerHTML repaint the existing canvases use):
// the vendored bundle diffs the DOM, so live state pushes from /events DO NOT
// clobber focus, caret position, or in-progress text in uncontrolled inputs.
// That is the single biggest correctness win for interactive canvases.

export * from "./vendor/preact-htm-standalone.mjs";
import { html, render } from "./vendor/preact-htm-standalone.mjs";

export { html };

// Lucide icons — the same set github-app uses. `Icon` is the Preact default;
// `lucideSVG` is the string helper for vanilla canvases.
export { Icon, lucideSVG, hasIcon, iconNames } from "./icons.mjs";

/**
 * Mount a canvas view and keep it live.
 * @param {object} opts
 * @param {(model:{state:any, invoke:Function, connected:boolean})=>any} opts.view
 *        Returns an htm/Preact vnode. Re-invoked on every state push.
 * @param {HTMLElement} [opts.mount]   defaults to #app or <body>
 * @param {(state:any)=>void} [opts.onState]
 * @returns {{invoke:Function, refresh:Function, get state():any}}
 */
export function mountCanvas({ view, mount, onState } = {}) {
  const root = mount || document.getElementById("app") || document.body;
  // Preact's render() diffs against — but does not clear — pre-existing DOM in
  // the container, so a static no-JS placeholder (e.g. <p>Loading…</p> in the
  // HTML shell) would linger as a sibling. Clear it once so Preact owns an empty
  // root; the view's own loading branch covers the gap until first state.
  root.replaceChildren();
  let state = null;
  let connected = false;

  async function invoke(actionName, input) {
    const res = await fetch("./action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionName, input: input ?? {} }),
    });
    const data = await res.json().catch(() => ({ ok: false }));
    if (!data.ok) {
      throw new CanvasActionError(data.code || "error", data.message || "action failed");
    }
    return data.result;
  }

  function rerender() {
    render(view({ state, invoke, connected }), root);
  }

  async function refresh() {
    try {
      state = await (await fetch("./state")).json();
      onState?.(state);
      rerender();
    } catch { /* offline; SSE will recover */ }
  }

  function connect() {
    const es = new EventSource("./events");
    es.onmessage = (e) => {
      try {
        state = JSON.parse(e.data);
        connected = true;
        onState?.(state);
        rerender();
      } catch { /* ignore malformed frame */ }
    };
    es.onopen = () => { connected = true; rerender(); };
    es.onerror = () => { connected = false; rerender(); /* EventSource auto-reconnects */ };
  }

  refresh();
  connect();

  return {
    invoke,
    refresh,
    get state() { return state; },
  };
}

export class CanvasActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CanvasActionError";
    this.code = code;
  }
}
