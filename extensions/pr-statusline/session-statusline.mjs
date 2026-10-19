import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	configHome, readState, refreshTrackedPrStatuses, SessionTracker, syncSession as syncPrs, transcriptPathFor, updateState, writeState,
} from "./tracker.mjs";
import {
	IssueTracker, readState as readIssues, refreshTrackedIssueStatuses, syncSession as syncIssues, updateState as updateIssues, writeState as writeIssues,
} from "../issue-statusline/tracker.mjs";
import {
	readState as readAgents, SubagentTracker, syncSession as syncAgents, updateState as updateAgents, writeState as writeAgents,
} from "../subagent-statusline/tracker.mjs";
import { readPrCache } from "./github.mjs";
import {
	checkoutDivergence, readJson, sessionContexts, transcriptIdentity, withSessionDirectory, writeJson,
} from "../worktree-statusline/tracker.mjs";
import { resolveLinkedCheckouts } from "../worktree-statusline/worktrees.mjs";

export function clearSessionStatusline(payload, { home = configHome(), now = Date.now() } = {}) {
	const id = payload?.session_id;
	const transcript = transcriptPathFor(id, home, payload?.transcript_path);
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
	const path = join(home, "worktree-statusline", `${id}.json`);
	return withSessionDirectory(payload, (location) => {
		const latest = readJson(path);
		let stat;
		try {
			stat = statSync(transcript);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const offset = stat?.size ?? 0;
		if (location.catchingUp || (stat && (latest?.offset !== offset || latest?.identity !== transcriptIdentity(transcript, stat)))) {
			throw new Error("Worktree history is still catching up. Run /session-statusline clear again after replay completes.");
		}
		const clearedAt = Math.max(now, ...[pr.state.clearedAt, issue.state.clearedAt, agents.clearedAt, latest?.clearedAt ?? 0].map((time) => time + 1));
		const clearedContext = {
			cwd: latest?.cwd ?? payload.cwd ?? null, agentCwds: latest?.agentCwds ?? {},
			sequence: latest?.sequence ?? 0, appliedSequence: latest?.appliedSequence ?? 0,
		};
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
			...latest, ...clearedContext, version: 3, offset, clearedAt, dismissed: true, clearedContext, directories: [],
			pending: {}, agentDirectories: {}, skipPartial: false,
		});
		return "Cleared this session's PR, issue, subagent, and worktree entries. Component settings and transcripts are unchanged.";
	}, { home });
}

export function refreshSessionStatusline(payload, {
	home = configHome(), now = Date.now(), fetchPrStatus, fetchIssueStatus, run,
} = {}) {
	const id = payload?.session_id;
	const prs = new SessionTracker(id, readState(id, home));
	const issues = new IssueTracker(id, readIssues(id, home));
	const agents = new SubagentTracker(id, readAgents(id, home));
	const previousPrs = structuredClone(prs.state.prs);
	const previousIssues = structuredClone(issues.state.issues);
	const previousAgents = structuredClone(agents.snapshot());
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
			const saved = updateState(id, (current) => {
				current ??= prs.snapshot();
				if ((current.clearedAt ?? 0) !== prs.state.clearedAt) return current;
				return { ...current, prs: mergeObservations(current.prs, previousPrs, remotePrs.state.prs), updatedAt: Date.now() };
			}, home);
			prs.state.prs = saved.prs;
		}],
		["Issues", () => {
			refreshTrackedIssueStatuses(issues, { home, now, fetchIssueStatus, force: true, onError });
			updateIssues(id, (current) => {
				current ??= issues.snapshot();
				if ((current.clearedAt ?? 0) !== issues.state.clearedAt) return current;
				return { ...current, issues: mergeObservations(current.issues, previousIssues, issues.state.issues), updatedAt: Date.now() };
			}, home);
		}],
		["Subagents", () => {
			agents.syncWithPrCache(readPrCache(home), now);
			updateAgents(id, (current) => {
				current ??= previousAgents;
				if ((current.clearedAt ?? 0) !== agents.clearedAt) return current;
				return {
					...current, updatedAt: Date.now(),
					dismissed: current.dismissed === previousAgents.dismissed ? agents.dismissed : current.dismissed,
					agents: Object.fromEntries(mergeObservations(Object.values(current.agents),
						Object.values(previousAgents.agents), [...agents.agents.values()]).map((agent) => [agent.id, agent])),
				};
			}, home);
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

function mergeObservations(current, previous, refreshed) {
	const key = (item) => item.url ?? item.id;
	const before = new Map(previous.map((item) => [key(item), item]));
	const after = new Map(refreshed.map((item) => [key(item), item]));
	const lifecycle = ["generation", "checkedAt", "status", "closedAt", "mergedAt", "mergedObservedAt", "prs",
		"mergedPrs", "settlementObservedAt", "settlementDismissed"];
	return current.map((item) => {
		const old = before.get(key(item)), fresh = after.get(key(item));
		if (!old || !fresh || lifecycle.some((field) => !isDeepStrictEqual(item[field], old[field]))) return item;
		const fields = [...new Set([...Object.keys(old), ...Object.keys(fresh)])]
			.filter((field) => !isDeepStrictEqual(old[field], fresh[field]));
		if (fields.some((field) => !isDeepStrictEqual(item[field], old[field]))) return item;
		const updated = { ...item };
		for (const field of fields) {
			if (Object.hasOwn(fresh, field)) updated[field] = fresh[field];
			else delete updated[field];
		}
		return updated;
	});
}
