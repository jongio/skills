import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { ensurePluginStatuslineRegistered, isTerminalStatuslineSupported } from "./compose.mjs";
import { describeSessionDirectory } from "./tracker.mjs";

const extensionDir = dirname(fileURLToPath(import.meta.url));
if (!isTerminalStatuslineSupported()) {
	await joinSession({ tools: [] });
} else {
	ensurePluginStatuslineRegistered("worktree-statusline", extensionDir);
	const session = await joinSession({
		commands: [{
			name: "session-worktree",
			description: "Show the active session branch, worktree, and full working directory",
			handler: async () => {
				await session.log(describeSessionDirectory({ session_id: session.sessionId }));
			},
		}],
	});
}
