import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { mergeObservations, mergeRefreshState, prefetchStatuses } from "../github-refresh.mjs";

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
	return withSessionDirectory({ ...payload, transcript_path: transcript }, (location) => {
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
		if (!stat) {
			pr.state.transcriptOffset = 0;
			issue.state.transcriptOffset = 0;
			agents.transcriptOffset = 0;
		}
		const clearedAt = Math.max(now, ...[pr.state.clearedAt, issue.state.clearedAt, agents.clearedAt, latest?.clearedAt ?? 0].map((time) => time + 1));
		const clearedContext = {
			cwd: latest?.cwd ?? payload.cwd ?? null, agentCwds: latest?.agentCwds ?? {},
			sequence: latest?.sequence ?? 0, appliedSequence: latest?.appliedSequence ?? 0,
			observedThroughAt: Number.isFinite(latest?.observedThroughAt) ? latest.observedThroughAt : 0,
		};
		pr.state.clearedPrs = [...new Set([...pr.state.clearedPrs, ...pr.state.prs.map((entry) => entry.url)])];
		pr.state.clearedWorkspace = [repository, branch, cwd, name];
		pr.state.prs = [];
		pr.state.ignoredRevisions = Object.fromEntries(Object.entries(pr.state.ignoredRevisions)
			.filter(([url]) => pr.state.ignored.includes(url)));
		pr.state.clearedAt = clearedAt;
		delete pr.state.simulate;
		pr.calls.clear();
		pr.pending.clear();
		pr.background.clear();
		issue.state.issues = [];
		issue.state.clearedWorkspace = [repository, branch, name];
		issue.state.clearedAt = clearedAt;
		issue.calls.clear();
		agents.clear();
		agents.clearedAt = clearedAt;
		agents.simulated = false;
		writeState(pr.snapshot(), home);
		writeIssues(issue.snapshot(), home);
		writeAgents(agents.snapshot(), home);
		writeJson(path, {
			...latest, ...clearedContext, version: 3, offset,
			clearedAt: Math.max(clearedAt, clearedContext.observedThroughAt), dismissed: true, clearedContext, directories: [],
			pending: {}, agentDirectories: {}, skipPartial: false,
		});
		return "Cleared this session's PR, issue, subagent, and worktree entries. Component settings and transcripts are unchanged.";
	}, { home });
}

export async function refreshSessionStatusline(payload, {
	home = configHome(), now = Date.now(), fetchPrStatus, fetchIssueStatus, run,
	force = true, remoteOnly = false, signal,
} = {}) {
	const id = payload?.session_id;
	const prs = new SessionTracker(id, readState(id, home));
	const issues = new IssueTracker(id, readIssues(id, home));
	const agents = new SubagentTracker(id, readAgents(id, home));
	const previousPrs = structuredClone(prs.state.prs);
	const previousIssues = structuredClone(issues.state.issues);
	const initialPrState = { ...prs.state, prs: previousPrs };
	const initialIssueState = { ...issues.state, issues: previousIssues, explicitRevisions: { ...issues.state.explicitRevisions } };
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
		["PRs", async () => {
			const fetch = await prefetchStatuses("pr", remotePrs.state.prs, { home, now, force, fetchStatus: fetchPrStatus, signal });
			signal?.throwIfAborted();
			refreshTrackedPrStatuses(remotePrs, { home, now, fetchPrStatus: fetch, force, prefetched: true, onError });
			const saved = updateState(id, (current) => {
				current ??= prs.snapshot();
				if ((current.clearedAt ?? 0) !== prs.state.clearedAt) return current;
				return mergeRefreshState(current, initialPrState, remotePrs.state, "prs");
			}, home);
			prs.state.prs = saved.prs;
		}],
		["Issues", async () => {
			const fetch = await prefetchStatuses("issue", issues.state.issues, { home, now, force, fetchStatus: fetchIssueStatus, signal });
			signal?.throwIfAborted();
			refreshTrackedIssueStatuses(issues, { home, now, fetchIssueStatus: fetch, force, prefetched: true, onError });
			updateIssues(id, (current) => {
				current ??= issues.snapshot();
				if ((current.clearedAt ?? 0) !== issues.state.clearedAt) return current;
				return mergeRefreshState(current, initialIssueState, issues.state, "issues");
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
			if (remoteOnly) return;
			const { contexts, catchingUp } = sessionContexts(payload, { home, run, force: true });
			if (catchingUp) throw new Error("Transcript replay is still catching up; retry refresh after the next footer update.");
			const linked = resolveLinkedCheckouts(payload, contexts, prs.state.prs, { home, now, run, force: true });
			for (const context of [...contexts, ...linked]) checkoutDivergence(context, prs.state.prs, { run, force: true });
		}],
	]) {
		if (signal?.aborted) break;
		try {
			await refresh();
		} catch (error) {
			onError(new Error(`${label}: ${error.message}`));
		}
	}
	return failures.length
		? `Session statusline refresh incomplete:\n${failures.join("\n")}`
		: "Refreshed this session's tracked statusline entries. Tracking and enabled components are unchanged.";
}
