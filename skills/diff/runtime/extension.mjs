// extension.mjs - the ONLY file in skills/diff that imports @github/copilot-sdk.
//
// Adapts the Copilot SDK canvas lifecycle (open / action.invoke / close) onto
// the SDK-free kit runtime in canvas-kit/server.mjs. All diff loading, durable
// state, and action handlers live in canvas.mjs and diff-loader.mjs.

import { createCanvas, joinSession, CanvasError } from "@github/copilot-sdk/extension";
import { canvasConfig, openDiffInstance } from "./canvas.mjs";
import { createCanvasRuntime, CanvasKitError } from "./canvas-kit/server.mjs";

const runtime = createCanvasRuntime(canvasConfig);
canvasConfig._attachRuntime(runtime);
let session = null;
let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

function toCanvasError(err) {
  if (err instanceof CanvasError) return err;
  if (err instanceof CanvasKitError) return new CanvasError(err.code, err.message);
  return new CanvasError("action_failed", String(err?.message ?? err));
}

export function checkSession(ctx, activeSession) {
  if (
    ctx?.sessionId &&
    activeSession?.sessionId &&
    ctx.sessionId !== activeSession.sessionId
  ) {
    throw new CanvasError("wrong_session", "Cross-session canvas rejected");
  }
}

export function resolveSessionWorkingDirectory(ctx) {
  // In @github/copilot-sdk, ctx.session.workingDirectory is the active Git
  // checkout directory, whereas CopilotSession.workspacePath points to
  // $COPILOT_HOME/session-state/<sessionId>. Never fall back to session.workspacePath.
  return String(
    ctx?.session?.workingDirectory ??
      ctx?.workingDirectory ??
      ctx?.workspacePath ??
      "",
  );
}

const canvas = createCanvas({
  id: canvasConfig.id,
  displayName: canvasConfig.displayName,
  description: canvasConfig.description,
  inputSchema: canvasConfig.inputSchema,

  actions: Object.entries(canvasConfig.actions).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: def.inputSchema,
    handler: async (ctx) => {
      try {
        await ready;
        checkSession(ctx, session);
        return await runtime.invokeFromAgent(ctx.actionName ?? name, ctx.input, {
          ...ctx,
          workspacePath: resolveSessionWorkingDirectory(ctx),
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
      return await openDiffInstance(runtime, canvasConfig, {
        ...ctx,
        workspacePath: resolveSessionWorkingDirectory(ctx),
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

let shuttingDown = false;
export async function shutdownDiffExtension({
  runtimeInstance = runtime,
  activeSession = session,
} = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await runtimeInstance?.shutdown?.();
  } catch {
    // Ignore shutdown errors during process teardown
  }
  try {
    await activeSession?.disconnect?.();
  } catch {
    // Ignore RPC disconnect errors during process teardown
  }
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, () => {
    void shutdownDiffExtension({
      runtimeInstance: runtime,
      activeSession: session,
    }).finally(() => process.exit(0));
  });
}

try {
  session = await joinSession({ canvases: [canvas] });
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
  throw err;
}

