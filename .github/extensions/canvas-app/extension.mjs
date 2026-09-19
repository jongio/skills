// Extension: canvas-app
// A starter interactive canvas application
//
// This single-file skeleton is a starting point. For more complex canvases
// (multiple actions with non-trivial logic, shared state, a custom renderer,
// etc.) prefer splitting things out: move each action handler into its own
// function, extract `open`/`onClose` into helpers, and pull large units
// (renderer assets, schema definitions, shared utilities) into sibling files
// imported from this entry point. Keep extension.mjs focused on wiring.

import { createServer } from "node:http";
import { CanvasError, joinSession, createCanvas } from "@github/copilot-sdk/extension";

// One local HTTP server per open canvas instance. Each instance gets its own
// ephemeral port so multiple canvases (or multiple opens of the same canvas)
// don't collide. Replace this with your real renderer — point a static-file
// server, a Vite/Next dev server, or any framework you like at the same URL.
const instances = new Map();

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function renderHtml(instanceId, count) {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Canvas app</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        color: var(--text-color-default, #1f2328);
        background: var(--background-color-default, #ffffff);
      }
      body { margin: 0; padding: 2rem; }
      main { max-width: 32rem; margin: 0 auto; }
      h1 { margin: 0 0 .5rem; font-size: 1.5rem; }
      p { color: var(--text-color-muted, #656d76); }
      .card {
        border: 1px solid var(--border-color-default, #d0d7de);
        border-radius: .75rem;
        padding: 1.25rem;
        margin-top: 1.5rem;
      }
      .count { font-size: 3rem; font-weight: 600; margin: 1rem 0; }
      button {
        border: 1px solid var(--border-color-default, #d0d7de);
        border-radius: .4rem;
        padding: .5rem .8rem;
        color: inherit;
        background: var(--button-default-bg-color, transparent);
        cursor: pointer;
      }
      button:hover { background: var(--button-default-hover-bg-color, #f3f4f6); }
      button:focus-visible { outline: 2px solid var(--color-focus-outline, #0969da); outline-offset: 2px; }
      .instance { font-size: .8rem; word-break: break-all; }
    </style>
  </head>
  <body>
    <main>
      <h1>Canvas app</h1>
      <p>A minimal interactive canvas starter.</p>
      <section class="card" aria-labelledby="counter-title">
        <h2 id="counter-title">Shared counter</h2>
        <div class="count" aria-live="polite">${count}</div>
        <button type="button" onclick="update('/increment')">Increment</button>
        <button type="button" onclick="update('/reset')">Reset</button>
        <p class="instance">Instance: <code>${escapeHtml(instanceId)}</code></p>
      </section>
    </main>
    <script>
      async function update(path) {
        const response = await fetch(path, { method: "POST" });
        if (!response.ok) {
          document.body.dataset.error = "true";
          return;
        }
        window.location.reload();
      }
    </script>
  </body>
</html>`;
}

async function startServer(instanceId) {
    const server = createServer((req, res) => {
        const state = instances.get(instanceId);
        if (!state) {
            res.writeHead(404);
            res.end("Canvas instance not found");
            return;
        }
        if (req.method === "POST" && req.url === "/increment") {
            state.count += 1;
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method === "POST" && req.url === "/reset") {
            state.count = 0;
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(renderHtml(instanceId, state.count));
            return;
        }
        res.writeHead(404);
        res.end("Not found");
    });
    // Port 0 = let the OS pick a free ephemeral port. Bind to loopback only.
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

await joinSession({
    canvases: [
        createCanvas({
            id: "canvas-app",
            displayName: "Canvas app",
            description: "A minimal interactive counter canvas starter.",
            actions: [
                {
                    name: "increment",
                    description: "Increment the counter shown in the canvas.",
                    handler: async (ctx) => {
                        const state = instances.get(ctx.instanceId);
                        if (!state) {
                            throw new CanvasError("canvas_instance_not_open", "Canvas instance is not open");
                        }
                        state.count += 1;
                        return { count: state.count };
                    },
                },
                {
                    name: "reset",
                    description: "Reset the canvas counter to zero.",
                    handler: async (ctx) => {
                        const state = instances.get(ctx.instanceId);
                        if (!state) {
                            throw new CanvasError("canvas_instance_not_open", "Canvas instance is not open");
                        }
                        state.count = 0;
                        return { count: state.count };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = instances.get(ctx.instanceId);
                if (!entry) {
                    entry = { count: 0 };
                    instances.set(ctx.instanceId, entry);
                    entry = await startServer(ctx.instanceId);
                    instances.get(ctx.instanceId).server = entry.server;
                    instances.get(ctx.instanceId).url = entry.url;
                }
                return {
                    title: "Canvas app",
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = instances.get(ctx.instanceId);
                if (entry) {
                    instances.delete(ctx.instanceId);
                    if (entry.server) {
                        await new Promise((resolve) => entry.server.close(() => resolve()));
                    }
                }
            },
        }),
    ],
});
