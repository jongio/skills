import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMergedPr, observeMergedPr } from "./lifecycle.mjs";

export const PR_RUNNING_TTL_MS = 20_000;
export const PR_SETTLED_TTL_MS = 45_000;
export const PR_CLOSED_TTL_MS = 120_000;

export function prContextFields(info) {
	if (!info || typeof info !== "object") return {};
	const headRepositoryUrl = info.headRepository?.url ?? info.headRepositoryUrl;
	const baseRepositoryUrl = info.baseRepository?.url ?? info.baseRepositoryUrl;
	const issueUrls = info.closingIssuesReferences?.nodes?.map((issue) => issue?.url) ?? info.issueUrls;
	return {
		...("headRefName" in info ? { headRefName: typeof info.headRefName === "string" ? info.headRefName : null } : {}),
		...("baseRefName" in info ? { baseRefName: typeof info.baseRefName === "string" ? info.baseRefName : null } : {}),
		...("baseRepository" in info || "baseRepositoryUrl" in info
			? { baseRepositoryUrl: typeof baseRepositoryUrl === "string" ? baseRepositoryUrl : null } : {}),
		...("headRepository" in info || "headRepositoryUrl" in info
			? { headRepositoryUrl: typeof headRepositoryUrl === "string" ? headRepositoryUrl : null } : {}),
		...(Array.isArray(issueUrls) ? { issueUrls: issueUrls.filter((url) => typeof url === "string") } : {}),
	};
}

function updatePrContext(pr, info, onlyMissing = false) {
	let changed = false;
	for (const [key, value] of Object.entries(prContextFields(info))) {
		if (onlyMissing && key in pr) continue;
		if (JSON.stringify(pr[key]) !== JSON.stringify(value)) {
			pr[key] = value;
			changed = true;
		}
	}
	return changed;
}

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

export function readPrCache(home) {
	try {
		return JSON.parse(readFileSync(join(home, "pr-statusline", "pr-cache.json"), "utf8"));
	} catch {
		return {};
	}
}

export function writePrCache(cache, home) {
	try {
		atomicWriteJson(join(home, "pr-statusline", "pr-cache.json"), cache);
	} catch {
		// Best-effort shared cache write.
	}
}

export const OCTICONS = {
	pr: "\uE726",
	merged: "\uE727",
	draft: "\uF4DD",
	pass: "\uF058",
	running: "\uF252",
	fail: "\uF057",
	approved: "\uF164",
	comment: "\uF075",
	conflict: "\uF071",
	changes: "\uF440",
};

