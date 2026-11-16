// extension.mjs - the ONLY file in skills/diff that imports @github/copilot-sdk.
//
// Adapts the Copilot App canvas lifecycle onto the SDK-free runtime in
// `canvas.mjs` + `canvas-kit/server.mjs`, guarded by an OS-owned per-session
// lease (`provider.mjs`) so duplicate plugin/user loaders never collide.

import { createCanvas, joinSession, CanvasError } from "@github/copilot-sdk/extension";
import { createDiffCanvasConfig, createDiffCanvasRuntime } from "./canvas.mjs";
import { CanvasKitError } from "./canvas-kit/server.mjs";
import { acquireProviderLease, checkSession } from "./provider.mjs";

function toCanvasError(err) {
  if (err instanceof CanvasError) return err;
  if (err instanceof CanvasKitError) return new CanvasError(err.code, err.message);
  if (typeof err?.code === "string") return new CanvasError(err.code, String(err.message ?? err));
  return new CanvasError("action_failed", String(err?.message ?? err));
}

const sessionId = process.env.SESSION_ID || "";
const lease = sessionId ? await acquireProviderLease(sessionId) : { acquired: false, async release() {} };

if (lease.acquired) {
  let runtime;
  let session;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const staticConfig = createDiffCanvasConfig();

  const canvas = createCanvas({
    id: staticConfig.id,
    displayName: staticConfig.displayName,
    description: staticConfig.description,
    inputSchema: staticConfig.inputSchema,

    actions: Object.entries(staticConfig.actions).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: def.inputSchema,
      handler: async (ctx) => {
        try {
          await ready;
          checkSession(ctx, session);
          return await runtime.invokeFromAgent(name, ctx.input, {
            ...ctx,
            workspacePath: session.workspacePath || "",
          });
        } catch (err) {
          throw toCanvasError(err);
        }
      },
    })),

    open: async (ctx) => {
      try {
        await ready;
        checkSession(ctx, session);
        return await runtime.openInstance({
          instanceId: ctx.instanceId,
          input: ctx.input,
          ctx: {
            ...ctx,
            workspacePath: session.workspacePath || "",
          },
        });
      } catch (err) {
        throw toCanvasError(err);
      }
    },

    onClose: async (ctx) => {
      try {
        await ready;
        checkSession(ctx, session);
        await runtime.closeInstance(ctx.instanceId);
      } catch (err) {
        throw toCanvasError(err);
      }
    },
  });

  try {
    session = await joinSession({ canvases: [canvas] });
    runtime = createDiffCanvasRuntime({
      defaultCwd: session.workspacePath || "",
    });
    runtime.setHost({
      ai: async (question) => {
        const { answer } = await session.rpc.ui.ephemeralQuery({ question: String(question) });
        return answer ?? "";
      },
      askAgent: async (prompt) => session.send({ prompt: String(prompt) }),
    });
    resolveReady();
  } catch (err) {
    rejectReady(err);
    await lease.release();
    throw err;
  }

  let shuttingDown = false;
  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime?.shutdown?.().catch(() => {});
    await lease.release().catch(() => {});
  };

  process.once("SIGINT", () => { void cleanup(); });
  process.once("SIGTERM", () => { void cleanup(); });
  process.once("beforeExit", () => { void cleanup(); });
}
