import { createServer } from "node:http";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

const servers = new Map();

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function renderHtml(instanceId, title) {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        padding: 2rem;
        background: var(--background-color-default, #fff);
        color: var(--text-color-default, #1f2328);
        font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        font-size: var(--text-body-medium, 14px);
        line-height: var(--leading-body-medium, 20px);
      }
      main { max-width: 42rem; margin: 0 auto; }
      .eyebrow { color: var(--text-color-muted, #656d76); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
      h1 { margin: .25rem 0 .75rem; font-size: 26px; line-height: 32px; }
      .card { padding: 1.25rem; border: 1px solid var(--border-color-default, #d0d7de); border-radius: 12px; background: var(--background-color-muted, #f6f8fa); }
      code { font-family: var(--font-mono, monospace); font-size: 12px; }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Canvas app</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="card">
        <p>This starter canvas is running locally and ready for your UI.</p>
        <p>Instance: <code>${escapeHtml(instanceId)}</code></p>
      </div>
    </main>
  </body>
</html>`;
}

async function startServer(instanceId, title) {
    const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderHtml(instanceId, title));
    });
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
            description: "A project-shared starter canvas with a local HTML renderer.",
            inputSchema: {
                type: "object",
                properties: { title: { type: "string", minLength: 1 } },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "get_status",
                    description: "Return the current canvas instance status",
                    handler: async (ctx) => ({ status: "ready", instanceId: ctx.instanceId }),
                },
            ],
            open: async (ctx) => {
                const title = ctx.input?.title ?? "Canvas app";
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId, title);
                    servers.set(ctx.instanceId, entry);
                }
                return { title, url: entry.url };
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
