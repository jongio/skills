import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { ensurePluginStatuslineRegistered } from "./compose.mjs";
import { readState, SubagentTracker, writeState } from "./tracker.mjs";

ensurePluginStatuslineRegistered("subagent-statusline", dirname(fileURLToPath(import.meta.url)));

const session = await joinSession({
	commands: [{
		name: "session-subagents",
		description: "Session subagent statusline: list or clear",
		handler: async ({ args }) => {
			const action = args.trim().split(/\s+/)[0] || "list";
			const tracker = new SubagentTracker(session.sessionId, readState(session.sessionId));
			if (action === "clear") {
				tracker.clear();
				writeState(tracker.snapshot());
				await session.log("Cleared subagent statusline.");
				return;
			}
			const c = tracker.counts();
			await session.log(`Subagents: ${c.starting} starting, ${c.exploring} exploring, ${c.inPr} in PR, ${c.merged} merged, ${c.done} done, ${c.failed} failed`);
		},
	}],
});