export function summarizePrStatus(data) {
	if (!data || typeof data !== "object") return null;
	const state = String(data.state ?? "").toUpperCase();
	if (state === "CLOSED" || state === "NOT_FOUND") return state;
	if (state === "MERGED") return `${OCTICONS.merged} Merged`;
	const checks = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];
	let failed = 0;
	let running = 0;
	let passed = 0;
	for (const check of checks) {
		const conclusion = String(check?.conclusion ?? "").toUpperCase();
		const status = String(check?.status ?? "").toUpperCase();
		const checkState = String(check?.state ?? "").toUpperCase();
		if (["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"].includes(status) ||
				checkState === "PENDING" || (status && status !== "COMPLETED" && !conclusion)) {
			running++;
		} else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion) ||
				["FAILURE", "ERROR"].includes(checkState)) {
			failed++;
		} else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion) || checkState === "SUCCESS") {
			passed++;
		}
	}
	const totalChecks = passed + failed + running;
	const checkIcon = running > 0 ? OCTICONS.running : (failed > 0 ? OCTICONS.fail : OCTICONS.pass);

	const opinionated = Array.isArray(data.latestOpinionatedReviews?.nodes)
		? data.latestOpinionatedReviews.nodes.filter(Boolean)
		: [];
	const requestNodes = Array.isArray(data.reviewRequests?.nodes)
		? data.reviewRequests.nodes.filter(Boolean)
		: [];
	const reviewerKeys = new Set();
	let approvedCount = 0;
	for (let i = 0; i < opinionated.length; i++) {
		const node = opinionated[i];
		const key = node.author?.login || `review-${i}`;
		reviewerKeys.add(key);
		if (String(node.state ?? "").toUpperCase() === "APPROVED") approvedCount++;
	}
	for (let i = 0; i < requestNodes.length; i++) {
		const req = requestNodes[i]?.requestedReviewer;
		const key = req?.login || req?.slug || `req-${i}`;
		reviewerKeys.add(key);
	}
	if (Number.isInteger(data.approvals?.approved)) approvedCount = data.approvals.approved;
	else if (approvedCount === 0 && data.reviewDecision === "APPROVED") approvedCount = 1;
	let totalApprovals = Number.isInteger(data.approvals?.total)
		? data.approvals.total
		: reviewerKeys.size;
	if (totalApprovals < approvedCount) totalApprovals = approvedCount;
	if (totalApprovals === 0 && (data.reviewDecision === "REVIEW_REQUIRED" || data.reviewDecision === "CHANGES_REQUESTED")) {
		totalApprovals = 1;
	}

	const threadNodes = Array.isArray(data.reviewThreads?.nodes) ? data.reviewThreads.nodes : [];
	const totalThreads = Number.isInteger(data.reviewThreads?.total)
		? data.reviewThreads.total
		: (Number.isInteger(data.reviewThreads?.totalCount) ? data.reviewThreads.totalCount : threadNodes.length);
	const resolvedThreads = Number.isInteger(data.reviewThreads?.resolved)
		? data.reviewThreads.resolved
		: (Number.isInteger(data.reviewThreads?.unresolved)
			? Math.max(0, totalThreads - data.reviewThreads.unresolved)
			: threadNodes.filter((n) => n && n.isResolved === true).length);

	const tokens = [];
	if (data.isDraft) tokens.push(OCTICONS.draft);
	const failureDetail = running > 0 && failed > 0 ? ` (${failed} failed)` : "";
	tokens.push(`${checkIcon} ${passed}/${totalChecks}${failureDetail}`);
	if (data.mergeStateStatus === "DIRTY") tokens.push(OCTICONS.conflict);
	if (data.reviewDecision === "CHANGES_REQUESTED") tokens.push(OCTICONS.changes);
	tokens.push(`${OCTICONS.approved} ${approvedCount}/${totalApprovals}`);
	tokens.push(`${OCTICONS.comment} ${resolvedThreads}/${totalThreads}`);
	return tokens.join(" ");
}

const PR_STATUS_GRAPHQL = `query($owner:String!,$name:String!,$number:Int!){
	repository(owner:$owner,name:$name){
		pullRequest(number:$number){
			title
			headRefName
			headRepository{url}
			baseRefName
			baseRepository{url}
			closingIssuesReferences(first:100){nodes{url}}
			state
			mergedAt
			isDraft
			reviewDecision
			mergeStateStatus
			baseRef{
				branchProtectionRule{
					requiredStatusCheckContexts
				}
			}
			reviewRequests(first:50){
				nodes{
					requestedReviewer{
						... on User{login}
						... on Bot{login}
						... on Mannequin{login}
						... on Team{slug}
					}
				}
			}
			latestOpinionatedReviews(first:50){
				nodes{
					state
					author{login}
				}
			}
			reviewThreads(first:100){totalCount nodes{isResolved}}
			commits(last:1){
				nodes{
					commit{
						statusCheckRollup{
							contexts(first:100){
								nodes{
									... on CheckRun{name status conclusion}
									... on StatusContext{context state}
								}
							}
						}
					}
				}
			}
		}
	}
}`;

const BRANCH_PR_GRAPHQL = `query($owner:String!,$name:String!,$head:String!){
	repository(owner:$owner,name:$name){
		pullRequests(headRefName:$head,states:[OPEN],first:1){
			nodes{
				url
				title
				headRefName
				headRepository{url}
				baseRefName
				baseRepository{url}
				closingIssuesReferences(first:100){nodes{url}}
				state
				isDraft
				reviewDecision
				mergeStateStatus
				baseRef{
					branchProtectionRule{
						requiredStatusCheckContexts
					}
				}
				reviewRequests(first:50){
					nodes{
						requestedReviewer{
							... on User{login}
							... on Bot{login}
							... on Mannequin{login}
							... on Team{slug}
						}
					}
				}
				latestOpinionatedReviews(first:50){
					nodes{
						state
						author{login}
					}
				}
				reviewThreads(first:100){totalCount nodes{isResolved}}
				commits(last:1){
					nodes{
						commit{
							statusCheckRollup{
								contexts(first:100){
									nodes{
										... on CheckRun{name status conclusion}
										... on StatusContext{context state}
									}
								}
							}
						}
					}
				}
			}
		}
	}
}`;

