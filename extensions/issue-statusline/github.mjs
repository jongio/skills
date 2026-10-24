import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ISSUE_OPEN_TTL_MS = 45_000;
export const ISSUE_CLOSED_TTL_MS = 120_000;

export function issueContextFields(info) {
	if (!info || typeof info !== "object") return {};
	const urls = info.closedByPullRequestsReferences?.nodes?.map((pr) => pr?.url) ?? info.prUrls;
	return Array.isArray(urls) ? { prUrls: urls.filter((url) => typeof url === "string") } : {};
}

function updateIssueContext(issue, info, onlyMissing = false) {
	const fields = issueContextFields(info);
	if (onlyMissing && "prUrls" in issue) return false;
	if (!("prUrls" in fields) || JSON.stringify(issue.prUrls) === JSON.stringify(fields.prUrls)) return false;
	issue.prUrls = fields.prUrls;
	return true;
}

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


export async function queryIssueStatusWithGh(url, { request, signal } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const match = /^\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)(?:\/|$)/.exec(parsed.pathname);
  if (!match) return null;
  request ??= (await import("../github-transport.mjs")).statuslineGitHub.request;
  const [, owner, name, number] = match;
  const response = await request({
    kind: "graphql", query: ISSUE_STATUS_GRAPHQL,
    variables: { owner, name, number: Number(number) },
  }, parsed.hostname, { signal, target: url });
  if (!response.ok) {
    if (/Could not resolve to an Issue/i.test(response.error || "")) return { state: "NOT_FOUND" };
    throw Object.assign(new Error(response.error || "GitHub status unavailable"), { response });
  }
  const repository = response.data?.data?.repository;
  if (!repository || !Object.hasOwn(repository, "issue")) throw new Error("GitHub response missing issue data");
  const item = repository.issue;
  if (item !== null && !["OPEN", "CLOSED"].includes(item?.state)) throw new Error("GitHub response has invalid issue state");
  const info = item ? { ...item } : { state: "NOT_FOUND" };
  Object.defineProperty(info, "cacheScope", { value: response.cacheScope });
  return info;
}
export function refreshTrackedIssueStatuses(tracker, {
	home,
	now = Date.now(),
	fetchIssueStatus,
	issueCacheTtlMs = ISSUE_OPEN_TTL_MS,
	force = false,
	prefetched = false,
	onError = (error) => { throw error; },
} = {}) {
	const useSharedCache = fetchIssueStatus === undefined;
	if (!useSharedCache && typeof fetchIssueStatus !== "function") return false;
	const cache = useSharedCache ? readIssueCache(home) : null;
	let changed = false;

	for (const issue of [...tracker.state.issues]) {
		const cached = cache?.[issue.url];
		if (useSharedCache && cached?.lastError) {
			if (!issue.stale) { issue.stale = true; changed = true; }
			continue;
		}
		if (!force && updateIssueContext(issue, cached?.info, (cached?.checkedAt ?? 0) < (issue.checkedAt ?? 0))) changed = true;
		if (issue.simulated || (!force && !prefetched && issue.closedAt)) continue;
		if (!force && !prefetched && typeof issue.status === "string" && issue.status.includes(ICONS.comment) &&
				Number.isFinite(issue.checkedAt) && issue.checkedAt > 0 && now - issue.checkedAt < issueCacheTtlMs) {
			continue;
		}

		let info = null;
		let failure = null;
		if (useSharedCache) {
			const entry = cache[issue.url];
			if (!force && entry && ("info" in entry) && issue.checkedAt !== 0 && now - entry.checkedAt < (entry.ttlMs ?? issueCacheTtlMs)) {
				info = entry.info;
			} else if (!force && entry?.refreshingUntil && entry.refreshingUntil > now) {
				continue;
			} else {
				continue;
			}
		} else {
			try {
				info = fetchIssueStatus(issue.url);
			} catch (error) {
				failure = error;
				info = null;
			}
		}
		const observedAt = prefetched && Number.isFinite(info?.observedAt) ? info.observedAt
			: useSharedCache && Number.isFinite(cached?.checkedAt) ? cached.checkedAt : now;
		if (info && (useSharedCache || info.observedFromCache) && Number.isFinite(issue.checkedAt) && observedAt < issue.checkedAt) continue;
		if (failure && !issue.stale) { issue.stale = true; changed = true; }
		if (info && issue.stale !== false) { issue.stale = false; changed = true; }
		if ((force || failure) && !info) {
			onError(new Error(`Could not refresh ${issue.label}: ${failure?.message ?? "GitHub returned no status."}`));
			continue;
		}

		if (info && typeof info === "object") {
			if (updateIssueContext(issue, info)) changed = true;
			const stateName = String(info.state ?? "").toUpperCase();
			if (!force && (stateName === "NOT_FOUND" || (stateName === "CLOSED" && String(info.stateReason ?? "").toUpperCase() === "NOT_PLANNED"))) {
				tracker.manage("remove", issue.url);
				changed = true;
				continue;
			}
			if (stateName === "CLOSED") {
				const remoteClosedAt = info.closedAt ? Date.parse(info.closedAt) : NaN;
				if (!force && !issue.closedAt && Number.isFinite(remoteClosedAt) && tracker.lastUserInputAt > 0 && remoteClosedAt < tracker.lastUserInputAt) {
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
				if (issue.checkedAt !== observedAt) {
					issue.checkedAt = observedAt;
					changed = true;
				}
				continue;
			}
			if (stateName === "OPEN" && issue.closedAt) {
				delete issue.closedAt;
				changed = true;
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
		if (info && issue.checkedAt !== observedAt) {
			issue.checkedAt = observedAt;
			changed = true;
		}
	}
	return changed;
}
