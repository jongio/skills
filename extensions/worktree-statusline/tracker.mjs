import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { withStateLock } from "../state-lock.mjs";
import { repositoryKey } from "./grouping.mjs";

const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_GIT_DIRECTORIES = 16;
const SHELL_TOOL = /(?:^|[._-])(?:powershell|bash|shell|exec_command)$/;
export const configHome = () => process.env.COPILOT_HOME || join(homedir(), ".copilot");

function absoluteDirectory(value, base) {
	if (typeof value !== "string" || !value.trim() || /[\x00-\x1f]/.test(value)) return null;
	if (isAbsolute(value) || win32.isAbsolute(value)) return value;
	if (!base) return null;
	return /^[a-z]:[\\/]|^\\\\/i.test(base) ? win32.resolve(base, value) : posix.resolve(base, value);
}

function unquote(value) {
	if (/^"[^"$`]*"$|^'[^']*'$/.test(value)) return value.slice(1, -1);
	return /^[^\s"'$`;&|<>()[\]{}]+$/.test(value) ? value : null;
}

export function commandDirectory(command, base) {
	if (typeof command !== "string") return null;
	// Parse literal leading directory changes only; never evaluate shell text.
	const change = /^\s*(?:Set-Location(?:\s+-(?:Literal)?Path)?|cd(?:\s+\/d)?|pushd)\s+("(?:[^"$`])*"|'[^']*'|[^\s;&|]+)\s*(?:;|&&|\r?\n|$)/i.exec(command);
	const git = /^\s*git\s+(?:--no-pager\s+)?-C\s+("[^"$`]*"|'[^']*'|[^\s;&|]+)\s+/i.exec(command);
	const literal = (change || git)?.[1];
	return literal ? absoluteDirectory(unquote(literal), base) : null;
}

export class WorktreeTracker {
	constructor(previous = {}) {
		this.clearedAt = previous.clearedAt ?? 0;
		this.dismissed = Boolean(previous.dismissed);
		this.cwd = previous.cwd ?? null;
		this.pending = new Map(Object.entries(previous.pending ?? {}));
		this.sequence = previous.sequence ?? 0;
		this.appliedSequence = previous.appliedSequence ?? 0;
		this.directories = new Set(previous.directories ?? []);
		this.agentCwds = new Map(Object.entries(previous.agentCwds ?? {}));
		this.agentDirectories = new Map(Object.entries(previous.agentDirectories ?? {}).map(([id, paths]) => [id, new Set(paths)]));
	}

	rememberAgentDirectory(id, cwd) {
		if (!this.agentDirectories.has(id)) this.agentDirectories.set(id, new Set());
		this.agentDirectories.get(id).add(cwd);
	}

	observe(event) {
		if (this.clearedAt && event.timestamp && Date.parse(event.timestamp) <= this.clearedAt) return;
		const data = event.data ?? {};
		const agentId = event.agentId || data.agentId || null;
		const sequence = ++this.sequence;
		if (["session.start", "session.resume", "session.context_changed"].includes(event.type)) {
			const context = data.context ?? data;
			const cwd = absoluteDirectory(context.cwd, null);
			if (cwd) {
				this.dismissed = false;
				this.directories.add(cwd);
				if (agentId) {
					this.agentCwds.set(agentId, { cwd, sequence });
					this.rememberAgentDirectory(agentId, cwd);
				} else {
					this.cwd = cwd;
					this.appliedSequence = sequence;
				}
			}
		}
		if (event.type === "tool.execution_start") {
			const args = data.arguments ?? {};
			const name = data.mcpToolName ?? data.toolName ?? "";
			if (!SHELL_TOOL.test(name) || !data.toolCallId) return;
			const base = agentId ? this.agentCwds.get(agentId)?.cwd : this.cwd;
			const explicit = absoluteDirectory(args.cwd ?? args.workdir ?? args.workingDirectory, base);
			const cwd = commandDirectory(args.command, explicit ?? base) ?? explicit ??
				(this.clearedAt && !this.directories.has(base) ? base : null);
			if (cwd) {
				this.pending.set(data.toolCallId, { cwd, sequence, agentId });
				if (this.pending.size > 128) this.pending.delete(this.pending.keys().next().value);
			}
		}
		if (event.type === "tool.execution_complete") {
			const pending = this.pending.get(data.toolCallId);
			this.pending.delete(data.toolCallId);
			const exitCode = data.result?.structuredContent?.exitCode;
			if (pending && data.success === true && (exitCode === undefined || exitCode === 0)) {
				this.dismissed = false;
				this.directories.add(pending.cwd);
				if (pending.agentId) {
					this.rememberAgentDirectory(pending.agentId, pending.cwd);
					const previous = this.agentCwds.get(pending.agentId);
					if (!previous || pending.sequence >= previous.sequence) {
						this.agentCwds.set(pending.agentId, { cwd: pending.cwd, sequence: pending.sequence });
					}
				} else if (pending.sequence >= this.appliedSequence) {
					this.cwd = pending.cwd;
					this.appliedSequence = pending.sequence;
				}
			}
		}
	}
}

