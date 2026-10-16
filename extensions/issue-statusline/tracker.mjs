import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	atomicWriteJson,
	ICONS,
	ISSUE_CLOSED_TTL_MS,
	ISSUE_OPEN_TTL_MS,
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
const PLACEHOLDER_REPOS = new Set([
	"owner/repo",
	"org/repo",
	"o/r",
	"your-org/your-repo",
	"example/repo",
	"octo/api",
	"octocat/hello-world",
	"project/repo",
	"org/project",
	"test-owner/test-repo",
	"foo/bar",
	"backup/check",
	"myorg/repo",
	"secretorg/secretrepo",
	"fixture/reference",
]);
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

function extractIssues(text, repository = null, host = "github.com") {
	const source = String(text ?? "");
	const found = [];
	const push = (ref) => {
		try {
			const item = issueReference(ref);
			if (!PLACEHOLDER_REPOS.has(item.label.split("#")[0].toLowerCase())) found.push(item);
		} catch {
			// Ignore invalid references.
		}
	};
	for (const [url] of source.matchAll(/https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*/g)) {
		push(url);
	}
	for (const match of source.matchAll(/\b(?:issue|bug|feature|triage|work\s+on|fix(?:es|ed)?|close[sd]?|resolve[sd]?)\b[^\r\n]{0,40}?\b([\w.-]+\/[\w.-]+#[1-9]\d*)\b/gi)) {
		push(match[1]);
	}
	if (repository && !PLACEHOLDER_REPOS.has(repository.toLowerCase())) {
		for (const match of source.matchAll(/\b(?:issue|fix(?:es|ed)?|close[sd]?|resolve[sd]?)[ \t]+#([1-9]\d*)\b/gi)) {
			push(`https://${host}/${repository}/issues/${match[1]}`);
		}
	}
	return found;
}

function extractGhIssueNumber(command) {
	const match = /\bgh(?:\s+(?:(?:-R|--repo)(?:=|\s+)\S+|-C\s+\S+))*\s+issue\s+(?:view|edit|comment|close|reopen|develop|create)\b([^;&|\r\n]*)/.exec(command);
	if (!match) return null;
	const tokens = match[1].trim().split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i].replace(/^["']|["']$/g, "");
		if (token === "--") continue;
		if (/^(?:-R|--repo|-t|--title|-b|--body|-F|--body-file|-a|--assignee|-l|--label|-p|--project|-m|--milestone|-jq|--jq|--template|-b|--branch)$/.test(token)) {
			i++;
			continue;
		}
		if (token.startsWith("-")) continue;
		if (/^[1-9]\d*$/.test(token)) return token;
	}
	return null;
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
	state.issues = state.issues.map((item) => ({
		...issueReference(item.url),
		...(typeof item.title === "string" && item.title ? { title: item.title } : {}),
		...(typeof item.status === "string" && item.status ? { status: item.status } : {}),
		...(Number.isFinite(item.checkedAt) ? { checkedAt: item.checkedAt } : {}),
		...(Number.isFinite(item.closedAt) ? { closedAt: item.closedAt } : {}),
		...(item.simulated ? { simulated: true } : {}),
	}));
	state.ignored = state.ignored.map((url) => issueReference(url).url);
	return state;
}

export function writeState(state, home = configHome()) {
	atomicWriteJson(statePath(state.sessionId, home), state);
}

export class IssueTracker {
	constructor(sessionId, previous = null) {
		statePath(sessionId);
		this.state = {
			version: 1,
			sessionId,
			issues: [...(previous?.issues ?? [])],
			ignored: [...(previous?.ignored ?? [])],
			updatedAt: previous?.updatedAt ?? Date.now(),
			transcriptOffset: Number.isInteger(previous?.transcriptOffset) && previous.transcriptOffset >= 0
				? previous.transcriptOffset
				: 0,
		};
		this.repository = previous?.repository ?? null;
		this.host = previous?.host ?? "github.com";
		this.lastUserInputAt = Number.isFinite(previous?.lastUserInputAt) ? previous.lastUserInputAt : 0;
		this.calls = new Map(Object.entries(previous?.calls ?? {}));
	}

	add(reference, explicit = false) {
		const item = issueReference(reference);
		if (PLACEHOLDER_REPOS.has(item.label.split("#")[0].toLowerCase())) return;
		if (explicit) this.state.ignored = this.state.ignored.filter((url) => url !== item.url);
		if (!this.state.ignored.includes(item.url) && !this.state.issues.some((i) => i.url === item.url)) {
			this.state.issues.push(item);
		}
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
			if (!isSkillInjection && !/\btriage\b/i.test(content)) {
				for (const item of extractIssues(content, this.repository, this.host)) {
					this.add(item.url);
				}
			}
			for (const attachment of data.attachments ?? []) {
				if (attachment.type === "github_reference" && attachment.referenceType === "issue") {
					this.add(attachment.url);
				}
			}
		}

		if (event.type === "tool.execution_start") {
			const args = data.arguments ?? {};
			const name = data.mcpToolName ?? data.toolName ?? "";
			const command = String(args.command ?? "");
			const safeSessionId = this.state.sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const otherSessionState = new RegExp(`\\.copilot[\\\\/]session-state(?:[\\\\/](?!${safeSessionId}\\b)|$)`, "i");
			const isDiagnostic = /\.copilot[\\/](?:pr-statusline|issue-statusline|subagent-statusline)\b|events\.jsonl\b|smoke\.test\.mjs\b/i.test(command) ||
				otherSessionState.test(command);
			if (isDiagnostic) return;

			if (/\bgh\s+issue\s+(?:edit|comment|close|reopen|develop)\b/.test(command)) {
				for (const item of this.state.issues) {
					if (!item.simulated) item.checkedAt = 0;
				}
			}

			// Detect swarm / issue worktree paths only when they belong to this session
			if (this.repository) {
				const swarmMatch = new RegExp(`\\bswarm-\\d+-${this.state.sessionId.slice(0, 8)}-([1-9]\\d*)\\b`, "i").exec(command);
				if (swarmMatch) {
					this.add(`https://${this.host}/${this.repository}/issues/${swarmMatch[1]}`);
				}
			}

			const isBatchLoop = /\bforeach\b|\bForEach-Object\b|\bgh\s+issue\s+list\b|\bgh\s+search\b/i.test(command);
			const ghSubcommand = /\bgh(?:\s+(?:(?:-R|--repo)(?:=|\s+)\S+|-C\s+\S+))*\s+issue\s+(view|edit|comment|close|reopen|develop|create)\b/.exec(command)?.[1];
			const mcpTargeted = /(?:^|[_-])(?:issue_read|issue_write|create_issue|update_issue)$/.test(name);
			const closing = ghSubcommand === "close" || (/(?:^|[_-])(?:issue_write|update_issue)$/.test(name) && String(args.state ?? "").toLowerCase() === "closed");
			const reopening = ghSubcommand === "reopen";
			const isPrPollCommand = /\brepos\/[\w.-]+\/[\w.-]+\/pulls\/[1-9]\d*\b/.test(command) || /\bpullRequest\s*\(/.test(command);
			const api = isPrPollCommand
				? null
				: /repos\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)(?![\d/])/.exec(command);

			const changedDirectory = /\b(?:cd|Set-Location|Push-Location)\b|\bgh\s+-C\b/i.test(command);
			const explicitRepo = /(?:--repo|-R)(?:[=\s]+)["']?([\w.-]+\/[\w.-]+)(?![\w./-])/.exec(command)?.[1] ??
				(args.owner && args.repo ? `${args.owner}/${args.repo}` : null);
			const repository = explicitRepo ?? (changedDirectory ? null : this.repository);
			const targeted = !isBatchLoop && (Boolean(ghSubcommand) || mcpTargeted || Boolean(api));

			if (targeted) {
				const commandTargetText = command.replace(/\s+(?:-c|--comment|-b|--body|-t|--title|-r|--reason)(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/g, "");
				const call = { targeted: true, closing, scrapeResultUrls: ghSubcommand === "create" || /(?:^|[_-])create_issue$/.test(name), targets: [] };
				for (const item of extractIssues(commandTargetText, this.repository, this.host)) {
					call.targets.push(item.url);
					if (!closing) this.add(item.url, reopening);
				}
				const number = args.issue_number ?? args.issueNumber ?? extractGhIssueNumber(command);
				if (api) {
					const targetUrl = `https://${this.host}/${api[1]}/issues/${api[2]}`;
					call.targets.push(targetUrl);
					if (!closing) this.add(targetUrl, reopening);
				} else if (repository && /^[1-9]\d*$/.test(String(number))) {
					const targetUrl = `https://${this.host}/${repository}/issues/${number}`;
					call.targets.push(targetUrl);
					if (!closing) this.add(targetUrl, reopening);
				}
				this.calls.set(data.toolCallId, call);
			}
		}

		if (event.type === "tool.execution_complete") {
			const call = this.calls.get(data.toolCallId);
			this.calls.delete(data.toolCallId);
			if (call?.targeted && data.success) {
				const result = data.result ?? {};
				const resultIssues = call.scrapeResultUrls
					? extractIssues(`${result.content ?? ""}\n${JSON.stringify(result.structuredContent ?? {})}`)
					: [];
				if (call.closing) {
					const ts = event.timestamp ? Date.parse(event.timestamp) : NaN;
					const closedAt = Number.isFinite(ts) ? ts : (this.lastUserInputAt || Date.now());
					for (const targetUrl of [...call.targets, ...resultIssues.map((i) => i.url)]) {
						this.add(targetUrl);
						const existing = this.state.issues.find((i) => i.url === issueReference(targetUrl).url);
						if (existing) {
							existing.closedAt = closedAt;
							existing.status = `${ICONS.closed} Closed`;
							existing.checkedAt = closedAt;
						}
					}
				} else {
					for (const item of resultIssues) this.add(item.url);
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
			calls: Object.fromEntries(this.calls),
		};
	}
}

function observeChunk(tracker, fd, startOffset, length, skipFirstPartialLine = false) {
	if (length <= 0) return startOffset;
	const chunk = Buffer.allocUnsafe(length);
	const bytesRead = readSync(fd, chunk, 0, length, startOffset);
	if (bytesRead <= 0) return startOffset;
	let sliceStart = 0;
	if (skipFirstPartialLine) {
		const firstNewline = chunk.subarray(0, bytesRead).indexOf(0x0a);
		if (firstNewline === -1) return startOffset;
		sliceStart = firstNewline + 1;
	}
	const lastNewline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
	if (lastNewline < sliceStart) return startOffset;
	const text = chunk.subarray(sliceStart, lastNewline + 1).toString("utf8");
	for (const line of text.split("\n")) {
		if (!line.trim() || !RELEVANT_EVENT_LINE.test(line)) continue;
		try {
			tracker.observe(JSON.parse(line));
		} catch {
			// Ignore malformed transcript lines.
		}
	}
	return startOffset + lastNewline + 1;
}

function inspectWorkspaceMetadata(tracker, sessionDir) {
	const wsPath = join(sessionDir, "workspace.yaml");
	if (!existsSync(wsPath)) return false;
	let changed = false;
	try {
		const raw = readFileSync(wsPath, "utf8");
		const repo = /^repository:\s*(\S+)\s*$/m.exec(raw)?.[1];
		const branch = /^branch:\s*(\S+)\s*$/m.exec(raw)?.[1];
		const name = /^name:\s*(.+?)\s*$/m.exec(raw)?.[1];
		if (repo && !tracker.repository) {
			tracker.repository = repo;
			changed = true;
		}
		const before = tracker.state.issues.length;
		if (name && !/\btriage\b/i.test(name)) {
			for (const item of extractIssues(name, tracker.repository, tracker.host)) tracker.add(item.url);
		}
		if (tracker.repository && branch) {
			const issueBranch = /^(?:issue|bug|feat|fix)[/-]([1-9]\d*)(?:[/-]|$)/i.exec(branch);
			if (issueBranch) tracker.add(`https://${tracker.host}/${tracker.repository}/issues/${issueBranch[1]}`);
		}
		if (tracker.state.issues.length !== before) changed = true;
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
} = {}) {
	return refreshTrackedIssueStatusesImpl(tracker, { home, now, fetchIssueStatus, issueCacheTtlMs });
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

	const reset = hasTranscript && (!previous || !Number.isInteger(previous.transcriptOffset) || previous.transcriptOffset > stat.size);
	const tracker = new IssueTracker(
		sessionId,
		reset && previous ? { issues: previous.issues, ignored: previous.ignored } : previous,
	);
	let offset = reset ? 0 : tracker.state.transcriptOffset;
	let changed = (hasTranscript || hasWorkspace) && (!previous || reset);

	if ((hasTranscript || hasWorkspace) && inspectWorkspaceMetadata(tracker, sessionDir)) {
		changed = true;
	}

	if (hasTranscript && stat.size > offset) {
		const fd = openSync(transcriptFile, "r");
		try {
			let nextOffset = offset;
			if (offset === 0 && stat.size > INITIAL_HEAD_BYTES + INITIAL_TAIL_BYTES) {
				observeChunk(tracker, fd, 0, INITIAL_HEAD_BYTES, false);
				const tailStart = stat.size - INITIAL_TAIL_BYTES;
				nextOffset = observeChunk(tracker, fd, tailStart, stat.size - tailStart, true);
			} else {
				nextOffset = observeChunk(tracker, fd, offset, stat.size - offset, false);
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
			if (latest && (!previous || latest.updatedAt > (previous.updatedAt ?? 0))) {
				const byUrl = new Map(tracker.state.issues.map((i) => [i.url, i]));
				tracker.state.ignored = [...latest.ignored];
				tracker.state.issues = latest.issues
					.filter((i) => !tracker.state.ignored.includes(i.url))
					.map((i) => byUrl.get(i.url) ?? i);
			}
		} catch {
			// Ignore concurrent read error.
		}
	}

	const state = changed ? tracker.snapshot() : previous;
	if (changed && state) writeState(state, home);
	return { state };
}
