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

await joinSession({ canvases: [canvas] });
