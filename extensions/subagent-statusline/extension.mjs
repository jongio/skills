import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { ensurePluginStatuslineRegistered } from "./compose.mjs";
import { SubagentTracker, syncSession, writeState } from "./tracker.mjs";

ensurePluginStatuslineRegistered("subagent-statusline", dirname(fileURLToPath(import.meta.url)));

const session = await joinSession({
	commands: [{
		name: "session-subagents",
		description: "Session subagent statusline: list, remove <agent-id>, or clear",
		handler: async ({ args }) => {
			try {
				const [action = "list", id] = args.trim().split(/\s+/).filter(Boolean);
				const tracker = syncSession({ session_id: session.sessionId }).tracker ?? new SubagentTracker(session.sessionId);
				const agents = tracker.manage(action, id);
				writeState(tracker.snapshot());
				const c = tracker.counts();
				await session.log(action === "clear" ? "Cleared subagent statusline." :
					`Subagents: ${c.starting} starting, ${c.exploring} exploring, ${c.inPr} in PR, ${c.merged} merged, ${c.done} done, ${c.failed} failed\n${agents.map((a) => `${a.id}: ${a.name} (${a.status})`).join("\n")}`);
			} catch (error) {
				await session.log(`Usage: /session-subagents [list | remove <agent-id> | clear] (${error.message})`);
			}
		},
	}],
	tools: [{
		name: "session_subagents",
		description: "List, remove an agent pill, or clear agent pills in this session without stopping agents.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["list", "remove", "clear"] },
				id: { type: "string", description: "Tracked agent ID; required for remove" },
			},
			required: ["action"],
			additionalProperties: false,
		},
		handler: ({ action, id }) => {
			const tracker = syncSession({ session_id: session.sessionId }).tracker ?? new SubagentTracker(session.sessionId);
			const agents = tracker.manage(action, id);
			writeState(tracker.snapshot());
			return JSON.stringify(agents);
		},
	}],
});
