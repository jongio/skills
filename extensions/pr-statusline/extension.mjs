import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { collect } from "./collector.mjs";
import {
	ensurePluginStatuslineRegistered,
	runInteractiveStatuslinePicker,
} from "./compose.mjs";
import {
	IssueTracker,
	readState as readIssueState,
	writeState as writeIssueState,
} from "../issue-statusline/tracker.mjs";
import {
	readState as readSubagentState,
	SubagentTracker,
	writeState as writeSubagentState,
} from "../subagent-statusline/tracker.mjs";

const { firstRun } = ensurePluginStatuslineRegistered("pr-statusline", dirname(fileURLToPath(import.meta.url)), {
	includeSiblings: true,
});

let collector;
function manage(action, reference) {
	if (!collector) throw new Error("PR statusline is still loading.");
	return collector.manage(action, reference);
}

const session = await joinSession({
	commands: [
		{
			name: "statusline-setup",
			description: "Choose which Copilot CLI statuslines are enabled (Pull Requests, Issues, Subagents, Branch/Worktree)",
			handler: async ({ args }) => {
				await runInteractiveStatuslinePicker(session, { args });
			},
		},
		{
			name: "session-worktree",
			description: "Show the active session branch, worktree, and full working directory",
			handler: async () => {
				const { describeSessionDirectory } = await import("../worktree-statusline/tracker.mjs");
				await session.log(describeSessionDirectory({ session_id: session.sessionId }));
			},
		},
		{
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
		},
		{
			name: "session-issues",
			description: "Session issue links: list, add owner/repo#123, remove owner/repo#123, or clear",
			handler: async ({ args }) => {
				try {
					const [action = "list", reference] = args.trim().split(/\s+/);
					const tracker = new IssueTracker(session.sessionId, readIssueState(session.sessionId));
					const issues = tracker.manage(action, reference);
					writeIssueState(tracker.snapshot());
					await session.log(issues.length ? issues.map((i) => `${i.label}: ${i.url}`).join("\n") : "No tracked session issues.");
				} catch (error) {
					await session.log(`Usage: /session-issues [list | add <issue> | remove <issue> | clear] (${error.message})`);
				}
			},
		},
		{
			name: "session-subagents",
			description: "Session subagent statusline: list or clear",
			handler: async ({ args }) => {
				const action = args.trim().split(/\s+/)[0] || "list";
				const tracker = new SubagentTracker(session.sessionId, readSubagentState(session.sessionId));
				if (action === "clear") {
					tracker.clear();
					writeSubagentState(tracker.snapshot());
					await session.log("Cleared subagent statusline.");
					return;
				}
				const c = tracker.counts();
				await session.log(`Subagents: ${c.starting} starting, ${c.exploring} exploring, ${c.inPr} in PR, ${c.merged} merged, ${c.done} done, ${c.failed} failed`);
			},
		},
	],
	tools: [
		{
			name: "statusline_setup",
			description: "Configure which Copilot CLI statusline extensions are enabled (Pull Requests, GitHub Issues, Subagents, Branch/Worktree). Omit arguments to open the interactive picker.",
			parameters: {
				type: "object",
				properties: {
					selection: {
						type: "string",
						description: "Optional selection string such as 'all', 'none', or space-separated 'prs issues subagents worktrees'. Leave empty to open the interactive checkbox dialog.",
					},
				},
				additionalProperties: false,
			},
			handler: async ({ selection = "" } = {}) => {
				const res = await runInteractiveStatuslinePicker(session, { args: selection });
				return JSON.stringify(res);
			},
		},
		{
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
		},
		{
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
				const tracker = new IssueTracker(session.sessionId, readIssueState(session.sessionId));
				const issues = tracker.manage(action, reference);
				writeIssueState(tracker.snapshot());
				return JSON.stringify(issues);
			},
		},
	],
});

collector = await collect(session);

if (firstRun && session.capabilities?.ui?.elicitation) {
	runInteractiveStatuslinePicker(session).catch(() => {});
}
