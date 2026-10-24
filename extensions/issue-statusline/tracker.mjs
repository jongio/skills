import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withStateLock } from "../state-lock.mjs";
import {
	atomicWriteJson,
	ICONS,
	ISSUE_CLOSED_TTL_MS,
	ISSUE_OPEN_TTL_MS,
	issueContextFields,
	queryIssueStatusWithGh,
	refreshTrackedIssueStatuses as refreshTrackedIssueStatusesImpl,
	summarizeIssueStatus,
} from "./github.mjs";

export {
	ICONS,
	ISSUE_CLOSED_TTL_MS,
	ISSUE_OPEN_TTL_MS,
	queryIssueStatusWithGh,
	summarizeIssueStatus,
};

const INITIAL_HEAD_BYTES = 64 * 1024;
const INITIAL_TAIL_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const RELEVANT_EVENT_LINE = /"type"\s*:\s*"(?:session\.(?:start|resume|context_changed)|user\.message|tool\.execution_(?:start|complete))"/;

export const configHome = () => process.env.COPILOT_HOME || join(homedir(), ".copilot");

export function statePath(sessionId, home = configHome()) {
	if (typeof sessionId !== "string" || !/^[\w-]{1,128}$/.test(sessionId)) {
		throw new Error("A valid session_id is required.");
	}
	return join(home, "issue-statusline", `${sessionId}.json`);
}

export function transcriptPathFor(sessionId, home = configHome(), explicitPath = null) {
	statePath(sessionId, home);
	if (typeof explicitPath === "string" && explicitPath.trim()) {
		const trimmed = explicitPath.trim();
		try {
			if (statSync(trimmed).isDirectory()) return join(trimmed, "events.jsonl");
		} catch {
			if (!trimmed.endsWith(".jsonl")) return join(trimmed, "events.jsonl");
		}
		return trimmed;
	}
	return join(home, "session-state", sessionId, "events.jsonl");
}

export function issueReference(reference) {
	if (typeof reference !== "string") throw new Error("Provide an issue URL or owner/repo#number.");
	const qualified = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(reference.trim());
	const url = new URL(qualified
		? `https://github.com/${qualified[1]}/issues/${qualified[2]}`
		: reference.trim());
	const match = /^\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
	if (url.protocol !== "https:" || url.username || url.password || url.port || !match) {
		throw new Error("Expected an HTTPS issue web URL or owner/repo#number.");
	}
	return {
		url: `https://${url.hostname}/${match[1]}/${match[2]}/issues/${match[3]}`,
		label: `${match[1]}/${match[2]}#${match[3]}`,
	};
}

