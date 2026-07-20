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

// Formatting + id helpers (also importable directly from /kit/format.mjs in
// SDK-free canvas.mjs). Re-exported here so views have one import site.
export { nid, relativeTime, compactNumber, percent } from "./format.mjs";

// Deep links INTO github-app — build a validated `ghapp://` URL (open a session,
// jump to a surface) and render it as a `target="_blank"` anchor; the canvas
// webview routes it into the app's deeplink pipeline. Also importable directly
// from /kit/deeplinks.mjs in SDK-free canvas.mjs. See deeplinks.mjs for the
// contract and the SKILL "Deep links" section for usage.
export {
  APP_DEEP_LINK_SCHEME,
  isRepoFullName,
  safeDeepLinkUrl,
  quoteUntrusted,
  hostedLauncherUrl,
  buildSessionDeepLink,
  buildSessionDetailDeepLink,
  buildChatsDeepLink,
  buildNewChatDeepLink,
  buildNewAutomationDeepLink,
  buildIssueDeepLink,
  buildPullRequestDeepLink,
} from "./deeplinks.mjs";

// Kit version stamp — lets a canvas (or the sync/freshness tooling) report which
// kit snapshot it was built from.
export { KIT_VERSION } from "./version.mjs";

/**
 * Run `tick` on an interval, but only while the panel is visible — so a
 * backgrounded canvas stops polling a (possibly rate-limited) upstream. Returns
 * a cleanup function, which makes it a drop-in `useEffect` return value:
 *
 *   useEffect(
 *     () => pollWhileVisible(() => invoke("refresh"), state.autoRefreshSec),
 *     [state.autoRefreshSec]
 *   );
 *
 * This is the single primitive behind every data canvas's auto-refresh; it
 * replaces the hand-rolled `setInterval` + `document.visibilityState` checks.
 * @param {()=>any} tick                 called each interval (promise rejections are swallowed)
 * @param {number} seconds               interval in seconds; <=0 disables (returns a no-op cleanup)
 * @param {object} [opts]
 * @param {boolean} [opts.whenVisible=true]  skip ticks while the panel is hidden
 * @param {boolean} [opts.immediate=false]   fire one tick immediately
 * @returns {()=>void} cleanup
 */
export function pollWhileVisible(tick, seconds, { whenVisible = true, immediate = false } = {}) {
  if (!seconds || seconds <= 0) return () => {};
  let inFlight = false;
  const run = async () => {
    if (inFlight) return; // don't stack ticks if a slow one is still running
    if (whenVisible && typeof document !== "undefined" && document.visibilityState !== "visible") return;
    inFlight = true;
    try {
      await tick();
    } catch { /* keep the interval alive */ }
    finally {
      inFlight = false;
    }
  };
  if (immediate) run();
  const id = setInterval(run, seconds * 1000);
  return () => clearInterval(id);
}

/**
 * DOM-FREE transport for a canvas: owns the loopback wiring (GET /state, GET
 * /events SSE, POST /action) and the derived `state`/`connected`, with no Preact
 * and no DOM. `mountCanvas` composes this with a render loop; keeping it separate
 * makes the reconnect/invoke glue unit-testable without a browser (see
 * test/client.test.mjs). Both callbacks receive the latest `(state, connected)`.
 * @param {object} [opts]
 * @param {(state:any, connected:boolean)=>void} [opts.onState]      fired on the initial /state and every SSE push
 * @param {(connected:boolean)=>void} [opts.onConnected]             fired when the SSE stream opens/errors
 * @param {typeof EventSource} [opts.EventSourceImpl]                override the SSE impl (tests); defaults to the global
 * @returns {{invoke:Function, refresh:Function, get state():any, get connected():boolean}}
 */
export function connectCanvas({ onState, onConnected, EventSourceImpl } = {}) {
  let state = null;
  let connected = false;
  const ES = EventSourceImpl || (typeof EventSource !== "undefined" ? EventSource : null);

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

  async function refresh() {
    try {
      state = await (await fetch("./state")).json();
      onState?.(state, connected);
    } catch { /* offline; SSE will recover */ }
  }

  function connect() {
    if (!ES) return; // no EventSource (e.g. a non-browser host); refresh() still works
    const es = new ES("./events");
    es.onmessage = (e) => {
      let next;
      try {
        next = JSON.parse(e.data);
      } catch {
        return; // ignore a malformed SSE frame; the next push recovers
      }
      // Update OUTSIDE the try so a bug in onState surfaces as a real error
      // instead of being silently mislabeled a "malformed frame".
      state = next;
      connected = true;
      onState?.(state, connected);
    };
    es.onopen = () => { connected = true; onConnected?.(connected); };
    es.onerror = () => { connected = false; onConnected?.(connected); /* EventSource auto-reconnects */ };
  }

  refresh();
  connect();

  return {
    invoke,
    refresh,
    get state() { return state; },
    get connected() { return connected; },
  };
}

/**
 * Mount a canvas view and keep it live.
 * @param {object} opts
 * @param {(model:{state:any, invoke:Function, connected:boolean})=>any} opts.view
 *        Returns an htm/Preact vnode. Re-invoked on every state push.
 * @param {HTMLElement} [opts.mount]   defaults to #app or <body>
 * @param {(state:any)=>void} [opts.onState]
 * @param {PollOptions} [opts.poll]   built-in fixed-interval visibility-gated auto-refresh.
 *        For an interval bound to live state, use `pollWhileVisible` in a useEffect instead.
 * @returns {{invoke:Function, refresh:Function, stopPoll:Function, get state():any}}
 */
export function mountCanvas({ view, mount, onState, poll } = {}) {
  const root = mount || document.getElementById("app") || document.body;
  // Preact's render() diffs against — but does not clear — pre-existing DOM in
  // the container, so a static no-JS placeholder (e.g. <p>Loading…</p> in the
  // HTML shell) would linger as a sibling. Clear it once so Preact owns an empty
  // root; the view's own loading branch covers the gap until first state.
  root.replaceChildren();

  let latestState = null;
  let latestConnected = false;
  let client;

  function rerender() {
    render(view({ state: latestState, invoke: client.invoke, connected: latestConnected }), root);
  }

  // The transport is DOM-free (connectCanvas); this wrapper only adds the Preact
  // render on each state/connection change.
  client = connectCanvas({
    onState: (state, connected) => {
      latestState = state;
      latestConnected = connected;
      onState?.(state);
      rerender();
    },
    onConnected: (connected) => {
      latestConnected = connected;
      rerender();
    },
  });

  // Built-in fixed-interval auto-refresh, delegating to the shared
  // visibility-gated primitive. Pass `poll: { action, seconds, immediate }`.
  //
  // @typedef {object} PollOptions
  // @property {string} [action]        action to invoke each tick; omit to call refresh()
  // @property {number} seconds         interval in seconds; <=0 disables polling
  // @property {object} [input]         input passed to the action
  // @property {boolean} [whenVisible=true]  skip ticks while the panel is hidden
  // @property {boolean} [immediate=false]   fire one tick right after mount
  function startPoll({ action, seconds, input, whenVisible = true, immediate = false } = {}) {
    return pollWhileVisible(
      () => (action ? client.invoke(action, input) : client.refresh()),
      seconds,
      { whenVisible, immediate }
    );
  }

  let stopPoll = () => {};
  if (poll) stopPoll = startPoll(poll);

  return {
    invoke: client.invoke,
    refresh: client.refresh,
    stopPoll: () => stopPoll(),
    get state() { return latestState; },
  };
}

export class CanvasActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CanvasActionError";
    this.code = code;
  }
}
