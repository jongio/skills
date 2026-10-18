import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";

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
		const data = event.data ?? {};
		const agentId = event.agentId || data.agentId || null;
		const sequence = ++this.sequence;
		if (["session.start", "session.resume", "session.context_changed"].includes(event.type)) {
			const context = data.context ?? data;
			const cwd = absoluteDirectory(context.cwd, null);
			if (cwd) {
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
			const cwd = commandDirectory(args.command, explicit ?? base) ?? explicit;
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

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function sessionDirectory(payload, { home = configHome() } = {}) {
	const fallback = absoluteDirectory(payload?.cwd, null);
	const id = payload?.session_id;
	if (!id) return { cwd: fallback, directories: fallback ? [fallback] : [], catchingUp: false };
	if (typeof id !== "string" || !/^[\w-]{1,128}$/.test(id)) throw new Error("A valid session_id is required.");
	let transcript = payload.transcript_path || join(home, "session-state", id, "events.jsonl");
	let stat;
	try {
		stat = statSync(transcript);
		if (stat.isDirectory()) {
			transcript = join(transcript, "events.jsonl");
			stat = statSync(transcript);
		}
	} catch (error) {
		if (error.code === "ENOENT") return { cwd: fallback, directories: fallback ? [fallback] : [], catchingUp: false };
		throw error;
	}
	if (!stat.isFile()) throw new Error("Expected a session transcript file.");
	const cachePath = join(home, "worktree-statusline", `${id}.json`);
	let previous;
	try {
		previous = readJson(cachePath);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		console.error("[worktree-statusline] Rebuilding malformed session cache from the transcript.");
		previous = null;
	}
	const identity = `${resolve(transcript)}:${stat.ino}:${stat.birthtimeMs}`;
	const valid = previous?.version === 3 && previous.identity === identity &&
		Number.isSafeInteger(previous.offset) && previous.offset >= 0 && previous.offset <= stat.size;
	const tracker = new WorktreeTracker(valid ? previous : {});
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
			version: 3, identity, offset, skipPartial, cwd: tracker.cwd,
			pending: Object.fromEntries(tracker.pending),
			sequence: tracker.sequence, appliedSequence: tracker.appliedSequence,
			directories: [...tracker.directories], agentCwds: Object.fromEntries(tracker.agentCwds),
			agentDirectories: Object.fromEntries([...tracker.agentDirectories].map(([id, paths]) => [id, [...paths]])),
		});
	}
	return {
		cwd: tracker.cwd ?? fallback, directories: [...tracker.directories], catchingUp,
		agentDirectories: Object.fromEntries([...tracker.agentDirectories].map(([id, paths]) => [id, [...paths]])),
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

export function gitContext(cwd, { run = spawnSync } = {}) {
	if (!cwd) return null;
	try {
		if (!statSync(cwd).isDirectory()) return null;
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
		throw error;
	}
	const options = {
		encoding: "utf8", timeout: 1500, maxBuffer: 64 * 1024, windowsHide: true,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
	};
	const result = run("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--git-common-dir", "--absolute-git-dir"], options);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		if (/not a git repository/i.test(result.stderr ?? "")) return null;
		throw new Error(`Cannot read Git context: ${String(result.stderr || `exit ${result.status}`).trim()}`);
	}
	const [root, commonDir, gitDir] = result.stdout.trim().split(/\r?\n/);
	if (!root || !commonDir || !gitDir) throw new Error("Incomplete Git context.");
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
	const remotes = run("git", ["-C", cwd, "config", "--get", "remote.origin.url"], options);
	if (remotes.error) throw remotes.error;
	if (remotes.status !== 0 && remotes.status !== 1) throw new Error("Cannot read Git remotes.");
	const remoteUrls = remotes.stdout.trim() ? [remotes.stdout.trim()] : [];
	return { cwd, root, branch: label, worktree, commonDir: checkoutKey(common), remoteUrls };
}

export function sessionContexts(payload, options = {}) {
	const location = sessionDirectory(payload, options);
	const contexts = new Map();
	const directoryKeys = new Map();
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
		const count = Math.min(directories.length, MAX_GIT_DIRECTORIES);
		for (let i = 0; i < count; i++) {
			const cwd = directories[(cursor + i) % directories.length];
			records.set(cwd, gitContext(cwd, options));
		}
		if (cachePath) writeJson(cachePath, {
			cursor: (cursor + count) % (directories.length || 1), records: Object.fromEntries(records),
		});
		for (const cwd of directories) {
			const context = records.get(cwd);
			if (!context) continue;
			const root = resolve(context.root);
			const key = checkoutKey(root);
			directoryKeys.set(checkoutKey(cwd), key);
			if (!contexts.has(key)) contexts.set(key, { ...context, root });
		}
	}
	const agentCheckouts = Object.fromEntries(Object.entries(location.agentDirectories ?? {}).map(([id, paths]) => [
		id, [...new Set(paths.map((path) => directoryKeys.get(checkoutKey(path)) ?? null))],
	]));
	return { ...location, contexts: [...contexts.values()], agentCheckouts };
}

export function describeSessionDirectory(payload, options) {
	const { cwd, contexts, catchingUp } = sessionContexts(payload, options);
	if (catchingUp) return "Branch/worktree statusline is replaying session context; retry after the next footer refresh.";
	return contexts.length
		? contexts.map((context) => `${context.root} [${context.branch}]`).join("\n")
		: `No Git checkout found for session directory: ${cwd ?? "unknown"}`;
}