export function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

export function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function sessionDirectory(payload, options = {}) {
	return withSessionDirectory(payload, (location) => location, options);
}

export function withSessionDirectory(payload, action, { home = configHome() } = {}) {
	const id = payload?.session_id;
	if (!id) return action(readSessionDirectory(payload, { home }));
	if (typeof id !== "string" || !/^[\w-]{1,128}$/.test(id)) throw new Error("A valid session_id is required.");
	return withStateLock(join(home, "worktree-statusline", `${id}.json`), () => action(readSessionDirectory(payload, { home })));
}

export function transcriptIdentity(path, stat) {
	return `${resolve(path)}:${stat.ino}:${stat.birthtimeMs}`;
}

function readSessionDirectory(payload, { home }) {
	const fallback = absoluteDirectory(payload?.cwd, null);
	const id = payload?.session_id;
	if (!id) return { cwd: fallback, directories: fallback ? [fallback] : [], catchingUp: false };
	if (typeof id !== "string" || !/^[\w-]{1,128}$/.test(id)) throw new Error("A valid session_id is required.");
	const cachePath = join(home, "worktree-statusline", `${id}.json`);
	let previous;
	try {
		previous = readJson(cachePath);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		console.error("[worktree-statusline] Rebuilding malformed session cache from the transcript.");
		previous = null;
	}
	let transcript = payload.transcript_path || join(home, "session-state", id, "events.jsonl");
	let stat;
	try {
		stat = statSync(transcript);
		if (stat.isDirectory()) {
			transcript = join(transcript, "events.jsonl");
			stat = statSync(transcript);
		}
	} catch (error) {
		if (error.code === "ENOENT") return previous?.clearedAt
			? { cwd: null, directories: [], catchingUp: false }
			: { cwd: fallback, directories: fallback ? [fallback] : [], catchingUp: false };
		throw error;
	}
	if (!stat.isFile()) throw new Error("Expected a session transcript file.");
	const identity = transcriptIdentity(transcript, stat);
	const valid = previous?.version === 3 && previous.identity === identity &&
		Number.isSafeInteger(previous.offset) && previous.offset >= 0 && previous.offset <= stat.size;
	const baseline = previous?.clearedContext ?? previous;
	const tracker = new WorktreeTracker(valid ? previous : {
		clearedAt: previous?.clearedAt, dismissed: Boolean(previous?.clearedAt), cwd: previous?.clearedAt ? baseline.cwd : null,
		agentCwds: previous?.clearedAt ? baseline.agentCwds : {},
		sequence: previous?.clearedAt ? baseline.sequence : 0,
		appliedSequence: previous?.clearedAt ? baseline.appliedSequence : 0,
	});
	let offset = valid ? previous.offset : 0;
	let skipPartial = valid && previous.skipPartial === true;
	let catchingUp = false;
	if (stat.size > offset || !valid) {
		const fd = openSync(transcript, "r");
		try {
			const bytes = Buffer.allocUnsafe(Math.min(MAX_READ_BYTES, stat.size - offset));
			const length = readSync(fd, bytes, 0, bytes.length, offset);
			const chunk = bytes.subarray(0, length);
			const end = chunk.lastIndexOf(0x0a);
			if (end >= 0) {
				const start = skipPartial ? chunk.indexOf(0x0a) + 1 : 0;
				for (const line of chunk.subarray(start, end + 1).toString("utf8").split("\n")) {
					if (!/"type"\s*:\s*"(?:session\.(?:start|resume|context_changed)|tool\.execution_(?:start|complete))"/.test(line)) continue;
					let event;
					try {
						event = JSON.parse(line);
					} catch (error) {
						if (error instanceof SyntaxError) continue;
						throw error;
					}
					if (event && typeof event === "object") tracker.observe(event);
				}
				offset += end + 1;
				skipPartial = false;
			} else if (length === MAX_READ_BYTES) {
				// Skip oversized event lines without growing memory or stalling replay.
				offset += length;
				skipPartial = true;
			}
			catchingUp = length === MAX_READ_BYTES && offset < stat.size;
		} finally {
			closeSync(fd);
		}
		writeJson(cachePath, {
			version: 3, identity, offset, skipPartial, cwd: tracker.cwd, clearedAt: tracker.clearedAt, dismissed: tracker.dismissed,
			clearedContext: previous?.clearedContext,
			pending: Object.fromEntries(tracker.pending),
			sequence: tracker.sequence, appliedSequence: tracker.appliedSequence,
			directories: [...tracker.directories], agentCwds: Object.fromEntries(tracker.agentCwds),
			agentDirectories: Object.fromEntries([...tracker.agentDirectories].map(([id, paths]) => [id, [...paths]])),
		});
	}
	const cwd = tracker.clearedAt && !tracker.directories.has(tracker.cwd) ? null : tracker.cwd;
	return {
		cwd: tracker.dismissed ? null : cwd ?? (tracker.clearedAt ? null : fallback),
		directories: [...tracker.directories], catchingUp,
		agentDirectories: Object.fromEntries([...tracker.agentDirectories].map(([id, paths]) => [id, [...paths]])),
		agentCwds: Object.fromEntries(tracker.agentCwds),
	};
}