export function readState(sessionId, home = configHome()) {
	let raw;
	try {
		raw = readFileSync(statePath(sessionId, home), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	const state = JSON.parse(raw);
	if (state.version !== 1 || state.sessionId !== sessionId ||
			!Array.isArray(state.issues) || !Array.isArray(state.ignored)) {
		throw new Error("Invalid issue statusline state.");
	}
	state.issues = state.issues.filter((item) => item.owned === true || item.simulated).map((item) => ({
		...issueReference(item.url),
		...issueContextFields(item),
		...(typeof item.title === "string" && item.title ? { title: item.title } : {}),
		...(typeof item.status === "string" && item.status ? { status: item.status } : {}),
		...(Number.isFinite(item.checkedAt) ? { checkedAt: item.checkedAt } : {}),
		...(Number.isFinite(item.closedAt) ? { closedAt: item.closedAt } : {}),
		...(item.simulated ? { simulated: true } : {}),
		...(item.owned === true ? { owned: true } : {}),
	}));
	state.ignored = state.ignored.map((url) => issueReference(url).url);
	return state;
}

export function writeState(state, home = configHome()) {
	return updateState(state.sessionId, (current) => {
		if ((current?.clearedAt ?? 0) > (state.clearedAt ?? 0)) return current;
		return state;
	}, home);
}

export function updateState(sessionId, update, home = configHome()) {
	return withStateLock(statePath(sessionId, home), () => {
		const state = update(readState(sessionId, home));
		atomicWriteJson(statePath(sessionId, home), state);
		return state;
	});
}

export class IssueTracker {
	constructor(sessionId, previous = null) {
		statePath(sessionId);
		this.state = {
			version: 1,
			activeTrackingVersion: 2,
			sessionId,
			clearedAt: previous?.clearedAt ?? 0,
			clearedWorkspace: previous?.clearedWorkspace ?? null,
			issues: (previous?.issues ?? []).filter((issue) => previous?.version !== 1 || issue.owned === true || issue.simulated)
				.map((issue) => ({ ...issue, ...(previous?.version !== 1 ? { owned: true } : {}) })),
			ignored: [...(previous?.ignored ?? [])],
			updatedAt: previous?.updatedAt ?? Date.now(),
			transcriptOffset: Number.isInteger(previous?.transcriptOffset) && previous.transcriptOffset >= 0
				? previous.transcriptOffset
				: 0,
		};
		this.repository = previous?.repository ?? null;
		this.host = previous?.host ?? "github.com";
		this.lastUserInputAt = Number.isFinite(previous?.lastUserInputAt) ? previous.lastUserInputAt : 0;
	}

	add(reference, explicit = false) {
		const item = issueReference(reference);
		if (explicit) this.state.ignored = this.state.ignored.filter((url) => url !== item.url);
		if (!this.state.ignored.includes(item.url) && !this.state.issues.some((i) => i.url === item.url)) {
			this.state.issues.push({ ...item, owned: true });
		}
		const existing = this.state.issues.find((issue) => issue.url === item.url);
		if (existing) existing.owned = true;
	}

	manage(action, reference) {
		if (action === "add") this.add(reference, true);
		else if (action === "remove") {
			const { url } = issueReference(reference);
			this.state.issues = this.state.issues.filter((i) => i.url !== url);
			if (!this.state.ignored.includes(url)) this.state.ignored.push(url);
		} else if (action === "clear") {
			this.state.ignored = [...new Set([...this.state.ignored, ...this.state.issues.map((i) => i.url)])];
			this.state.issues = [];
		} else if (action !== "list") throw new Error("Use add, remove, clear, or list.");
		return this.state.issues;
	}

	observe(event) {
		if (this.state.clearedAt && event.timestamp && Date.parse(event.timestamp) <= this.state.clearedAt) return;
		const data = event.data ?? {};
		if (event.type === "session.start" || event.type === "session.resume" || event.type === "session.context_changed") {
			const context = data.context ?? data;
			if (context.repository) this.repository = context.repository;
			if (context.repositoryHost) this.host = context.repositoryHost;
		}

		if (event.type === "user.message") {
			const content = String(data.content ?? "");
			const source = String(data.source ?? "");
			const isSkillInjection = source.startsWith("skill-") || content.trimStart().startsWith("<skill-context");
			const isAutomated = isSkillInjection ||
				Boolean(data.isAutopilotContinuation) ||
				source === "session-memory-rollover" ||
				content.trimStart().startsWith("[Scheduled prompt");
			if (!isAutomated) {
				const ts = event.timestamp ? Date.parse(event.timestamp) : NaN;
				const messageTime = Number.isFinite(ts) ? ts : Date.now();
				if (messageTime >= this.lastUserInputAt) this.lastUserInputAt = messageTime;
				for (const item of [...this.state.issues]) {
					const isClosed = Boolean(item.closedAt) || item.status?.includes(ICONS.closed);
					if (!item.simulated && isClosed && (!item.closedAt || messageTime >= item.closedAt)) {
						this.manage("remove", item.url);
					}
				}
			}
		}

		if (event.type === "tool.execution_start") {
			const args = data.arguments ?? {};
			const command = String(args.command ?? "");
			if (/\bgh\s+issue\s+(?:edit|comment|close|reopen|develop)\b/.test(command)) {
				for (const item of this.state.issues) {
					if (!item.simulated) item.checkedAt = 0;
				}
			}

		}
	}

	snapshot() {
		return {
			...this.state,
			updatedAt: Date.now(),
			repository: this.repository,
			host: this.host,
			lastUserInputAt: this.lastUserInputAt,
		};
	}
}

function observeChunk(tracker, fd, startOffset, length, skipFirstPartialLine = false) {
	if (length <= 0) return startOffset;
	const buffer = Buffer.allocUnsafe(Math.min(length, READ_CHUNK_BYTES));
	let position = startOffset, completed = startOffset;
	let fragments = [];
	while (position < startOffset + length) {
		const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, startOffset + length - position), position);
		if (bytesRead <= 0) break;
		const chunk = buffer.subarray(0, bytesRead);
		let from = 0;
		for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, from)) {
			completed = position + newline + 1;
			if (skipFirstPartialLine) skipFirstPartialLine = false;
			else {
				const part = chunk.subarray(from, newline);
				const line = (fragments.length ? Buffer.concat([...fragments, part]) : part).toString("utf8");
				if (line.trim() && RELEVANT_EVENT_LINE.test(line)) {
					try {
						const event = JSON.parse(line);
						tracker.observe(event);
					} catch {
						// Ignore malformed transcript lines.
					}
				}
			}
			fragments = [];
			from = newline + 1;
		}
		if (!skipFirstPartialLine && from < bytesRead) fragments.push(Buffer.from(chunk.subarray(from)));
		position += bytesRead;
	}
	return completed;
}

