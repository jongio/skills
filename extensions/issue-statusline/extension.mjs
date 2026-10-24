import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { ensurePluginStatuslineRegistered } from "./compose.mjs";
import { IssueTracker, syncSession, writeState } from "./tracker.mjs";
import { startIssueRefresh } from "../github-refresh.mjs";
import { requestedGitHubEnvironment } from "../github-transport.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

ensurePluginStatuslineRegistered("issue-statusline", dirname(fileURLToPath(import.meta.url)));

const session = await joinSession({
	requestedEnvironmentVariables: requestedGitHubEnvironment(),
	commands: [{
		name: "session-issues",
		description: "Session issue links: list, add owner/repo#123, remove owner/repo#123, or clear",
		handler: async ({ args }) => {
			try {
				const [action = "list", reference] = args.trim().split(/\s+/);
				const tracker = new IssueTracker(session.sessionId, syncSession({ session_id: session.sessionId }, { fetchIssueStatus: false }).state);
				const issues = tracker.manage(action, reference);
				writeState(tracker.snapshot());
				await session.log(issues.length ? issues.map((i) => `${i.label}: ${i.url}`).join("\n") : "No tracked session issues.");
			} catch (error) {
				await session.log(`Usage: /session-issues [list | add <issue> | remove <issue> | clear] (${error.message})`);
			}
		},
	}],
	tools: [{
		name: "session_issues",
		description: "Manage only this session's statusline issues. Add issues being worked on; remove issues no longer relevant.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["list", "add", "remove", "clear"] },
				reference: { type: "string", description: "Issue web URL or owner/repo#number; required for add/remove" },
			},
			required: ["action"],
			additionalProperties: false,
		},
		handler: ({ action, reference }) => {
			const tracker = new IssueTracker(session.sessionId, syncSession({ session_id: session.sessionId }, { fetchIssueStatus: false }).state);
			const issues = tracker.manage(action, reference);
			writeState(tracker.snapshot());
			return JSON.stringify(issues);
		},
	}],
});

const stopRefresh = startIssueRefresh(session, { home: process.env.COPILOT_HOME || join(homedir(), ".copilot") });
session.on((event) => {
	if (event.type === "session.shutdown") stopRefresh();
});