export function checkoutKey(root) {
	let path = resolve(root);
	try {
		path = realpathSync.native(path);
	} catch (error) {
		if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
	}
	return process.platform === "win32" ? path.toLowerCase() : path;
}

export function dirtyMarkers(porcelain) {
	let unstaged = false, staged = false, untracked = false;
	const records = porcelain.split("\0");
	for (let i = 0; i < records.length; i++) {
		const entry = records[i];
		if (entry.startsWith("?? ")) { untracked = true; continue; }
		if (entry.length < 4 || entry[2] !== " " || entry.startsWith("!! ")) continue;
		staged ||= entry[0] !== " ";
		unstaged ||= entry[1] !== " ";
		if (/[RC]/.test(entry.slice(0, 2))) i++;
	}
	return `${unstaged ? "*" : ""}${staged ? "+" : ""}${untracked ? "%" : ""}`;
}

export function checkoutLabel(context) {
	const safe = (value) => String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "");
	const { upstream, base } = context.divergence ?? {};
	const indicator = (entry, onlyBehind = false) => {
		if (!entry) return "";
		const counts = entry.ahead === null || entry.behind === null ? "?"
			: `${!onlyBehind && entry.ahead ? `↑${entry.ahead}` : ""}${entry.behind ? `↓${entry.behind}` : ""}`;
		return counts ? ` ${safe(entry.target)}${counts}` : "";
	};
	return `${safe(context.root)} [⎇ ${safe(context.branch)}${safe(context.dirty ?? "")}${indicator(upstream)}${base?.target === upstream?.target ? "" : indicator(base, true)}]`;
}

const gitOptions = () => ({
	encoding: "utf8", timeout: 1500, maxBuffer: 64 * 1024, windowsHide: true,
	env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" },
});

