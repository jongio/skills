// Extension: canvas-demo
// A small interactive counter canvas for this repository.

import { createServer } from "node:http";
import { createCanvas, joinSession, CanvasError } from "@github/copilot-sdk/extension";

// The counter is intentionally per-panel state for this demo.
const servers = new Map();

function renderHtml(instanceId) {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Canvas demo</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: var(--font-sans, system-ui, sans-serif);
        color: var(--text-color-default, #1f2328);
        background: var(--background-color-default, #fff);
      }
      body { margin: 0; padding: 1.5rem; }
      main { max-width: 32rem; margin: auto; }
      .card {
        border: 1px solid var(--border-color-default, #d0d7de);
        border-radius: 0.75rem;
        padding: 1.25rem;
      }
      .count { font-size: 3rem; font-weight: 600; margin: 1rem 0; }
      button {
        border: 1px solid var(--border-color-default, #d0d7de);
        border-radius: 0.4rem;
        padding: 0.5rem 0.75rem;
        color: inherit;
        background: var(--background-color-default, #fff);
        cursor: pointer;
      }
      button:focus-visible { outline: 2px solid var(--color-focus-outline, #0969da); }
      .muted { color: var(--text-color-muted, #656d76); font-size: 0.875rem; }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <h1>Canvas demo</h1>
        <p class="muted">A minimal interactive canvas with agent-callable actions.</p>
        <div id="count" class="count" aria-live="polite">0</div>
        <button id="increment" type="button">Increment</button>
        <button id="reset" type="button">Reset</button>
        <p class="muted">Instance: <code>${instanceId}</code></p>
      </div>
    </main>
    <script>
      async function refresh() {
        const response = await fetch("/state");
        if (!response.ok) throw new Error("Unable to load canvas state");
        const state = await response.json();
        document.getElementById("count").textContent = state.count;
      }
      async function update(path) {
        const response = await fetch(path, { method: "POST" });
        if (!response.ok) throw new Error("Unable to update canvas state");
        await refresh();
      }
      document.getElementById("increment").addEventListener("click", () => update("/increment"));
      document.getElementById("reset").addEventListener("click", () => update("/reset"));
      refresh().catch((error) => {
        document.getElementById("count").textContent = error.message;
      });
    </script>
  </body>
</html>`;
}

async function startServer(instanceId) {
    const state = { count: 0 };
    const server = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.end(renderHtml(instanceId));
            return;
        }
        if (req.method === "GET" && req.url === "/state") {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify(state));
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
        res.writeHead(404);
        res.end("Not found");
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, state, url: `http://127.0.0.1:${port}/` };
}

function getInstance(ctx) {
    const entry = servers.get(ctx.instanceId);
    if (!entry) {
        throw new CanvasError("canvas_instance_not_open", "Canvas instance is not open");
    }
    return entry;
}

await joinSession({
    canvases: [
        createCanvas({
            id: "canvas-demo",
            displayName: "Canvas demo",
            description: "An interactive counter canvas with increment and reset controls.",
            actions: [
                {
                    name: "increment",
                    description: "Increment the counter shown in the canvas.",
                    handler: async (ctx) => {
                        const entry = getInstance(ctx);
                        entry.state.count += 1;
                        return { count: entry.state.count };
                    },
                },
                {
                    name: "reset",
                    description: "Reset the counter shown in the canvas to zero.",
                    handler: async (ctx) => {
                        const entry = getInstance(ctx);
                        entry.state.count = 0;
                        return { count: entry.state.count };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Canvas demo", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
