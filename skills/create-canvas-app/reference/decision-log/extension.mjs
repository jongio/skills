// extension.mjs — the ONLY file that talks to the Copilot SDK.
//
// It is deliberately thin: it adapts the SDK's canvas lifecycle
// (open / action.invoke / close) onto the SDK-free kit runtime in
// canvas-kit/server.mjs. All real behavior lives in canvas.mjs (config +
// handlers) and the kit. This separation is what lets the runtime be booted
// and tested standalone without the CLI parent process.

import { createCanvas, joinSession, CanvasError } from "@github/copilot-sdk/extension";
import { canvasConfig } from "./canvas.mjs";
import { createCanvasRuntime, CanvasKitError } from "./canvas-kit/server.mjs";

const runtime = createCanvasRuntime(canvasConfig);

function toCanvasError(err) {
  if (err instanceof CanvasError) return err;
  if (err instanceof CanvasKitError) return new CanvasError(err.code, err.message);
  return new CanvasError("action_failed", String(err?.message ?? err));
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
        return await runtime.invokeFromAgent(ctx.actionName, ctx.input, ctx);
      } catch (err) {
        throw toCanvasError(err);
      }
    },
  })),

  open: async (ctx) => {
    try {
      return await runtime.openInstance({
        instanceId: ctx.instanceId,
        input: ctx.input,
        ctx,
      });
    } catch (err) {
      throw toCanvasError(err);
    }
  },

  onClose: async (ctx) => {
    await runtime.closeInstance(ctx.instanceId);
  },
});

const session = await joinSession({ canvases: [canvas] });

// Give canvas action handlers access to the host's AI model via ctx.ai /
// ctx.askAgent. This is the ONLY place the SDK is touched; keep canvas.mjs
// SDK-free and just call ctx.ai(...) / ctx.askAgent(...) from a handler.
runtime.setHost({
  // ctx.ai(question) -> Promise<string>: a silent, no-tools model query that is
  // NOT added to the conversation. It runs against the ambient conversation
  // context, so write self-contained prompts ("You are X. Output ONLY ...").
  ai: async (question) => {
    const { answer } = await session.rpc.ui.ephemeralQuery({ question: String(question) });
    return answer ?? "";
  },
  // ctx.askAgent(prompt): hand a prompt to the MAIN agent (visible in chat,
  // tool-capable). Use for "act in the repo" requests, not silent generation.
  askAgent: async (prompt) => session.send({ prompt: String(prompt) }),
});
