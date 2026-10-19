import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { repositoryKey } from "./grouping.mjs";
import { checkoutKey, configHome, gitContext, readJson, writeJson } from "./tracker.mjs";

const CACHE_TTL_MS = 30_000;
const MAX_REPOSITORY_QUERIES = 2;
const MAX_CHECKOUT_CHECKS = 4;
const matchesRepository = (context, repository) =>
	context.remoteUrls?.some((url) => repositoryKey(url) === repository);

export function parseWorktrees(output) {
	const records = [];
	let record = null;
	for (const field of output.split("\0")) {
		if (!field) {
			if (record?.root && record.branch && !record.unavailable && isAbsolute(record.root)) records.push(record);
			record = null;
		} else if (field.startsWith("worktree ")) record = { root: field.slice(9) };
		else if (record && field.startsWith("branch refs/heads/")) record.branch = field.slice(18);
		else if (record && /^(?:bare|prunable)(?: |$)/.test(field)) record.unavailable = true;
	}
	return records;
}

function inventory(context, run, force) {
	try {
		const result = run("git", ["-C", context.root, "worktree", "list", "--porcelain", "-z"], {
			encoding: "utf8", timeout: 1500, maxBuffer: 256 * 1024, windowsHide: true,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		});
		if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
			throw result.error ?? new Error(`Cannot list worktrees for ${context.root}: ${result.stderr || `exit ${result.status}`}`);
		}
		return { available: true, records: parseWorktrees(result.stdout) };
	} catch (error) {
		if (force) throw error;
		return { available: false, records: [] };
	}
}

export function resolveLinkedCheckouts(payload, checkouts, prs, {
	home = configHome(), now = Date.now(), run = spawnSync, force = false,
} = {}) {
	if (!/^[\w-]{1,128}$/.test(payload?.session_id ?? "")) return [];
	const requests = [];
	const repositories = new Map();
	for (const pr of prs) {
		const repository = repositoryKey(pr.headRepositoryUrl);
		if (!repository || typeof pr.headRefName !== "string" || !pr.headRefName) continue;
		if (checkouts.some((context) => context.branch === pr.headRefName && matchesRepository(context, repository))) continue;
		const known = checkouts.filter((context) => context.commonDir && matchesRepository(context, repository));
		if (!known.length) continue;
		const keys = [...new Set(known.map((context) => context.commonDir))];
		requests.push({ repository, branch: pr.headRefName, keys });
		for (const context of known) if (!repositories.has(context.commonDir)) repositories.set(context.commonDir, context);
	}
	if (!requests.length) return [];
	const path = join(home, "worktree-statusline", `${payload.session_id}.worktrees.json`);
	let cache;
	try {
		cache = readJson(path);
	} catch (error) {
		if (!(error instanceof SyntaxError)) {
			if (force) throw error;
			return [];
		}
		console.error("[worktree-statusline] Rebuilding malformed linked worktree cache.");
	}
	if (cache?.version !== 1 || !cache.repositories || !cache.contexts ||
		typeof cache.repositories !== "object" || typeof cache.contexts !== "object") {
		cache = { version: 1, repositories: {}, contexts: {}, cursor: 0, contextCursor: 0 };
	}
	const fresh = (entry) => Number.isFinite(entry?.checkedAt) && entry.checkedAt <= now && now - entry.checkedAt < CACHE_TTL_MS;
	let budget = force ? Infinity : Math.max(0, checkouts[0]?.remainingGitDirectories ?? 0);
	const known = [...repositories];
	const start = Number.isSafeInteger(cache.cursor) && cache.cursor >= 0 ? cache.cursor % known.length : 0;
	let visited = 0;
	let queries = 0;
	while (visited < known.length && (force || queries < MAX_REPOSITORY_QUERIES) && budget > 0) {
		const [key, context] = known[(start + visited++) % known.length];
		if (!force && fresh(cache.repositories[key])) continue;
		cache.repositories[key] = { ...inventory(context, run, force), checkedAt: now };
		queries++;
		budget--;
	}
	cache.cursor = (start + visited) % known.length;
	const candidates = new Map();
	for (const request of requests) {
		if (!request.keys.every((key) => fresh(cache.repositories[key]) && cache.repositories[key].available &&
			Array.isArray(cache.repositories[key].records))) continue;
		const matches = new Map();
		for (const key of request.keys) {
			for (const record of cache.repositories[key].records) {
				if (record.branch !== request.branch) continue;
				try {
					matches.set(checkoutKey(record.root), { ...record, commonDir: key, repository: request.repository });
				} catch {
					// Unreadable paths cannot establish a checkout association.
				}
			}
		}
		if (matches.size === 1) {
			const [key, record] = [...matches][0];
			candidates.set(key, record);
		}
	}
	const paths = [...candidates];
	const refreshed = new Set();
	if (paths.length) {
		const offset = Number.isSafeInteger(cache.contextCursor) && cache.contextCursor >= 0 ? cache.contextCursor % paths.length : 0;
		const count = force ? paths.length : Math.min(paths.length, MAX_CHECKOUT_CHECKS, budget);
		for (let i = 0; i < count; i++) {
			const [key, candidate] = paths[(offset + i) % paths.length];
			let context = null;
			try {
				context = gitContext(candidate.root, { run });
				if (force && !context) throw new Error(`Cannot refresh checkout ${candidate.root}.`);
			} catch (error) {
				if (force) throw error;
				// Leave this PR unassigned when live Git verification fails.
			}
			cache.contexts[key] = { checkedAt: now, context };
			refreshed.add(key);
		}
		cache.contextCursor = offset + count;
	}
	const found = [];
	for (const [key, candidate] of paths) {
		const verified = cache.contexts[key];
		const context = verified?.context;
		if (!fresh(verified) || !context || context.commonDir !== candidate.commonDir ||
			context.branch !== candidate.branch || !matchesRepository(context, candidate.repository)) continue;
		try {
			if (statSync(context.root).isDirectory()) found.push({ ...context, root: resolve(context.root), gitRefreshed: refreshed.has(key) });
		} catch (error) {
			if (force) throw error;
			// Removed or inaccessible checkouts stay on the unassigned row.
		}
	}
	try {
		writeJson(path, cache);
	} catch (error) {
		if (force) throw error;
		// Cache persistence is best-effort; verified in-memory matches remain usable.
	}
	return found;
}
