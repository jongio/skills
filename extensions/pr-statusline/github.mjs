import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PR_RUNNING_TTL_MS = 10_000;
export const PR_SETTLED_TTL_MS = 15_000;
export const PR_CLOSED_TTL_MS = 120_000;

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
		if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion) ||
				["FAILURE", "ERROR"].includes(checkState)) {
			failed++;
		} else if (["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"].includes(status) ||
				checkState === "PENDING" || (status && status !== "COMPLETED" && !conclusion)) {
			running++;
		} else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion) || checkState === "SUCCESS") {
			passed++;
		}
	}
	const totalChecks = passed + failed + running;
	const checkIcon = failed > 0 ? OCTICONS.fail : (running > 0 ? OCTICONS.running : OCTICONS.pass);

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
	tokens.push(`${checkIcon} ${passed}/${totalChecks}`);
	if (data.mergeStateStatus === "DIRTY") tokens.push(OCTICONS.conflict);
	if (data.reviewDecision === "CHANGES_REQUESTED") tokens.push(OCTICONS.changes);
	tokens.push(`${OCTICONS.approved} ${approvedCount}/${totalApprovals}`);
	tokens.push(`${OCTICONS.comment} ${resolvedThreads}/${totalThreads}`);
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

const PR_STATUS_GRAPHQL = `query($owner:String!,$name:String!,$number:Int!){
	repository(owner:$owner,name:$name){
		pullRequest(number:$number){
			title
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

export function queryPrStatusWithGh(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/|$)/.exec(parsed.pathname);
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
		`query=${PR_STATUS_GRAPHQL}`,
	];
	const res = runGhWithFallback(args);
	if (res.status !== 0) {
		const stderr = String(res.stderr ?? "");
		if (/Could not resolve to a PullRequest/i.test(stderr)) {
			return { state: "NOT_FOUND" };
		}
		return null;
	}
	if (!res.stdout) return null;
	try {
		const payload = JSON.parse(res.stdout);
		const pr = payload?.data?.repository?.pullRequest;
		return pr ? normalizeGraphqlPr(pr) : { state: "NOT_FOUND" };
	} catch {
		return null;
	}
}

export function queryBranchPrWithGh(repository, branch) {
	const [owner, repo] = String(repository ?? "").split("/");
	if (!owner || !repo || !branch) return null;
	const res = runGhWithFallback([
		"api",
		"graphql",
		"-F",
		`owner=${owner}`,
		"-F",
		`name=${repo}`,
		"-F",
		`head=${branch}`,
		"-f",
		`query=${BRANCH_PR_GRAPHQL}`,
	]);
	if (res.status !== 0 || !res.stdout) return null;
	try {
		const payload = JSON.parse(res.stdout);
		const nodes = payload?.data?.repository?.pullRequests?.nodes;
		return Array.isArray(nodes) && nodes.length > 0 ? normalizeGraphqlPr(nodes[0]) : { state: "NONE" };
	} catch {
		return null;
	}
}

export function refreshTrackedPrStatuses(tracker, {
	home,
	now = Date.now(),
	fetchPrStatus = queryPrStatusWithGh,
	prCacheTtlMs,
} = {}) {
	if (typeof fetchPrStatus !== "function") return false;
	const useSharedCache = fetchPrStatus === queryPrStatusWithGh;
	const cache = useSharedCache ? readPrCache(home) : null;
	let cacheDirty = false;
	let changed = false;

	for (const pr of [...tracker.state.prs]) {
		if (pr.simulated || pr.mergedAt) continue;
		const hasOcticonFormat = typeof pr.status === "string" &&
			pr.status.includes(OCTICONS.approved) &&
			pr.status.includes(OCTICONS.comment);
		const defaultTtl = pr.status?.includes(OCTICONS.running) ? PR_RUNNING_TTL_MS : PR_SETTLED_TTL_MS;
		const effectiveTtl = prCacheTtlMs ?? defaultTtl;
		if (hasOcticonFormat && Number.isFinite(pr.checkedAt) && pr.checkedAt > 0 && now - pr.checkedAt < effectiveTtl) continue;

		let info = null;
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
			if (cacheFresh) {
				info = entry.info;
			} else if (entry?.refreshingUntil && entry.refreshingUntil > now) {
				continue;
			} else {
				cache[pr.url] = { ...(entry ?? {}), refreshingUntil: now + 8000 };
				writePrCache(cache, home);
				try {
					info = fetchPrStatus(pr.url);
				} catch {
					info = null;
				}
				const stateName = String(info?.state ?? "").toUpperCase();
				const summary = info ? summarizePrStatus(info) : null;
				const ttlMs = !info
					? 5_000
					: stateName === "CLOSED" || stateName === "MERGED" || stateName === "NOT_FOUND"
						? PR_CLOSED_TTL_MS
						: (summary?.includes(OCTICONS.running) ? PR_RUNNING_TTL_MS : PR_SETTLED_TTL_MS);
				cache[pr.url] = { info, checkedAt: now, ttlMs, refreshingUntil: 0 };
				cacheDirty = true;
			}
		} else {
			try {
				info = fetchPrStatus(pr.url);
			} catch {
				info = null;
			}
		}

		if (info && typeof info === "object") {
			const stateName = String(info.state ?? "").toUpperCase();
			if (stateName === "CLOSED" || stateName === "NOT_FOUND") {
				tracker.manage("remove", pr.url);
				changed = true;
				continue;
			}
			if (stateName === "MERGED") {
				const remoteMergedAt = info.mergedAt ? Date.parse(info.mergedAt) : NaN;
				if (!pr.mergedAt && Number.isFinite(remoteMergedAt) && tracker.lastUserInputAt > 0 && remoteMergedAt < tracker.lastUserInputAt) {
					tracker.manage("remove", pr.url);
					changed = true;
					continue;
				}
				const effectiveMergedAt = Number.isFinite(remoteMergedAt) ? remoteMergedAt : now;
				if (!pr.mergedAt) {
					pr.mergedAt = effectiveMergedAt;
					changed = true;
				}
				const mergedStatus = `${OCTICONS.merged} Merged`;
				if (pr.status !== mergedStatus) {
					pr.status = mergedStatus;
					changed = true;
				}
				if (pr.checkedAt !== now) {
					pr.checkedAt = now;
					changed = true;
				}
				continue;
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
		if ((info || !useSharedCache) && pr.checkedAt !== now) {
			pr.checkedAt = now;
			changed = true;
		}
	}
	if (cacheDirty && cache) writePrCache(cache, home);
	return changed;
}