function inspectWorkspaceMetadata(tracker, sessionDir) {
	const wsPath = join(sessionDir, "workspace.yaml");
	if (!existsSync(wsPath)) return false;
	let changed = false;
	try {
		const raw = readFileSync(wsPath, "utf8");
		const repo = /^repository:\s*(\S+)\s*$/m.exec(raw)?.[1];
		if (repo && !tracker.repository) {
			tracker.repository = repo;
			changed = true;
		}
	} catch {
		// Ignore workspace.yaml read errors.
	}
	return changed;
}

export function refreshTrackedIssueStatuses(tracker, {
	home = configHome(),
	now = Date.now(),
	fetchIssueStatus = queryIssueStatusWithGh,
	issueCacheTtlMs,
	force = false,
	onError,
} = {}) {
	return refreshTrackedIssueStatusesImpl(tracker, { home, now, fetchIssueStatus, issueCacheTtlMs, force, onError });
}

export function syncSession(payload, {
	home = configHome(),
	now = Date.now(),
	fetchIssueStatus,
	issueCacheTtlMs,
} = {}) {
	const sessionId = payload?.session_id;
	const transcriptFile = transcriptPathFor(sessionId, home, payload?.transcript_path);
	let stat = null;
	try {
		const candidate = statSync(transcriptFile);
		if (candidate.isFile()) stat = candidate;
	} catch {
		stat = null;
	}
	const hasTranscript = stat !== null;
	const sessionDir = dirname(transcriptFile);
	const hasWorkspace = existsSync(join(sessionDir, "workspace.yaml"));
	let previous = null;
	try {
		previous = readState(sessionId, home);
	} catch (error) {
		if (!hasTranscript && !hasWorkspace) throw error;
		const path = statePath(sessionId, home);
		try {
			renameSync(path, `${path}.corrupt`);
		} catch {
			rmSync(path, { force: true });
		}
	}
	if (!hasTranscript && !hasWorkspace && !previous) return { state: null };

	const migrate = previous && previous.activeTrackingVersion !== 2;
	const reset = hasTranscript && (!previous || migrate || !Number.isInteger(previous.transcriptOffset) || previous.transcriptOffset > stat.size);
	const tracker = new IssueTracker(
		sessionId,
		reset && previous ? { issues: previous.issues, ignored: previous.ignored,
			clearedAt: previous.clearedAt, clearedWorkspace: previous.clearedWorkspace,
			...(previous.clearedAt ? { repository: previous.repository, host: previous.host, lastUserInputAt: previous.lastUserInputAt } : {}) } : previous,
	);
	let offset = reset ? 0 : tracker.state.transcriptOffset;
	let changed = Boolean(migrate) || (hasTranscript || hasWorkspace) && (!previous || reset);

	if ((hasTranscript || hasWorkspace) && inspectWorkspaceMetadata(tracker, sessionDir)) {
		changed = true;
	}

	if (hasTranscript && stat.size > offset) {
		const fd = openSync(transcriptFile, "r");
		try {
			let nextOffset = offset;
			if (!migrate && offset === 0 && stat.size > INITIAL_HEAD_BYTES + INITIAL_TAIL_BYTES) {
				observeChunk(tracker, fd, 0, INITIAL_HEAD_BYTES);
				const tailStart = stat.size - INITIAL_TAIL_BYTES;
				nextOffset = observeChunk(tracker, fd, tailStart, stat.size - tailStart, true);
			} else {
				nextOffset = observeChunk(tracker, fd, offset, stat.size - offset);
			}
			if (nextOffset !== offset) {
				tracker.state.transcriptOffset = nextOffset;
				changed = true;
			}
		} finally {
			closeSync(fd);
		}
	}

	const statusFetcher = typeof fetchIssueStatus === "function"
		? fetchIssueStatus
		: (fetchIssueStatus !== false && (hasTranscript || hasWorkspace) ? queryIssueStatusWithGh : null);
	if (statusFetcher && refreshTrackedIssueStatuses(tracker, { home, now, fetchIssueStatus: statusFetcher, issueCacheTtlMs })) {
		changed = true;
	}

	if (changed) {
		try {
			const latest = readState(sessionId, home);
			if ((latest?.clearedAt ?? 0) > tracker.state.clearedAt) return { state: latest };
			if (latest && (!previous || latest.updatedAt > (previous.updatedAt ?? 0))) {
				const byUrl = new Map(tracker.state.issues.map((i) => [i.url, i]));
				tracker.state.ignored = [...latest.ignored];
				tracker.state.issues = latest.issues
					.filter((i) => i.owned === true || i.simulated)
					.filter((i) => !tracker.state.ignored.includes(i.url))
					.map((i) => byUrl.get(i.url) ?? i);
			}
		} catch {
			// Ignore concurrent read error.
		}
	}

	let state = changed ? tracker.snapshot() : previous;
	if (changed && state) state = writeState(state, home);
	return { state };
}
