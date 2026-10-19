import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { ensurePluginStatuslineRegistered } from "./compose.mjs";
import { describeSessionDirectory } from "./tracker.mjs";

ensurePluginStatuslineRegistered("worktree-statusline", dirname(fileURLToPath(import.meta.url)));

const session = await joinSession({
	commands: [{
		name: "session-worktree",
		description: "Show the active session branch, worktree, and full working directory",
		handler: async () => {
			await session.log(describeSessionDirectory({ session_id: session.sessionId }));
		},
	}],
});
