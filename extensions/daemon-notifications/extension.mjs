import { joinSession } from "@github/copilot-sdk/extension";
import { homedir } from "node:os";
import { join } from "node:path";
import { createNotificationBridge } from "./bridge.mjs";
import { renameSync } from "node:fs";

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
const bootstrap = await joinSession({ tools: [] });
const { extensions } = await bootstrap.rpc.extensions.list();
const current = extensions.find((entry) => entry.pid === process.pid);
if (!current) throw new Error("Cannot verify the current notifications provider; restart Copilot before migrating.");
const legacy = "user:daemon-notifications";
if (current.id !== legacy) {
  const file = join(home, "extensions", "daemon-notifications", "extension.mjs");
  try { renameSync(file, `${file}.disabled-${Date.now()}-${process.pid}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (extensions.some((entry) => entry.id === legacy)) await bootstrap.rpc.extensions.disable({ id: legacy });
}
await bootstrap.disconnect();
const session = await joinSession(configuration);
bridge = createNotificationBridge(session, { home });
session.on((event) => { if (event.type === "session.shutdown") bridge.stop(); });
process.once("SIGTERM", () => { bridge.stop(); process.exit(0); });
