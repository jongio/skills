import { renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { collect } from "./collector.mjs";
import { configHome } from "./tracker.mjs";
import { createSessionAttention, runAttentionCommand } from "./attention.mjs";
import { clearSessionStatusline, refreshSessionStatusline } from "./session-statusline.mjs";
import {
	ensurePluginStatuslineRegistered,
	readSessionName,
	runInteractiveStatuslinePicker,
	setSessionName,
} from "./compose.mjs";
import {
	IssueTracker,
	syncSession as syncIssues,
	writeState as writeIssueState,
} from "../issue-statusline/tracker.mjs";
import {
	readState as readSubagentState,
	SubagentTracker,
	syncSession as syncAgents,
	writeState as writeSubagentState,
} from "../subagent-statusline/tracker.mjs";

const { firstRun } = ensurePluginStatuslineRegistered("pr-statusline", dirname(fileURLToPath(import.meta.url)), {
	includeSiblings: true,
});

let collector;
let attention;
function manage(action, reference, invocation) {
	if (!collector) throw new Error("PR statusline is still loading.");
	return collector.manage(action, reference, invocation?.toolCallId);
}

function manageAgents(action, id) {
	const tracker = syncAgents({ session_id: session.sessionId }).tracker ?? new SubagentTracker(session.sessionId);
	const agents = tracker.manage(action, id);
	writeSubagentState(tracker.snapshot());
	return agents;
}

function updateSession(action, name) {
	if (action === "name" || action === "clear-name") {
		const value = action === "clear-name" ? setSessionName(session.sessionId, null)
			: name === undefined ? readSessionName(session.sessionId) : setSessionName(session.sessionId, name);
		return value ? `Session name: ${value}` : action === "clear-name" ? "Session name cleared." : "No custom session name.";
	}
	if (!collector) throw new Error("Session statusline is still loading; retry shortly.");
	const payload = { session_id: session.sessionId };
	const result = action === "clear" ? clearSessionStatusline(payload) : refreshSessionStatusline(payload);
	collector.reload();
	return result;
}

const configuration = {
	commands: [
		{
			name: "session-attention",
			description: "Configure Windows Terminal attention alerts, show a preview, or inspect this session's window binding",
			handler: async ({ args = "" }) => {
				try {
					if (!attention) throw new Error("Session attention is still loading; retry shortly.");
					await session.log(await runAttentionCommand(attention, args));
				} catch (error) {
					await session.log(`Session attention: ${error.message}`);
				}
			},
		},
		{
			name: "session-statusline",
			description: "Set, show, or clear this session's custom footer name; refresh or clear entries; set up components",
			handler: async ({ args = "" }) => {
				const [action, ...selection] = args.trim().split(/\s+/);
				try {
					if (action === "name") {
						await session.log(updateSession(action, selection.length ? selection.join(" ") : undefined));
					} else if (action === "setup") {
						await runInteractiveStatuslinePicker(session, { args: selection.join(" ") });
					} else if (["clear", "refresh", "clear-name"].includes(action) && !selection.length) {
						await session.log(updateSession(action));
					} else {
						await session.log("Usage: /session-statusline [name [<label>] | clear-name | refresh | clear | setup [all | none | prs issues subagents worktrees]]");
					}
				} catch (error) {
					await session.log(`Session statusline ${action || "command"} failed: ${error.message}`);
				}
			},
		},
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
					const tracker = new IssueTracker(session.sessionId, syncIssues({ session_id: session.sessionId }, { fetchIssueStatus: false }).state);
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
			description: "Session subagent statusline: list, remove <agent-id>, or clear",
			handler: async ({ args }) => {
				try {
					const [action = "list", id] = args.trim().split(/\s+/).filter(Boolean);
					const agents = manageAgents(action, id);
					const tracker = new SubagentTracker(session.sessionId, readSubagentState(session.sessionId));
					const c = tracker.counts();
					await session.log(action === "clear" ? "Cleared subagent statusline." :
						`Subagents: ${c.starting} starting, ${c.exploring} exploring, ${c.inPr} in PR, ${c.merged} merged, ${c.done} done, ${c.failed} failed\n${agents.map((a) => `${a.id}: ${a.name} (${a.status})`).join("\n")}`);
				} catch (error) {
					await session.log(`Usage: /session-subagents [list | remove <agent-id> | clear] (${error.message})`);
				}
			},
		},
	],
	tools: [
		{
			name: "session_statusline",
			description: "Manage only this session's statusline: name sets a custom footer label (omit name to show it), clear-name removes it, clear dismisses pills, refresh updates data. Clear preserves the name, enabled components, and underlying work.",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["clear", "refresh", "name", "clear-name"] },
					name: { type: "string", description: "Custom footer label for action name; omit to show the current name." },
				},
				required: ["action"],
				additionalProperties: false,
			},
			handler: ({ action, name }) => {
				if (!["clear", "refresh", "name", "clear-name"].includes(action)) throw new Error("Use clear or refresh, name, or clear-name.");
				try {
					if (name !== undefined && (action !== "name" || typeof name !== "string")) {
						throw new Error("A name string is only supported with action name.");
					}
					return updateSession(action, name);
				} catch (error) {
					return { resultType: "failure", textResultForLlm: error instanceof Error ? error.message : String(error) };
				}
			},
		},
		{
			name: "session_subagents",
			description: "List, remove an agent pill, or clear agent pills belonging to this session. Does not stop agents or affect other sessions.",
			parameters: {
				type: "object",
				properties: {
					action: { type: "string", enum: ["list", "remove", "clear"] },
					id: { type: "string", description: "Tracked agent ID; required for remove" },
				},
				required: ["action"],
				additionalProperties: false,
			},
			handler: ({ action, id }) => JSON.stringify(manageAgents(action, id)),
		},
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
			handler: ({ action, reference }, invocation) => JSON.stringify(manage(action, reference, invocation)),
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
				const tracker = new IssueTracker(session.sessionId, syncIssues({ session_id: session.sessionId }, { fetchIssueStatus: false }).state);
				const issues = tracker.manage(action, reference);
				writeIssueState(tracker.snapshot());
				return JSON.stringify(issues);
			},
		},
	],
};

const bootstrap = await joinSession({ tools: [] });
const { extensions } = await bootstrap.rpc.extensions.list();
const current = extensions.find((entry) => entry.pid === process.pid);
if (!current) throw new Error("Cannot verify the current statusline controller; restart Copilot before migrating.");
const standalone = ["pr", "issue", "subagent", "worktree"].map((name) => ({
	id: `user:${name}-statusline`,
	file: join(configHome(), "extensions", `${name}-statusline`, "extension.mjs"),
}));
for (const entry of standalone.filter((entry) => entry.id !== current.id)) {
	try {
		renameSync(entry.file, `${entry.file}.disabled-${Date.now()}-${process.pid}`);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (extensions.some((extension) => extension.id === entry.id)) await bootstrap.rpc.extensions.disable({ id: entry.id });
}
// Remove the bootstrap subscriber before registering the final SDK handlers.
await bootstrap.disconnect();
const session = await joinSession(configuration);

attention = createSessionAttention({ ownerProcessId: process.ppid });
collector = await collect(session, { attention });

if (firstRun && session.capabilities?.ui?.elicitation) {
	runInteractiveStatuslinePicker(session).catch(() => {});
}
