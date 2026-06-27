// canvas-kit/server.mjs
//
// SDK-free canvas runtime. Owns the per-instance loopback HTTP servers, the
// domain-keyed shared state, durable persistence, and SSE fan-out. It does NOT
// import the Copilot SDK so it can be booted directly from a Node test harness
// or Playwright. `extension.mjs` is the only file that talks to the SDK and it
// drives this runtime through `openInstance` / `invokeFromAgent` / `closeInstance`.
//
// Design notes (grounded in github-app create-canvas/SKILL.md + ADR 0015):
//   * The app renders the returned loopback URL in an isolated native webview
//     (no IPC bridge), so the document is same-origin to its own server and we
//     need no CORS. We still bind 127.0.0.1 only.
//   * Durable state is keyed by a *domain id* derived from the open input — NOT
//     by instanceId — so multiple panels of the same logical thing stay in sync
//     and survive panel close/reopen.
//   * Action handlers are shared: the same handler map backs both agent-invoked
//     actions and UI POST /action calls. One source of truth.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const KIT_DIR = fileURLToPath(new URL(".", import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export class CanvasKitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CanvasKitError";
    this.code = code;
  }
}

/**
 * @param {object} config
 * @param {string} config.id
 * @param {string} config.displayName
 * @param {string} config.description
 * @param {object} [config.inputSchema]
 * @param {(input:object, ctx:object)=>string} [config.resolveDomainId]
 * @param {(ctx:object)=>any|Promise<any>} [config.createInitialState]
 * @param {(domainId:string)=>any|Promise<any>} [config.loadState]
 * @param {(domainId:string, state:any)=>void|Promise<void>} [config.saveState]
 * @param {Record<string,{description?:string,inputSchema?:object,handler:Function}>} config.actions
 * @param {string} config.assetsDir  absolute path to the canvas web/ folder
 * @param {(ctx:object,state:any)=>string} [config.statusLine]
 */
