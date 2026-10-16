import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ISSUE_OPEN_TTL_MS = 45_000;
export const ISSUE_CLOSED_TTL_MS = 120_000;

export const ICONS = {
	open: "\uF41B",
	closed: "\uF41D",
	bug: "\uF188",
	assignee: "\uF415",
	comment: "\uF075",
	linkedPr: "\uE726",
};

export function atomicWriteJson(filePath, data) {
	mkdirSync(dirname(filePath), { recursive: true });
	const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	const serialized = JSON.stringify(data);
	writeFileSync(temporary, serialized, { mode: 0o600 });
	try {
		renameSync(temporary, filePath);
	} catch (error) {
		if (error?.code === "EPERM" || error?.code === "EACCES") {
			try {
				writeFileSync(filePath, serialized, { mode: 0o600 });
				return;
			} catch {
				// Fall through to rethrow original error after cleanup.
			}
		}
		throw error;
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function readIssueCache(home) {
	try {
		return JSON.parse(readFileSync(join(home, "issue-statusline", "issue-cache.json"), "utf8"));
	} catch {
		return {};
	}
}

export function writeIssueCache(cache, home) {
	try {
		atomicWriteJson(join(home, "issue-statusline", "issue-cache.json"), cache);
	} catch {
		// Best-effort shared cache write.
	}
}

export function summarizeIssueStatus(data) {
	if (!data || typeof data !== "object") return null;
	const state = String(data.state ?? "").toUpperCase();
	if (state === "NOT_FOUND") return "NOT_FOUND";
	if (state === "CLOSED") return `${ICONS.closed} Closed`;

	const labels = Array.isArray(data.labels?.nodes)
		? data.labels.nodes.map((l) => String(l?.name ?? "").trim()).filter(Boolean)
		: [];
	const isBug = labels.some((l) => /\b(?:bug|defect|regression|crash|security|vulnerability)\b/i.test(l));
	const priorityLabel = labels.find((l) => /^(?:P[0-3]|priority[:/\s-]*\w+|blocker|critical|high|urgent|bug|enhancement|feature)$/i.test(l)) ??
		labels[0] ??
		null;

	const assignees = Array.isArray(data.assignees?.nodes)
		? data.assignees.nodes.map((a) => a?.login).filter(Boolean)
		: [];
	const linkedPrs = Array.isArray(data.closedByPullRequestsReferences?.nodes)
		? data.closedByPullRequestsReferences.nodes.filter((p) => p?.number)
		: [];
	const commentCount = Number.isInteger(data.comments?.totalCount)
		? data.comments.totalCount
		: (Number.isInteger(data.comments) ? data.comments : 0);

	const tokens = [];
	if (isBug) tokens.push(ICONS.bug);
	if (priorityLabel) tokens.push(priorityLabel);
	if (linkedPrs.length > 0) {
		tokens.push(ICONS.linkedPr);
	}
	if (assignees.length > 0) {
		tokens.push(`${ICONS.assignee} ${assignees[0]}`);
	}
	tokens.push(`${ICONS.comment} ${commentCount}`);
	return tokens.join(" ");
}

function getSecondaryGhAccounts() {
	const res = spawnSync("gh", ["auth", "status", "--json", "hosts"], {
		encoding: "utf8",
		timeout: 3000,
		windowsHide: true,
	});
	if (res.status !== 0 || !res.stdout) return [];
	try {
		const parsed = JSON.parse(res.stdout);
		const accounts = parsed?.hosts?.["github.com"] ?? [];
		return accounts.filter((a) => !a.active && a.login).map((a) => a.login);
	} catch {
		return [];
	}
}

function runGhWithFallback(args) {
	let res = spawnSync("gh", args, { encoding: "utf8", timeout: 4000, windowsHide: true });
	if (res.status === 0) return res;
	const stderr = String(res.stderr ?? "");
	if (/Could not resolve to a Repository/i.test(stderr)) {
		for (const login of getSecondaryGhAccounts()) {
			const tokenRes = spawnSync("gh", ["auth", "token", "--user", login], {
				encoding: "utf8",
				timeout: 2000,
				windowsHide: true,
			});
			const token = tokenRes.status === 0 ? tokenRes.stdout.trim() : "";
			if (!token) continue;
			res = spawnSync("gh", args, {
				encoding: "utf8",
				timeout: 4000,
				windowsHide: true,
				env: { ...process.env, GH_TOKEN: token },
			});
			if (res.status === 0) return res;
		}
	}
	return res;
}

const ISSUE_STATUS_GRAPHQL = `query($owner:String!,$name:String!,$number:Int!){
	repository(owner:$owner,name:$name){
		issue(number:$number){
			state
			stateReason
			closedAt
			title
			labels(first:10){nodes{name}}
			assignees(first:5){nodes{login}}
			comments{totalCount}
			closedByPullRequestsReferences(first:5){nodes{number state url repository{nameWithOwner}}}
		}
	}
}`;

export function queryIssueStatusWithGh(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const match = /^\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)(?:\/|$)/.exec(parsed.pathname);
	if (!match) return null;
	const [, owner, repo, number] = match;
	const args = [
		"api",
		"graphql",
		...(parsed.hostname !== "github.com" ? ["--hostname", parsed.hostname] : []),
		"-F",
		`owner=${owner}`,
		"-F",
		`name=${repo}`,
		"-F",
		`number=${number}`,
		"-f",
		`query=${ISSUE_STATUS_GRAPHQL}`,
	];
	const res = runGhWithFallback(args);
	if (res.status !== 0) {
		const stderr = String(res.stderr ?? "");
		if (/Could not resolve to an Issue/i.test(stderr)) {
			return { state: "NOT_FOUND" };
		}
		return null;
	}
	if (!res.stdout) return null;
	try {
		const payload = JSON.parse(res.stdout);
		const issue = payload?.data?.repository?.issue;
		return issue ?? { state: "NOT_FOUND" };
	} catch {
		return null;
	}
}

export function refreshTrackedIssueStatuses(tracker, {
	home,
	now = Date.now(),
	fetchIssueStatus = queryIssueStatusWithGh,
	issueCacheTtlMs = ISSUE_OPEN_TTL_MS,
} = {}) {
	if (typeof fetchIssueStatus !== "function") return false;
	const useSharedCache = fetchIssueStatus === queryIssueStatusWithGh;
	const cache = useSharedCache ? readIssueCache(home) : null;
	let cacheDirty = false;
	let changed = false;

	for (const issue of [...tracker.state.issues]) {
		if (issue.simulated || issue.closedAt) continue;
		if (typeof issue.status === "string" && issue.status.includes(ICONS.comment) &&
				Number.isFinite(issue.checkedAt) && issue.checkedAt > 0 && now - issue.checkedAt < issueCacheTtlMs) {
			continue;
		}

		let info = null;
		if (useSharedCache) {
			const entry = cache[issue.url];
			if (entry && ("info" in entry) && issue.checkedAt !== 0 && now - entry.checkedAt < (entry.ttlMs ?? issueCacheTtlMs)) {
				info = entry.info;
			} else if (entry?.refreshingUntil && entry.refreshingUntil > now) {
				continue;
			} else {
				cache[issue.url] = { ...(entry ?? {}), refreshingUntil: now + 8000 };
				writeIssueCache(cache, home);
				try {
					info = fetchIssueStatus(issue.url);
				} catch {
					info = null;
				}
				const stateName = String(info?.state ?? "").toUpperCase();
				const ttlMs = !info
					? 5_000
					: (stateName === "CLOSED" || stateName === "NOT_FOUND" ? ISSUE_CLOSED_TTL_MS : ISSUE_OPEN_TTL_MS);
				cache[issue.url] = { info, checkedAt: now, ttlMs, refreshingUntil: 0 };
				cacheDirty = true;
			}
		} else {
			try {
				info = fetchIssueStatus(issue.url);
			} catch {
				info = null;
			}
		}

		if (info && typeof info === "object") {
			const stateName = String(info.state ?? "").toUpperCase();
			if (stateName === "NOT_FOUND" || (stateName === "CLOSED" && String(info.stateReason ?? "").toUpperCase() === "NOT_PLANNED")) {
				tracker.manage("remove", issue.url);
				changed = true;
				continue;
			}
			if (stateName === "CLOSED") {
				const remoteClosedAt = info.closedAt ? Date.parse(info.closedAt) : NaN;
				if (!issue.closedAt && Number.isFinite(remoteClosedAt) && tracker.lastUserInputAt > 0 && remoteClosedAt < tracker.lastUserInputAt) {
					tracker.manage("remove", issue.url);
					changed = true;
					continue;
				}
				if (!issue.closedAt) {
					issue.closedAt = Number.isFinite(remoteClosedAt) ? remoteClosedAt : now;
					changed = true;
				}
				const closedStatus = `${ICONS.closed} Closed`;
				if (issue.status !== closedStatus) {
					issue.status = closedStatus;
					changed = true;
				}
				if (issue.checkedAt !== now) {
					issue.checkedAt = now;
					changed = true;
				}
				continue;
			}
			if (typeof info.title === "string" && info.title && issue.title !== info.title) {
				issue.title = info.title;
				changed = true;
			}
			const summary = summarizeIssueStatus(info);
			if (summary && issue.status !== summary) {
				issue.status = summary;
				changed = true;
			}
		}
		if ((info || !useSharedCache) && issue.checkedAt !== now) {
			issue.checkedAt = now;
			changed = true;
		}
	}
	if (cacheDirty && cache) writeIssueCache(cache, home);
	return changed;
}