function configuredRefs(output, branch) {
	const remotes = new Map();
	const upstream = { remotes: [], merges: [] };
	for (const record of output.split("\0")) {
		const newline = record.indexOf("\n");
		if (newline < 0) continue;
		const key = record.slice(0, newline), value = record.slice(newline + 1);
		const match = /^remote\.(.+)\.(url|fetch)$/.exec(key);
		if (match) {
			if (!remotes.has(match[1])) remotes.set(match[1], { name: match[1], urls: [], fetch: [] });
			remotes.get(match[1])[match[2] === "url" ? "urls" : "fetch"].push(value);
		} else if (branch !== null && key === `branch.${branch}.remote`) upstream.remotes.push(value);
		else if (branch !== null && key === `branch.${branch}.merge`) upstream.merges.push(value);
	}
	return { remotes: [...remotes.values()], upstream };
}

function localRef(ref) {
	return typeof ref === "string" && /^refs\/(?:heads|remotes)\/.+/.test(ref) &&
		!(/[\x00-\x20\x7f~^:?*[\]\\]|\.\.|@\{|\/\/|(?:^|\/)\.|\.(?:lock)?(?:\/|$)|\/$/.test(ref));
}

function refspecMatch(pattern, ref) {
	const parts = pattern.split("*");
	if (parts.length === 1) return pattern === ref ? "" : null;
	if (parts.length !== 2 || ref.length < parts[0].length + parts[1].length ||
		!ref.startsWith(parts[0]) || !ref.endsWith(parts[1])) return null;
	return ref.slice(parts[0].length, ref.length - parts[1].length);
}

function unambiguousRef(ref, remote, remotes) {
	return !remotes.some((other) => other !== remote && other.fetch.some((spec) => {
		const destination = spec.replace(/^\+/, "").split(":")[1];
		return destination && refspecMatch(destination, ref) !== null;
	}));
}

function mappedTarget(remote, branch, remotes = []) {
	const target = `${remote?.name ? `${remote.name}/` : ""}${branch}`;
	if (!remote || branch.startsWith("-") || !localRef(`refs/heads/${branch}`)) return { target };
	const source = `refs/heads/${branch}`;
	const matches = [];
	for (const spec of remote.fetch) {
		// Exclusions and nonstandard mappings must not silently select a stale ref.
		if (spec.startsWith("^")) return { target };
		const [from, to, extra] = spec.replace(/^\+/, "").split(":");
		if (!to || extra) continue;
		const capture = refspecMatch(from, source);
		if (capture !== null && from.split("*").length === to.split("*").length) matches.push(to.replace("*", capture));
	}
	const refs = [...new Set(matches)];
	return refs.length === 1 && localRef(refs[0]) && unambiguousRef(refs[0], remote, remotes)
		? { target: refs[0].replace(/^refs\/(?:remotes|heads)\//, ""), ref: refs[0] } : { target };
}

export function checkoutDivergence(context, prs = [], { run = spawnSync, force = false } = {}) {
	const read = (args) => {
		if (context.gitRefreshed === false) return null;
		try {
			const result = run("git", ["-C", context.root, ...args], gitOptions());
			if (!result.error && result.status === 1 && args[0] === "symbolic-ref") return "";
			if (force && (result.error || result.status !== 0 || typeof result.stdout !== "string")) {
				throw result.error ?? new Error(`Cannot compare Git refs for ${context.root}: ${result.stderr || `exit ${result.status}`}`);
			}
			return !result.error && result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : null;
		} catch (error) {
			if (force) throw error;
			return null;
		}
	};
	const remotes = context.remotes ?? [];
	const config = context.upstream;
	let upstream = null;
	if (config?.remotes.length || config?.merges.length) {
		const branch = (config.merges[0] ?? "").replace(/^refs\/heads\//, "");
		upstream = config.remotes.length !== 1 || config.merges.length !== 1 ? { target: "upstream" }
			: config.remotes[0] === "." ? { target: branch, ...(localRef(config.merges[0]) ? { ref: config.merges[0] } : {}) }
			: mappedTarget(remotes.find((remote) => remote.name === config.remotes[0]) ?? { name: config.remotes[0], fetch: [] }, branch, remotes);
	}
	const matches = prs.filter((pr) => pr.headRefName === context.branch && repositoryKey(pr.headRepositoryUrl) &&
		context.remoteUrls?.some((url) => repositoryKey(url) === repositoryKey(pr.headRepositoryUrl)));
	let base = null;
	if (matches.length) {
		const targets = new Set(matches.map((pr) => JSON.stringify([pr.baseRefName, repositoryKey(pr.baseRepositoryUrl)])));
		const pr = matches[0], repository = repositoryKey(pr.baseRepositoryUrl);
		const candidates = remotes.filter((remote) => remote.urls.length &&
			remote.urls.every((url) => repositoryKey(url) === repository));
		base = targets.size !== 1 || !pr.baseRefName || !repository ? { target: "base" }
			: candidates.length === 1 ? mappedTarget(candidates[0], pr.baseRefName, remotes) : { target: pr.baseRefName };
	} else {
		const remote = remotes.find((item) => item.name === config?.remotes[0]) ??
			remotes.find((item) => item.name === "origin") ?? (remotes.length === 1 ? remotes[0] : null);
		if (remote) {
			const symbolic = `refs/remotes/${remote.name}/HEAD`;
			const ref = localRef(symbolic) ? read(["symbolic-ref", "--quiet", symbolic]) : null;
			if (ref !== "") base = ref && localRef(ref) && ref.startsWith(`refs/remotes/${remote.name}/`) &&
				ref !== symbolic && unambiguousRef(ref, remote, remotes)
				? { target: ref.slice(13), ref } : { target: `${remote.name}/HEAD` };
		}
	}
	const compare = (entry) => {
		if (!entry) return null;
		const output = entry.ref ? read(["rev-list", "--left-right", "--count", `HEAD...${entry.ref}`, "--"]) : null;
		const counts = /^(\d+)\s+(\d+)$/.exec(output ?? "");
		const values = counts ? counts.slice(1).map(Number) : [];
		if (force && entry.ref && (!values.length || !values.every(Number.isSafeInteger))) {
			throw new Error(`Invalid Git divergence counts for ${context.root}.`);
		}
		return { target: entry.target, ahead: values.length && values.every(Number.isSafeInteger) ? values[0] : null,
			behind: values.length && values.every(Number.isSafeInteger) ? values[1] : null };
	};
	const result = compare(upstream);
	return { upstream: result, base: base?.ref && base.ref === upstream?.ref ? result : compare(base) };
}

export function gitContext(cwd, { run = spawnSync, contextCache } = {}) {
	if (!cwd) return null;
	try {
		if (!statSync(cwd).isDirectory()) return null;
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
		throw error;
	}
	const directoryKey = contextCache ? checkoutKey(cwd) : null;
	const existing = contextCache?.get(directoryKey);
	if (existing) return { ...existing, cwd };
	const options = gitOptions();
	const result = run("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--git-common-dir", "--absolute-git-dir"], options);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		if (/not a git repository/i.test(result.stderr ?? "")) return null;
		throw new Error(`Cannot read Git context: ${String(result.stderr || `exit ${result.status}`).trim()}`);
	}
	const [root, commonDir, gitDir] = result.stdout.trim().split(/\r?\n/);
	if (!root || !commonDir || !gitDir) throw new Error("Incomplete Git context.");
	const rootKey = contextCache ? checkoutKey(root) : null;
	const cachedRoot = contextCache?.get(rootKey);
	if (cachedRoot) {
		const context = { ...cachedRoot, cwd };
		contextCache.set(directoryKey, context);
		return context;
	}
	const branch = run("git", ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"], options);
	if (branch.error) throw branch.error;
	let label = branch.stdout.trim();
	if (branch.status === 1) {
		const commit = run("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], options);
		if (commit.error) throw commit.error;
		if (commit.status !== 0) throw new Error("Cannot read detached Git commit.");
		label = `detached@${commit.stdout.trim()}`;
	} else if (branch.status !== 0 || !label) {
		throw new Error(`Cannot read Git branch: ${String(branch.stderr || `exit ${branch.status}`).trim()}`);
	}
	const common = resolve(cwd, commonDir);
	const checkoutGit = resolve(gitDir);
	const worktree = process.platform === "win32" ? common.toLowerCase() !== checkoutGit.toLowerCase() : common !== checkoutGit;
	const remotes = run("git", ["-C", cwd, "config", "--null", "--get-regexp", "^(remote\\..*\\.(url|fetch)|branch\\..*\\.(remote|merge))$"], options);
	if (remotes.error) throw remotes.error;
	if (remotes.status !== 0 && remotes.status !== 1) throw new Error("Cannot read Git remotes.");
	const refs = configuredRefs(remotes.stdout, branch.status === 0 ? label : null);
	const remoteUrls = refs.remotes.find((remote) => remote.name === "origin")?.urls.slice(-1) ?? [];
	const status = run("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"], options);
	if (status.error) throw status.error;
	if (status.status !== 0) throw new Error("Cannot read Git status.");
	const context = { cwd, root, branch: label, worktree, commonDir: checkoutKey(common), remoteUrls, ...refs, dirty: dirtyMarkers(status.stdout) };
	if (contextCache) {
		contextCache.set(rootKey, context);
		contextCache.set(directoryKey, context);
	}
	return context;
}

export function sessionContexts(payload, options = {}) {
	const contextCache = options.contextCache ?? new Map();
	const location = sessionDirectory(payload, options);
	const contexts = new Map();
	const refreshedDirectories = new Set();
	const directoryKeys = new Map();
	let remainingGitDirectories = MAX_GIT_DIRECTORIES;
	if (!location.catchingUp) {
		const directories = [...new Set([location.cwd, ...location.directories].filter(Boolean).map((cwd) => resolve(cwd)))];
		const cachePath = payload?.session_id
			? join(options.home ?? configHome(), "worktree-statusline", `${payload.session_id}.contexts.json`) : null;
		let cached = null;
		try {
			cached = cachePath ? readJson(cachePath) : null;
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			console.error("[worktree-statusline] Rebuilding malformed Git context cache.");
		}
		const records = new Map(Object.entries(cached?.records ?? {}).filter(([cwd]) => directories.includes(cwd)));
		const cursor = Number.isSafeInteger(cached?.cursor) && cached.cursor >= 0 ? cached.cursor % (directories.length || 1) : 0;
		const reserved = options.reserveGitDirectories === 4 ? 4 : 0;
		const count = options.force ? directories.length : Math.min(directories.length, MAX_GIT_DIRECTORIES - reserved);
		for (let i = 0; i < count; i++) {
			const cwd = directories[(cursor + i) % directories.length];
			records.set(cwd, gitContext(cwd, { ...options, contextCache }));
			refreshedDirectories.add(cwd);
		}
		remainingGitDirectories -= count;
		if (cachePath) writeJson(cachePath, {
			cursor: (cursor + count) % (directories.length || 1), records: Object.fromEntries(records),
		});
		for (const cwd of directories) {
			const context = records.get(cwd);
			if (!context) continue;
			const root = resolve(context.root);
			const key = checkoutKey(root);
			directoryKeys.set(checkoutKey(cwd), key);
			if (!contexts.has(key)) contexts.set(key, { ...context, root, gitRefreshed: refreshedDirectories.has(cwd) });
			else if (refreshedDirectories.has(cwd)) contexts.set(key, { ...context, root, gitRefreshed: true });
		}
	}
	const agentCheckouts = Object.fromEntries(Object.entries(location.agentDirectories ?? {}).map(([id, paths]) => [
		id, [...new Set(paths.map((path) => directoryKeys.get(checkoutKey(path)) ?? null))],
	]));
	const agentCurrentCheckouts = Object.fromEntries(Object.entries(location.agentCwds ?? {}).map(([id, value]) => [
		id, directoryKeys.get(checkoutKey(value.cwd)) ?? null,
	]));
	const focusKey = location.cwd ? directoryKeys.get(checkoutKey(location.cwd)) : null;
	return { ...location, contexts: [...contexts.values()], agentCheckouts, agentCurrentCheckouts, focusKey, remainingGitDirectories };
}

export function describeSessionDirectory(payload, options) {
	const { cwd, contexts, catchingUp } = sessionContexts(payload, options);
	if (catchingUp) return "Branch/worktree statusline is replaying session context; retry after the next footer refresh.";
	return contexts.length
		? contexts.map((context) => checkoutLabel({ ...context, divergence: checkoutDivergence(context, [], options) })).join("\n")
		: `No Git checkout found for session directory: ${cwd ?? "unknown"}`;
}