function normalizeGraphqlPr(pr) {
	if (!pr || typeof pr !== "object") return null;
	const rollup = [...(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [])];
	const reported = new Set(rollup.map((n) => n?.name || n?.context).filter(Boolean));
	const required = pr.baseRef?.branchProtectionRule?.requiredStatusCheckContexts ?? [];
	for (const req of required) {
		if (req && !reported.has(req)) {
			rollup.push({ name: req, status: "PENDING", conclusion: null });
			reported.add(req);
		}
	}
	return {
		...prContextFields(pr),
		...(pr.url ? { url: pr.url } : {}),
		...(typeof pr.title === "string" && pr.title ? { title: pr.title } : {}),
		state: pr.state,
		...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
		isDraft: pr.isDraft,
		reviewDecision: pr.reviewDecision,
		mergeStateStatus: pr.mergeStateStatus,
		reviewRequests: pr.reviewRequests ?? { nodes: [] },
		latestOpinionatedReviews: pr.latestOpinionatedReviews ?? { nodes: [] },
		reviewThreads: pr.reviewThreads ?? { totalCount: 0, nodes: [] },
		statusCheckRollup: rollup,
	};
}


export async function queryPrStatusWithGh(url, { request, signal } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/|$)/.exec(parsed.pathname);
  if (!match) return null;
  request ??= (await import("../github-transport.mjs")).statuslineGitHub.request;
  const [, owner, name, number] = match;
  const response = await request({
    kind: "graphql", query: PR_STATUS_GRAPHQL,
    variables: { owner, name, number: Number(number) },
  }, parsed.hostname, { signal, target: url });
  if (!response.ok) {
    if (/Could not resolve to a PullRequest/i.test(response.error || "")) return { state: "NOT_FOUND" };
    throw Object.assign(new Error(response.error || "GitHub status unavailable"), { response });
  }
  const repository = response.data?.data?.repository;
  if (!repository || !Object.hasOwn(repository, "pullRequest")) throw new Error("GitHub response missing pull request data");
  const item = repository.pullRequest;
  if (item !== null && !["OPEN", "CLOSED", "MERGED"].includes(item?.state)) throw new Error("GitHub response has invalid pull request state");
  const info = item ? normalizeGraphqlPr(item) : { state: "NOT_FOUND" };
  Object.defineProperty(info, "cacheScope", { value: response.cacheScope });
  return info;
}

