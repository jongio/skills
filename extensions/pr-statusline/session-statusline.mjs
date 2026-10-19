import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	configHome, readState, refreshTrackedPrStatuses, SessionTracker, syncSession as syncPrs, transcriptPathFor, writeState,
} from "./tracker.mjs";
import {
	IssueTracker, readState as readIssues, refreshTrackedIssueStatuses, syncSession as syncIssues, writeState as writeIssues,
} from "../issue-statusline/tracker.mjs";
import {
	readState as readAgents, SubagentTracker, syncSession as syncAgents, writeState as writeAgents,
} from "../subagent-statusline/tracker.mjs";
import { readPrCache } from "./github.mjs";
import {
	checkoutDivergence, readJson, sessionContexts, sessionDirectory, writeJson,
} from "../worktree-statusline/tracker.mjs";
import { resolveLinkedCheckouts } from "../worktree-statusline/worktrees.mjs";

export function clearSessionStatusline(payload, { home = configHome(), now = Date.now() } = {}) {
	const id = payload?.session_id;
	const transcript = transcriptPathFor(id, home, payload?.transcript_path);
	let offset = 0;
	try {
		offset = statSync(transcript).size;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const pr = new SessionTracker(id, syncPrs(payload, { home, now, fetchPrStatus: false }).state);
	const issue = new IssueTracker(id, syncIssues(payload, { home, now, fetchIssueStatus: false }).state);
	const agents = syncAgents(payload, { home, now }).tracker ?? new SubagentTracker(id);
	let workspace = "";
	try {
		workspace = readFileSync(join(dirname(transcript), "workspace.yaml"), "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const [repository, branch, cwd, name] = ["repository", "branch", "cwd", "name"]
		.map((key) => new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m").exec(workspace)?.[1] ?? null);
	sessionDirectory(payload, { home });
	const path = join(home, "worktree-statusline", `${id}.json`);
	const worktree = readJson(path);
	const clearedAt = Math.max(now, ...[pr.state.clearedAt, issue.state.clearedAt, agents.clearedAt, worktree?.clearedAt ?? 0].map((time) => time + 1));
	pr.state.clearedPrs = [...new Set([...pr.state.clearedPrs, ...pr.state.prs.map((entry) => entry.url)])];
	pr.state.clearedWorkspace = [repository, branch, cwd, name];
	pr.state.prs = [];
	pr.state.ignoredRevisions = Object.fromEntries(Object.entries(pr.state.ignoredRevisions)
		.filter(([url]) => pr.state.ignored.includes(url)));
	pr.state.clearedAt = clearedAt;
	pr.state.transcriptOffset = offset;
	delete pr.state.simulate;
	pr.calls.clear();
	pr.pending.clear();
	pr.background.clear();
	issue.state.issues = [];
	issue.state.clearedWorkspace = [repository, branch, name];
	issue.state.clearedAt = clearedAt;
	issue.state.transcriptOffset = offset;
	issue.calls.clear();
	agents.clear();
	agents.clearedAt = clearedAt;
	agents.transcriptOffset = offset;
	agents.simulated = false;
	writeState(pr.snapshot(), home);
	writeIssues(issue.snapshot(), home);
	writeAgents(agents.snapshot(), home);
	writeJson(path, {
		...worktree, version: 3, offset, clearedAt, dismissed: true, cwd: worktree?.cwd ?? payload.cwd ?? null, directories: [],
		pending: {}, agentCwds: {}, agentDirectories: {}, skipPartial: false,
	});
	return "Cleared this session's PR, issue, subagent, and worktree entries. Component settings and transcripts are unchanged.";
}

export function refreshSessionStatusline(payload, {
	home = configHome(), now = Date.now(), fetchPrStatus, fetchIssueStatus, run,
} = {}) {
	const id = payload?.session_id;
	const prs = new SessionTracker(id, readState(id, home));
	const issues = new IssueTracker(id, readIssues(id, home));
	const agents = new SubagentTracker(id, readAgents(id, home));
	const failures = [];
	const onError = (error) => failures.push(error.message);
	// Agent-linked PRs need fresh remote state even when their detailed pills are hidden.
	const remotePrs = new SessionTracker(id, prs.snapshot());
	remotePrs.state.ignored = [];
	for (const agent of agents.agents.values()) {
		for (const url of agent.prs) remotePrs.add(url);
	}
	for (const [label, refresh] of [
		["PRs", () => {
			refreshTrackedPrStatuses(remotePrs, { home, now, fetchPrStatus, force: true, onError });
			writeState(prs.snapshot(), home);
		}],
		["Issues", () => {
			refreshTrackedIssueStatuses(issues, { home, now, fetchIssueStatus, force: true, onError });
			writeIssues(issues.snapshot(), home);
		}],
		["Subagents", () => {
			agents.syncWithPrCache(readPrCache(home), now);
			writeAgents(agents.snapshot(), home);
		}],
		["Worktrees", () => {
			const { contexts, catchingUp } = sessionContexts(payload, { home, run, force: true });
			if (catchingUp) throw new Error("Transcript replay is still catching up; retry refresh after the next footer update.");
			const linked = resolveLinkedCheckouts(payload, contexts, prs.state.prs, { home, now, run, force: true });
			for (const context of [...contexts, ...linked]) checkoutDivergence(context, prs.state.prs, { run, force: true });
		}],
	]) {
		try {
			refresh();
		} catch (error) {
			onError(new Error(`${label}: ${error.message}`));
		}
	}
	return failures.length
		? `Session statusline refresh incomplete:\n${failures.join("\n")}`
		: "Refreshed this session's tracked statusline entries. Tracking and enabled components are unchanged.";
}
