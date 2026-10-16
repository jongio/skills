import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { collect } from "./collector.mjs";
import { ensurePluginStatuslineRegistered } from "./compose.mjs";

ensurePluginStatuslineRegistered("pr-statusline", dirname(fileURLToPath(import.meta.url)));

let collector;
function manage(action, reference) {
	if (!collector) throw new Error("PR statusline is still loading.");
	return collector.manage(action, reference);
}

const session = await joinSession({
	commands: [{
		name: "session-prs",
		description: "Session PR links: list, add owner/repo#123, remove owner/repo#123, or clear",
		handler: async ({ args }) => {
			try {
				const [action = "list", reference] = args.trim().split(/\s+/);
				const prs = manage(action, reference);
				await session.log(prs.length ? prs.map((pr) => `${pr.label}: ${pr.url}`).join("\n") : "No tracked session PRs.");
			} catch (error) {
				await session.log(`Usage: /session-prs [list | add <pr> | remove <pr> | clear] (${error.message})`);
			}
		},
	}],
	tools: [{
		name: "session_prs",
		description: "Manage only this session's statusline PRs. Add PRs being worked on; remove PRs no longer relevant. Use qualified owner/repo#number or a PR web URL, never an issue reference.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["list", "add", "remove", "clear"] },
				reference: { type: "string", description: "PR web URL or owner/repo#number; required for add/remove" },
			},
			required: ["action"],
			additionalProperties: false,
		},
		handler: ({ action, reference }) => JSON.stringify(manage(action, reference)),
	}],
});

collector = await collect(session);