export async function queryBranchPrWithGh(repository, branch, { request, host = "github.com", signal } = {}) {
  const [owner, name] = String(repository ?? "").split("/");
  if (!owner || !name || !branch) return null;
  request ??= (await import("../github-transport.mjs")).statuslineGitHub.request;
  const response = await request({ kind: "graphql", query: BRANCH_PR_GRAPHQL, variables: { owner, name, head: branch } }, host,
    { signal, target: `branch:${host}/${repository}:${branch}` });
  if (!response.ok) throw Object.assign(new Error(response.error || "Branch PR discovery unavailable"), { response });
  const nodes = response.data?.data?.repository?.pullRequests?.nodes;
  if (!Array.isArray(nodes)) throw new Error("GitHub response missing branch PR inventory");
  if (nodes.some((item) => !["OPEN", "CLOSED", "MERGED"].includes(item?.state))) throw new Error("GitHub response has invalid branch PR state");
  const info = nodes.length ? normalizeGraphqlPr(nodes[0]) : { state: "NONE" };
  Object.defineProperty(info, "cacheScope", { value: response.cacheScope });
  return info;
}
export function refreshTrackedPrStatuses(tracker, {
	home,
	now = Date.now(),
	fetchPrStatus,
	prCacheTtlMs,
	force = false,
	prefetched = false,
	onError = (error) => { throw error; },
} = {}) {
	const useSharedCache = fetchPrStatus === undefined;
	if (!useSharedCache && typeof fetchPrStatus !== "function") return false;
	const cache = useSharedCache ? readPrCache(home) : null;
	let changed = false;

	for (const pr of [...tracker.state.prs]) {
		const cached = cache?.[pr.url];
		if (useSharedCache && cached?.lastError) {
			if (!pr.stale) { pr.stale = true; changed = true; }
			continue;
		}
		if (!force && updatePrContext(pr, cached?.info, (cached?.checkedAt ?? 0) < (pr.checkedAt ?? 0))) changed = true;
		if (pr.simulated) continue;
		const hasOcticonFormat = typeof pr.status === "string" &&
			pr.status.includes(OCTICONS.approved) &&
			pr.status.includes(OCTICONS.comment);
		const merged = isMergedPr(pr);
		const defaultTtl = merged ? PR_CLOSED_TTL_MS :
			(pr.status?.includes(OCTICONS.running) ? PR_RUNNING_TTL_MS : PR_SETTLED_TTL_MS);
		const effectiveTtl = prCacheTtlMs ?? defaultTtl;
		if (!force && !prefetched && (hasOcticonFormat || merged) && Number.isFinite(pr.checkedAt) && pr.checkedAt > 0 &&
				now - pr.checkedAt < effectiveTtl && !((cached?.checkedAt ?? 0) > pr.checkedAt)) continue;

		let info = null;
		let failure = null;
		if (useSharedCache) {
			const entry = cache[pr.url];
			const entrySummary = entry?.info ? summarizePrStatus(entry.info) : null;
			const validSummary = Boolean(
				entrySummary && (
					entrySummary.includes(OCTICONS.approved) ||
					entrySummary.includes(OCTICONS.merged) ||
					entrySummary === "CLOSED" ||
					entrySummary === "NOT_FOUND"
				),
			);
			const cacheFresh = entry && (validSummary || entry.info === null) && pr.checkedAt !== 0 &&
				now - entry.checkedAt < (prCacheTtlMs ?? entry.ttlMs ?? defaultTtl);
			if (!force && cacheFresh) {
				info = entry.info;
			} else if (!force && entry?.refreshingUntil && entry.refreshingUntil > now) {
				continue;
			} else {
				continue;
			}
		} else {
			try {
				info = fetchPrStatus(pr.url);
			} catch (error) {
				failure = error;
				info = null;
			}
		}
		const observedAt = prefetched && Number.isFinite(info?.observedAt) ? info.observedAt
			: useSharedCache && Number.isFinite(cached?.checkedAt) ? cached.checkedAt : now;
		if (info && (useSharedCache || info.observedFromCache) && Number.isFinite(pr.checkedAt) && observedAt < pr.checkedAt) continue;
		if (failure && !pr.stale) { pr.stale = true; changed = true; }
		if (info && pr.stale !== false) { pr.stale = false; changed = true; }
		if ((force || failure) && !info) {
			onError(new Error(`Could not refresh ${pr.label}: ${failure?.message ?? "GitHub returned no status."}`));
			continue;
		}

		if (info && typeof info === "object") {
			if (updatePrContext(pr, info)) changed = true;
			const stateName = String(info.state ?? "").toUpperCase();
			if (!force && (stateName === "CLOSED" || stateName === "NOT_FOUND")) {
				tracker.manage("remove", pr.url);
				changed = true;
				continue;
			}
			if (stateName === "MERGED") {
				const remoteMergedAt = info.mergedAt ? Date.parse(info.mergedAt) : NaN;
				if (observeMergedPr(pr, Math.max(now, tracker.lastUserInputAt), remoteMergedAt)) changed = true;
				const mergedStatus = `${OCTICONS.merged} Merged`;
				if (pr.status !== mergedStatus) {
					pr.status = mergedStatus;
					changed = true;
				}
				if (pr.checkedAt !== observedAt) {
					pr.checkedAt = observedAt;
					changed = true;
				}
				continue;
			}
			if (stateName === "OPEN" && (Number.isFinite(pr.mergedAt) || Number.isFinite(pr.mergedObservedAt))) {
				delete pr.mergedAt;
				delete pr.mergedObservedAt;
				changed = true;
			}
			if (typeof info.title === "string" && info.title && pr.title !== info.title) {
				pr.title = info.title;
				changed = true;
			}
			const summary = summarizePrStatus(info);
			if (summary && pr.status !== summary) {
				pr.status = summary;
				changed = true;
			}
		}
		if (info && pr.checkedAt !== observedAt) {
			pr.checkedAt = observedAt;
			changed = true;
		}
	}
	return changed;
}
