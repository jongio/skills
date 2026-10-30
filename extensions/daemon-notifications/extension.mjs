import { joinSession } from "@github/copilot-sdk/extension";
import { homedir } from "node:os";
import { join } from "node:path";
import { createNotificationBridge } from "./bridge.mjs";

const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
let bridge;
const manage = (action = "status", watcher) => {
  if (!bridge) throw new Error("Notification bridge is loading");
  return bridge.manage(action, watcher);
};
const configuration = {
  commands: [{
    name: "daemon-notifications",
    description: "Opt into watcher progress notifications; does not start watchers or repairs",
    handler: async ({ args = "" }) => {
      const [action, watcher] = args.trim().split(/\s+/);
      await session.log(JSON.stringify(manage(action || "status", watcher)));
    },
  }],
  tools: [{
    name: "daemon_notifications",
    description: "Subscribe this session to explicit daemon event files; no agent prompts or automatic remediation.",
    parameters: {
      type: "object", properties: {
        action: { type: "string", enum: ["subscribe", "unsubscribe", "status"] },
        watcher: { type: "string", description: "Session-local watcher identifier, required for subscribe/unsubscribe" },
      }, required: ["action"], additionalProperties: false,
    },
    handler: ({ action, watcher }) => JSON.stringify(manage(action, watcher)),
  }],
};
const session = await joinSession(configuration);
const provider = new URL(import.meta.url).searchParams.get("provider") === "full" ? "full" : "standalone";
bridge = createNotificationBridge(session, { home, provider });
session.on((event) => { if (event.type === "session.shutdown") bridge.stop(); });
process.once("SIGTERM", () => { bridge.stop(); process.exit(0); });