export function createCanvasRuntime(config) {
  if (!config?.assetsDir) throw new Error("createCanvasRuntime: assetsDir is required");
  if (!config?.actions) throw new Error("createCanvasRuntime: actions is required");

  const ASSETS_DIR = normalize(config.assetsDir);
  const domains = new Map(); // domainId -> { state }
  const loading = new Map(); // domainId -> Promise<{ state }>  (in-flight cold loads)
  const instances = new Map(); // instanceId -> { server, url, domainId, clients:Set<res> }

  async function getDomain(domainId, ctx) {
    const existing = domains.get(domainId);
    if (existing) return existing;
    // Memoize the in-flight cold load so concurrent first-touches of the same
    // domain share ONE record. Without this, each caller would await loadState
    // independently and publish its own { state } (last writer wins the map),
    // letting an in-flight invoke() mutate+persist an orphaned copy while the
    // map and SSE fan-out show a different winner — silent persisted-vs-shown
    // divergence of the durable shared state this kit promises to keep in sync.
    let pending = loading.get(domainId);
    if (!pending) {
      pending = (async () => {
        let state;
        if (config.loadState) state = await config.loadState(domainId);
        if (state == null) {
          state = config.createInitialState ? await config.createInitialState(ctx) : {};
        }
        const d = { state };
        domains.set(domainId, d);
        return d;
      })().finally(() => loading.delete(domainId));
      loading.set(domainId, pending);
    }
    return pending;
  }

  function broadcast(domainId) {
    const d = domains.get(domainId);
    if (!d) return;
    const payload = `data: ${JSON.stringify(d.state)}\n\n`;
    for (const inst of instances.values()) {
      if (inst.domainId !== domainId) continue;
      for (const res of inst.clients) {
        try { res.write(payload); } catch { /* dropped client */ }
      }
    }
  }

  // Core action invoker — the single code path behind both agent and UI actions.
  async function invoke(actionName, input, ctx) {
    const action = config.actions[actionName];
    if (!action || typeof action.handler !== "function") {
      throw new CanvasKitError("unknown_action", `Unknown action: ${actionName}`);
    }
    const domainId = ctx?.domainId ?? "default";
    const d = await getDomain(domainId, ctx);
    let mutated = false;
    const api = {
      get state() { return d.state; },
      set(next) {
        d.state = typeof next === "function" ? next(d.state) : next;
        mutated = true;
      },
      input: input ?? {},
      ctx: ctx ?? {},
    };
    const result = await action.handler(api);
    if (mutated) {
      if (config.saveState) await config.saveState(domainId, d.state);
      broadcast(domainId);
    }
    return result === undefined ? { ok: true } : result;
  }

  // Resolve the domain for an agent-side call from the SDK context (which carries
  // instanceId + input). Prefer an already-open instance's domain; else derive.
  function domainFor(input, ctx) {
    const inst = ctx?.instanceId ? instances.get(ctx.instanceId) : null;
    if (inst) return inst.domainId;
    return config.resolveDomainId ? config.resolveDomainId(input ?? {}, ctx ?? {}) || "default" : "default";
  }

  async function invokeFromAgent(actionName, input, sdkCtx) {
    const domainId = domainFor(input, sdkCtx);
    return invoke(actionName, input, { ...sdkCtx, domainId });
  }

  // ---- static file serving (path-traversal safe, Windows-safe) -------------
  async function serveFile(res, baseDir, relPath) {
    const base = normalize(baseDir).replace(/[\\/]+$/, "");
    const clean = normalize(relPath).replace(/^([/\\])+/, "");
    const abs = normalize(join(base, clean));
    if (abs !== base && !abs.startsWith(base + sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(abs);
      res.writeHead(200, { "Content-Type": MIME[extname(abs)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  }

  // POST /action bodies are tiny JSON envelopes; cap buffering so a hostile
  // local client can't force unbounded memory growth on the loopback runtime.
  const MAX_BODY_BYTES = 1 << 20; // 1 MiB

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let aborted = false;
      req.on("data", (c) => {
        if (aborted) return;
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          aborted = true;
          reject(new CanvasKitError("payload_too_large", "Request body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => { if (!aborted) resolve(Buffer.concat(chunks).toString("utf8")); });
      req.on("error", (e) => { if (!aborted) reject(e); });
    });
  }

  function makeRequestHandler(instanceId) {
    return async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname;
      const inst = instances.get(instanceId);
      const domainId = inst?.domainId ?? "default";

      // GET /state — current snapshot
      if (req.method === "GET" && path === "/state") {
        const d = await getDomain(domainId);
        res.writeHead(200, { "Content-Type": MIME[".json"] });
        res.end(JSON.stringify(d.state));
        return;
      }

      // GET /events — Server-Sent Events stream of state
      if (req.method === "GET" && path === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("retry: 1000\n\n");
        const d = await getDomain(domainId);
        res.write(`data: ${JSON.stringify(d.state)}\n\n`);
        if (inst) inst.clients.add(res);
        const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
        req.on("close", () => { clearInterval(ping); if (inst) inst.clients.delete(res); });
        return;
      }

      // POST /action — UI-invoked action (same handlers as agent)
      if (req.method === "POST" && path === "/action") {
        try {
          const { actionName, input } = JSON.parse(await readBody(req) || "{}");
          const result = await invoke(actionName, input, { instanceId, domainId, source: "ui" });
          res.writeHead(200, { "Content-Type": MIME[".json"] });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (e) {
          // The body-too-large guard destroys the socket, so only respond when
          // the connection is still writable (the unknown-action / handler-throw
          // paths reach here with a live socket).
          if (!res.headersSent && !res.destroyed) {
            res.writeHead(e instanceof CanvasKitError ? 400 : 500, { "Content-Type": MIME[".json"] });
            res.end(JSON.stringify({ ok: false, code: e?.code ?? "error", message: String(e?.message ?? e) }));
          }
        }
        return;
      }

      // GET /favicon.ico — avoid a noisy 404 in the canvas console
      if (req.method === "GET" && path === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }

      // GET /kit/* — kit client runtime, theme, vendored preact/htm
      if (req.method === "GET" && path.startsWith("/kit/")) {
        await serveFile(res, KIT_DIR, path.slice("/kit/".length));
        return;
      }

      // GET / and everything else — canvas web assets
      if (req.method === "GET") {
        const rel = path === "/" ? "index.html" : path;
        await serveFile(res, ASSETS_DIR, rel);
        return;
      }

      res.writeHead(405).end("method not allowed");
    };
  }

  function listen(server) {
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
  }

  /**
   * Open (or focus) a canvas instance. Idempotent per instanceId.
   * @returns {Promise<{url:string,title:string,status?:string}>}
   */
  async function openInstance({ instanceId, input, ctx }) {
    const domainId = config.resolveDomainId
      ? config.resolveDomainId(input ?? {}, ctx ?? {}) || "default"
      : "default";
    await getDomain(domainId, ctx); // warm + load durable state

    let inst = instances.get(instanceId);
    if (inst) {
      inst.domainId = domainId; // re-target if reopened with new input
    } else {
      const server = createServer();
      inst = { server, url: "", domainId, clients: new Set() };
      instances.set(instanceId, inst);
      server.on("request", makeRequestHandler(instanceId));
      const port = await listen(server);
      inst.url = `http://127.0.0.1:${port}/`;
    }

    const d = await getDomain(domainId, ctx);
    return {
      url: inst.url,
      title: config.displayName,
      status: config.statusLine ? config.statusLine(ctx ?? {}, d.state) : undefined,
    };
  }

  async function closeInstance(instanceId) {
    const inst = instances.get(instanceId);
    if (!inst) return;
    for (const res of inst.clients) { try { res.end(); } catch {} }
    await new Promise((r) => inst.server.close(() => r()));
    instances.delete(instanceId);
  }

  async function shutdown() {
    await Promise.all([...instances.keys()].map(closeInstance));
  }

  async function getState(domainId = "default") {
    return (await getDomain(domainId)).state;
  }

  return {
    config,
    openInstance,
    closeInstance,
    shutdown,
    invoke, // direct (tests)
    invokeFromAgent, // agent-side, resolves domain from ctx
    getState,
    _instances: instances,
  };
}
