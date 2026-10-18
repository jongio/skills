import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mergePrProvenance, normalizePrProvenance, sourceProvenance } from "./provenance.mjs";
import {
	atomicWriteJson,
	OCTICONS,
	PR_CLOSED_TTL_MS,
	PR_RUNNING_TTL_MS,
	PR_SETTLED_TTL_MS,
	prContextFields,
	queryBranchPrWithGh,
	queryPrStatusWithGh,
	readPrCache,
	refreshTrackedPrStatuses as refreshTrackedPrStatusesImpl,
	summarizePrStatus,
	writePrCache,
} from "./github.mjs";

export {
	OCTICONS,
	PR_CLOSED_TTL_MS,
	PR_RUNNING_TTL_MS,
	PR_SETTLED_TTL_MS,
	queryBranchPrWithGh,
	queryPrStatusWithGh,
	summarizePrStatus,
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
]);
export const RELEVANT_EVENT_TYPE = /^(?:session\.(?:start|resume|context_changed|idle|compaction_start|compaction_complete|error|shutdown)|user\.message|assistant\.turn_(?:start|end)|model\.turn_(?:started|ended)|tool\.execution_(?:start|complete)|subagent\.(?:started|completed|failed)|(?:permission|user_input|elicitation|exit_plan_mode)\.(?:requested|completed)|abort)$/;
const RELEVANT_EVENT_LINE = /"type"\s*:\s*"(?:session\.(?:start|resume|context_changed|idle|compaction_start|compaction_complete|error|shutdown)|user\.message|assistant\.turn_(?:start|end)|model\.turn_(?:started|ended)|tool\.execution_(?:start|complete)|subagent\.(?:started|completed|failed)|(?:permission|user_input|elicitation|exit_plan_mode)\.(?:requested|completed)|abort)"/;

export const configHome = () => process.env.COPILOT_HOME || join(homedir(), ".copilot");

export function statePath(sessionId, home = configHome()) {
	if (typeof sessionId !== "string" || !/^[\w-]{1,128}$/.test(sessionId)) {
		throw new Error("A valid session_id is required.");
	}
	return join(home, "pr-statusline", `${sessionId}.json`);
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

export function pullRequest(reference) {
	if (typeof reference !== "string") throw new Error("Provide a PR URL or owner/repo#number.");
	const qualified = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(reference.trim());
	const url = new URL(qualified
		? `https://github.com/${qualified[1]}/pull/${qualified[2]}`
		: reference.trim());
	const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
	if (url.protocol !== "https:" || url.username || url.password || url.port || !match) {
		throw new Error("Expected an HTTPS pull-request web URL or owner/repo#number.");
	}
	return {
		url: `https://${url.hostname}/${match[1]}/${match[2]}/pull/${match[3]}`,
		label: `${match[1]}/${match[2]}#${match[3]}`,
	};
}

function urls(text, repository = null, host = "github.com") {
	const source = String(text ?? "");
	const found = [];
	const push = (ref) => {
		try {
			const pr = pullRequest(ref);
			if (!PLACEHOLDER_REPOS.has(pr.label.split("#")[0].toLowerCase())) found.push(pr);
		} catch {
			// Ignore invalid references.
		}
	};
	for (const [url] of source.matchAll(/https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*/g)) {
		push(url);
	}
	for (const match of source.matchAll(/\b(?:pr|pull\s+request|pr-review|pr-watch|prw|review|watch)\b[^\r\n]{0,40}?\b([\w.-]+\/[\w.-]+#[1-9]\d*)\b/gi)) {
		push(match[1]);
	}
	if (repository && !PLACEHOLDER_REPOS.has(repository.toLowerCase())) {
		for (const match of source.matchAll(/\b(?:pr|pull\s+request)[ \t]+#([1-9]\d*)\b/gi)) {
			push(`https://${host}/${repository}/pull/${match[1]}`);
		}
	}
	return found;
}

function extractGhPrNumber(command) {
	const match = /\bgh(?:\s+(?:(?:-R|--repo)(?:=|\s+)\S+|-C\s+\S+))*\s+pr\s+(?:view|diff|checks|checkout|edit|review|comment|merge|close|reopen|ready)\b([^;&|\r\n]*)/.exec(command);
	if (!match) return null;
	const tokens = match[1].trim().split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i].replace(/^["']|["']$/g, "");
		if (token === "--") continue;
		if (/^(?:-R|--repo|-B|--base|-H|--head|-t|--title|-b|--body|-F|--body-file|-r|--reviewer|-a|--assignee|-l|--label|-p|--project|-m|--milestone|-jq|--jq|--template)$/.test(token)) {
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
			!Array.isArray(state.prs) || !Array.isArray(state.ignored) ||
			!Number.isFinite(state.updatedAt) || typeof state.status !== "string") {
		throw new Error("Invalid PR statusline state.");
	}
	state.prs = state.prs.map((pr) => ({
		...pullRequest(pr.url),
		...prContextFields(pr),
		provenance: normalizePrProvenance(pr.provenance),
		...(typeof pr.title === "string" && pr.title ? { title: pr.title } : {}),
		...(typeof pr.status === "string" && pr.status ? { status: pr.status } : {}),
		...(Number.isFinite(pr.checkedAt) ? { checkedAt: pr.checkedAt } : {}),
		...(Number.isFinite(pr.mergedAt) ? { mergedAt: pr.mergedAt } : {}),
		...(pr.simulated ? { simulated: true } : {}),
	}));
	state.ignored = state.ignored.map((url) => pullRequest(url).url);
	if (Array.isArray(state.simulate)) {
		state.simulate = state.simulate.map((s) => String(s));
	}
	return state;
}

export function writeState(state, home = configHome()) {
	atomicWriteJson(statePath(state.sessionId, home), state);
}

export class SessionTracker {
	constructor(sessionId, previous = null) {
		statePath(sessionId);
		this.state = {
			version: 1,
			sessionId,
			prs: [...(previous?.prs ?? [])],
			ignored: [...(previous?.ignored ?? [])],
			status: previous?.status ?? "Starting tracker",
			updatedAt: previous?.updatedAt ?? Date.now(),
			transcriptOffset: Number.isInteger(previous?.transcriptOffset) && previous.transcriptOffset >= 0
				? previous.transcriptOffset
				: 0,
			...(Array.isArray(previous?.simulate) ? { simulate: [...previous.simulate] } : {}),
		};
		this.repository = previous?.repository ?? null;
		this.host = previous?.host ?? "github.com";
		this.lastUserInputAt = Number.isFinite(previous?.lastUserInputAt) ? previous.lastUserInputAt : 0;
		this.userRepos = new Set(Array.isArray(previous?.userRepos) ? previous.userRepos : []);
		this.calls = new Map(Object.entries(previous?.calls ?? {}));
		this.pending = new Map(Object.entries(previous?.pending ?? {}));
		this.background = new Set(Array.isArray(previous?.background) ? previous.background : []);
	}

	add(reference, explicit = false, source = null) {
		const pr = pullRequest(reference);
		if (PLACEHOLDER_REPOS.has(pr.label.split("#")[0].toLowerCase())) return;
		if (explicit) this.state.ignored = this.state.ignored.filter((url) => url !== pr.url);
		const existing = this.state.prs.find((p) => p.url === pr.url);
		if (!this.state.ignored.includes(pr.url) && !existing) {
			this.state.prs.push({ ...pr, provenance: sourceProvenance(source) });
		} else if (existing && source) {
			existing.provenance = mergePrProvenance(existing.provenance, sourceProvenance(source));
		}
	}

	manage(action, reference) {
		if (action === "add") this.add(reference, true, { root: true });
		else if (action === "remove") {
			const { url } = pullRequest(reference);
			this.state.prs = this.state.prs.filter((pr) => pr.url !== url);
			if (!this.state.ignored.includes(url)) this.state.ignored.push(url);
		} else if (action === "clear") {
			this.state.ignored = [...new Set([...this.state.ignored, ...this.state.prs.map((pr) => pr.url)])];
			this.state.prs = [];
		} else if (action !== "list") throw new Error("Use add, remove, clear, or list.");
		return this.state.prs;
	}

	observe(event, history = false) {
		const data = event.data ?? {};
		const agentId = event.agentId || data.agentId || null;
		const prSource = agentId ? { agentId } : { root: true };
		if (event.type === "session.start" || event.type === "session.resume" || event.type === "session.context_changed") {
			const context = data.context ?? data;
			if (context.repository) this.repository = context.repository;
			if (context.repositoryHost) this.host = context.repositoryHost;
			if (event.type === "session.start" || event.type === "session.resume") {
				this.pending.clear();
				this.calls.clear();
				this.state.status = "Waiting on you";
			}
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
				for (const pr of [...this.state.prs]) {
					const isMerged = Boolean(pr.mergedAt) || pr.status?.includes(OCTICONS.merged) || pr.status?.includes("🟣");
					if (!pr.simulated && isMerged && (!pr.mergedAt || messageTime >= pr.mergedAt)) {
						this.manage("remove", pr.url);
					}
				}
			}
			if (!isSkillInjection) {
				for (const pr of urls(content, this.repository, this.host)) {
					this.userRepos.add(pr.label.split("#")[0].toLowerCase());
					this.add(pr.url, false, isAutomated ? null : prSource);
				}
			}
			for (const attachment of data.attachments ?? []) {
				if (attachment.type === "github_reference" && attachment.referenceType === "pull_request") {
					const pr = pullRequest(attachment.url);
					this.userRepos.add(pr.label.split("#")[0].toLowerCase());
					this.add(pr.url, false, prSource);
				}
			}
			if (!event.agentId) {
				for (const key of this.pending.keys()) {
					if (key.startsWith("tool:")) this.pending.delete(key);
				}
				this.state.status = "Working";
			}
		}
		if (event.type === "tool.execution_start") {
			const args = data.arguments ?? {};
			const name = data.mcpToolName ?? data.toolName ?? "";
			const command = args.command ?? "";
			if (!event.agentId && name === "ask_user") this.pending.set(`tool:${data.toolCallId}`, "answer");
			if (!event.agentId && name === "exit_plan_mode") this.pending.set(`tool:${data.toolCallId}`, "plan approval");
			if (name === "manage_schedule") {
				for (const pr of urls(args.prompt, this.repository, this.host)) this.add(pr.url);
			}
			if (/\b(?:git\s+push|gh\s+run\s+rerun|gh\s+pr\s+(?:create|edit|ready|review|comment)|resolveReviewThread)\b/.test(command)) {
				for (const pr of this.state.prs) {
					if (!pr.simulated) pr.checkedAt = 0;
				}
			}
			// Ignore diagnostic commands inspecting other sessions' transcripts or statusline state.
			const safeSessionId = this.state.sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const otherSessionState = new RegExp(`\\.copilot[\\\\/]session-state(?:[\\\\/](?!${safeSessionId}\\b)|$)`, "i");
			const isDiagnostic = /\.copilot[\\/]pr-statusline\b|events\.jsonl\b|smoke\.test\.mjs\b/i.test(command) ||
				otherSessionState.test(command);
			const isMetadataProbeOnly = /\bgh\s+pr\s+diff\b[^\r\n]*--name-only\b/.test(command) ||
				(/\bgh\s+pr\s+view\b/.test(command) &&
					/--json\s+([\w,]+)/.test(command) &&
					!/\b(?:url|statusCheckRollup|reviewDecision|reviews|comments|mergeStateStatus|body|title)\b/.test(/--json\s+([\w,]+)/.exec(command)?.[1] ?? ""));
			const ghSubcommand = /\bgh(?:\s+(?:(?:-R|--repo)(?:=|\s+)\S+|-C\s+\S+))*\s+pr\s+(view|diff|checks|checkout|edit|review|comment|merge|close|reopen|ready|create)\b/.exec(command)?.[1];
			const mcpTargeted = /(?:^|[_-])(?:pull_request_read|create_pull_request|update_pull_request|merge_pull_request|pull_request_review_write|add_comment_to_pending_review)$/.test(name);
			const merging = ghSubcommand === "merge" || /(?:^|[_-])merge_pull_request$/.test(name);
			const closing = ghSubcommand === "close";
			const reopening = ghSubcommand === "reopen";
			const isProcessFilter = /\bGet-CimInstance\b|\bWhere-Object\b|\b-like\s+['"]\*/i.test(command);
			const api = isProcessFilter ? null : /repos\/([\w.-]+\/[\w.-]+)\/pulls\/([1-9]\d*)(?!\d)/.exec(command);
			const isTask = /(?:^|[._-])task$/.test(name) &&
				args.agent_type !== "explore" &&
				args.agent_type !== "research" &&
				(urls(args.prompt, this.repository, this.host).length > 0 || /\b(?:pr|pull request)\b/i.test(`${args.description ?? ""} ${args.prompt ?? ""}`));
			const changedDirectory = /\b(?:cd|Set-Location|Push-Location)\b|\bgh\s+-C\b/i.test(command);
			const explicitRepo = /(?:--repo|-R)(?:[=\s]+)["']?([\w.-]+\/[\w.-]+)(?![\w./-])/.exec(command)?.[1] ??
				(args.owner && args.repo ? `${args.owner}/${args.repo}` : null);
			const repository = explicitRepo ?? (changedDirectory ? null : this.repository);
			const crossRepoReadOnly = Boolean(
				this.repository &&
				explicitRepo &&
				explicitRepo.toLowerCase() !== this.repository.toLowerCase() &&
				!this.userRepos.has(explicitRepo.toLowerCase()) &&
				!changedDirectory &&
				(ghSubcommand === "view" || ghSubcommand === "diff"),
			);
			const targeted = !isDiagnostic && !isMetadataProbeOnly && !crossRepoReadOnly &&
				(Boolean(ghSubcommand && ghSubcommand !== "diff") || mcpTargeted);
			const hasListCommand = /\bgh\s+(?:(?:-R|--repo)(?:=|\s+)\S+\s+)*pr\s+(?:list|status)\b|\bgh\s+search\b|\brepos\/[\w.-]+\/[\w.-]+\/pulls(?=[?'"\s]|$)/i.test(command);
			// Delegating a PR task is not evidence that the parent directly worked on it.
			const call = { targeted: targeted || (!isDiagnostic && !!api) || isTask, closing, merging,
				source: isTask ? {} : prSource, scrapeResultUrls: false, targets: [] };
			const existingOnly = !call.targeted && !isDiagnostic && Boolean(ghSubcommand || mcpTargeted);
			const addTarget = (reference) => {
				if (!existingOnly || this.state.prs.some((pr) => pr.url === pullRequest(reference).url)) {
					this.add(reference, reopening, call.source);
				}
			};
			if (call.targeted || existingOnly) {
				const commandTargetText = command
					? command.replace(/\s+(?:-c|--comment|-b|--body|-t|--title|-r|--reason)(?:=|\s+)(?:'[^']*'|"[^"]*"|\S+)/g, "")
					: args.prompt;
				for (const pr of urls(commandTargetText, this.repository, this.host)) {
					call.targets.push(pr.url);
					if (!closing) addTarget(pr.url);
				}
				const number = args.pullNumber ?? args.pull_number ?? extractGhPrNumber(command);
				if (api) {
					const targetUrl = `https://${this.host}/${api[1]}/pull/${api[2]}`;
					call.targets.push(targetUrl);
					if (!closing) addTarget(targetUrl);
				} else if (repository && /^[1-9]\d*$/.test(String(number))) {
					const targetUrl = `https://${this.host}/${repository}/pull/${number}`;
					call.targets.push(targetUrl);
					if (!closing) addTarget(targetUrl);
				}
				call.scrapeResultUrls = !closing && !hasListCommand && (
					ghSubcommand === "create" ||
					/(?:^|[_-])create_pull_request$/.test(name) ||
					isTask ||
					call.targets.length === 0
				);
				this.calls.set(data.toolCallId, call);
			}
		}
		if (event.type === "tool.execution_complete") {
			this.pending.delete(`tool:${data.toolCallId}`);
			const call = this.calls.get(data.toolCallId);
			this.calls.delete(data.toolCallId);
			if (call?.targeted && data.success) {
				const result = data.result ?? {};
				const resultPrs = call.scrapeResultUrls
					? urls(`${result.content ?? ""}\n${JSON.stringify(result.structuredContent ?? {})}`)
					: [];
				if (call.closing) {
					const closedTargets = [...call.targets];
					if (closedTargets.length === 0) {
						const closedLines = String(result.content ?? "")
							.match(/(?:Closed pull request|already closed|Closed and commented:)[^\r\n]*/gi) ?? [];
						for (const pr of urls(closedLines.join("\n"), this.repository, this.host)) {
							closedTargets.push(pr.url);
						}
					}
					for (const targetUrl of closedTargets) {
						this.manage("remove", targetUrl);
					}
				} else if (call.merging) {
					const ts = event.timestamp ? Date.parse(event.timestamp) : NaN;
					const mergedAt = Number.isFinite(ts) ? ts : (this.lastUserInputAt || Date.now());
					for (const targetUrl of [...call.targets, ...resultPrs.map((pr) => pr.url)]) {
						this.add(targetUrl, false, call.source);
						const existing = this.state.prs.find((p) => p.url === pullRequest(targetUrl).url);
						if (existing) {
							existing.mergedAt = mergedAt;
							existing.status = `${OCTICONS.merged} Merged`;
							existing.checkedAt = mergedAt;
						}
					}
				} else {
					for (const pr of resultPrs) {
						this.add(pr.url, false, call.source);
					}
				}
			}
		}
		const requestKinds = {
			"permission.requested": "permission",
			"user_input.requested": "answer",
			"elicitation.requested": "input",
			"exit_plan_mode.requested": "plan approval",
		};
		if (!history && requestKinds[event.type] && !data.resolvedByHook) {
			this.pending.set(data.requestId ?? event.id, requestKinds[event.type]);
		}
		if (/^(permission|user_input|elicitation|exit_plan_mode)\.completed$/.test(event.type)) {
			this.pending.delete(data.requestId);
			this.state.status = "Working";
		}
		if (event.type === "subagent.started") this.background.add(data.agentId ?? data.toolCallId ?? event.agentId);
		if (event.type === "subagent.completed" || event.type === "subagent.failed") {
			this.background.delete(data.agentId ?? data.toolCallId ?? event.agentId);
		}
		if ((event.type === "assistant.turn_start" || event.type === "model.turn_started") && !event.agentId) {
			this.state.status = "Working";
		}
		if ((event.type === "assistant.turn_end" || event.type === "model.turn_ended" || event.type === "session.idle") && !event.agentId) {
			if (event.type === "session.idle") this.pending.clear();
			else {
				for (const key of this.pending.keys()) {
					if (key.startsWith("tool:")) this.pending.delete(key);
				}
			}
			this.state.status = "Waiting on you";
		}
		if (event.type === "session.compaction_start") this.state.status = "Compacting context";
		if (event.type === "session.compaction_complete") this.state.status = "Working";
		if (event.type === "session.error" && !event.agentId) this.state.status = "Error";
		if (event.type === "abort" && !event.agentId) this.state.status = "Interrupted";
		if (event.type === "session.shutdown") {
			this.pending.clear();
			this.state.status = history ? "Waiting on you" : "Stopped";
		}
	}

	snapshot(activity = null) {
		if (activity && !["Error", "Interrupted", "Stopped", "Compacting context"].includes(this.state.status)) {
			this.state.status = activity.hasActiveWork ? "Working" : "Waiting on you";
		}
		const waiting = [...this.pending.values()][0];
		let status = waiting ? `Waiting on you (${waiting})` : this.state.status;
		if (this.background.size) status += ` | ${this.background.size} background agent(s)`;
		return {
			...this.state,
			status,
			updatedAt: Date.now(),
			repository: this.repository,
			host: this.host,
			lastUserInputAt: this.lastUserInputAt,
			userRepos: [...this.userRepos],
			calls: Object.fromEntries(this.calls),
			pending: Object.fromEntries(this.pending),
			background: [...this.background],
		};
	}
}

function observeChunk(tracker, fd, startOffset, length, skipFirstPartialLine = false, lineFilter = RELEVANT_EVENT_LINE) {
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
		if (!line.trim() || !lineFilter.test(line)) continue;
		try {
			tracker.observe(JSON.parse(line));
		} catch {
			// Ignore malformed transcript lines.
		}
	}
	if (tracker.state.status === "Starting tracker") {
		tracker.state.status = "Waiting on you";
	}
	return startOffset + lastNewline + 1;
}

function inspectWorkspaceMetadata(tracker, sessionDir, { home, now, useGh }) {
	const wsPath = join(sessionDir, "workspace.yaml");
	if (!existsSync(wsPath)) return false;
	let changed = false;
	try {
		const raw = readFileSync(wsPath, "utf8");
		const repo = /^repository:\s*(\S+)\s*$/m.exec(raw)?.[1];
		const branch = /^branch:\s*(\S+)\s*$/m.exec(raw)?.[1];
		const cwd = /^cwd:\s*(.+?)\s*$/m.exec(raw)?.[1];
		const name = /^name:\s*(.+?)\s*$/m.exec(raw)?.[1];
		if (repo && !tracker.repository) {
			tracker.repository = repo;
			changed = true;
		}
		const before = tracker.state.prs.length;
		if (name) {
			for (const pr of urls(name, tracker.repository, tracker.host)) tracker.add(pr.url);
		}
		if (tracker.repository && branch) {
			const prBranch = /^pr-([1-9]\d*)$/i.exec(branch);
			if (prBranch) tracker.add(`https://${tracker.host}/${tracker.repository}/pull/${prBranch[1]}`);
		}
		if (tracker.repository && cwd) {
			const worktreePr = /\bpr-review-[\w.-]+-([1-9]\d*)-[0-9a-f]{7,}\b/i.exec(cwd);
			if (worktreePr) tracker.add(`https://${tracker.host}/${tracker.repository}/pull/${worktreePr[1]}`);
		}
		if (useGh && tracker.repository && branch &&
				!["main", "master", "HEAD"].includes(branch) &&
				!branch.startsWith("detached@") &&
				!/^pr-[1-9]\d*$/i.test(branch)) {
			const cache = readPrCache(home);
			const key = `branch:${tracker.repository}:${branch}`;
			const cached = cache[key];
			let branchPr = cached && now - cached.checkedAt < (cached.ttlMs ?? PR_SETTLED_TTL_MS) ? cached.data : undefined;
			if (branchPr === undefined && (!cached?.refreshingUntil || cached.refreshingUntil <= now)) {
				cache[key] = { ...(cached ?? {}), refreshingUntil: now + 8000 };
				writePrCache(cache, home);
				branchPr = queryBranchPrWithGh(tracker.repository, branch);
				cache[key] = {
					data: branchPr,
					checkedAt: now,
					ttlMs: PR_SETTLED_TTL_MS,
					refreshingUntil: 0,
				};
				writePrCache(cache, home);
			}
			if (branchPr?.url) {
				tracker.add(branchPr.url);
				const added = tracker.state.prs.find((p) => p.url === branchPr.url);
				if (added) {
					const fields = prContextFields(branchPr);
					for (const [key, value] of Object.entries(fields)) {
						if (JSON.stringify(added[key]) !== JSON.stringify(value)) {
							added[key] = value;
							changed = true;
						}
					}
					if (branchPr.title && !added.title) added.title = branchPr.title;
					if (!added.status) {
						added.status = summarizePrStatus(branchPr);
						added.checkedAt = now;
					}
				}
			}
		}
		if (tracker.state.prs.length !== before) changed = true;
	} catch {
		// Ignore workspace.yaml read failures.
	}
	return changed;
}

export function refreshTrackedPrStatuses(tracker, {
	home = configHome(),
	now = Date.now(),
	fetchPrStatus = queryPrStatusWithGh,
	prCacheTtlMs,
} = {}) {
	return refreshTrackedPrStatusesImpl(tracker, { home, now, fetchPrStatus, prCacheTtlMs });
}

export function syncSession(payload, {
	home = configHome(),
	now = Date.now(),
	fetchPrStatus,
	prCacheTtlMs,
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
	if (!hasTranscript && !hasWorkspace && !previous) return { state: null, liveTranscript: false };

	const reset = hasTranscript && (!previous || !Number.isInteger(previous.transcriptOffset) || previous.transcriptOffset > stat.size);
	const tracker = new SessionTracker(
		sessionId,
		reset && previous ? { prs: previous.prs, ignored: previous.ignored, simulate: previous.simulate } : previous,
	);
	let offset = reset ? 0 : tracker.state.transcriptOffset;
	let changed = (hasTranscript || hasWorkspace) && (!previous || reset);
	const useDefaultGh = fetchPrStatus === undefined && (hasTranscript || hasWorkspace);

	if ((hasTranscript || hasWorkspace) && inspectWorkspaceMetadata(tracker, sessionDir, { home, now, useGh: useDefaultGh })) {
		changed = true;
	}

	if (hasTranscript && stat.size > offset) {
		const fd = openSync(transcriptFile, "r");
		try {
			let nextOffset = offset;
			if (offset === 0 && stat.size > INITIAL_HEAD_BYTES + INITIAL_TAIL_BYTES) {
				observeChunk(tracker, fd, 0, INITIAL_HEAD_BYTES, false, RELEVANT_EVENT_LINE);
				tracker.pending.clear();
				tracker.calls.clear();
				tracker.background.clear();
				const tailStart = stat.size - INITIAL_TAIL_BYTES;
				nextOffset = observeChunk(tracker, fd, tailStart, stat.size - tailStart, true, RELEVANT_EVENT_LINE);
			} else {
				nextOffset = observeChunk(tracker, fd, offset, stat.size - offset, false, RELEVANT_EVENT_LINE);
			}
			if (nextOffset !== offset) {
				tracker.state.transcriptOffset = nextOffset;
				changed = true;
			}
		} finally {
			closeSync(fd);
		}
	}

	if ((hasTranscript || hasWorkspace) && (tracker.state.status === "Stopped" || tracker.state.status === "Starting tracker")) {
		tracker.state.status = "Waiting on you";
		changed = true;
	}

	const remoteRepo = payload?.remote?.repository;
	const remotePr = payload?.remote?.pull_request_number;
	if (remoteRepo && /^[1-9]\d*$/.test(String(remotePr))) {
		const before = tracker.state.prs.length;
		tracker.add(`${remoteRepo}#${remotePr}`);
		if (tracker.state.prs.length !== before) changed = true;
	}

	const statusFetcher = typeof fetchPrStatus === "function"
		? fetchPrStatus
		: (fetchPrStatus !== false && (hasTranscript || hasWorkspace) ? queryPrStatusWithGh : null);
	if (statusFetcher && refreshTrackedPrStatuses(tracker, { home, now, fetchPrStatus: statusFetcher, prCacheTtlMs })) {
		changed = true;
	}

	if (changed) {
		try {
			const latest = readState(sessionId, home);
			if (latest && (!previous || latest.updatedAt > (previous.updatedAt ?? 0))) {
				const byUrl = new Map(tracker.state.prs.map((p) => [p.url, p]));
				tracker.state.ignored = [...latest.ignored];
				tracker.state.prs = latest.prs
					.filter((p) => !tracker.state.ignored.includes(p.url))
					.map((p) => {
						const observed = byUrl.get(p.url);
						return observed ? {
							...observed, provenance: mergePrProvenance(observed.provenance, p.provenance),
						} : p;
					});
			}
		} catch {
			// Ignore concurrent read error.
		}
	}

	const state = changed ? tracker.snapshot() : previous;
	if (changed && state) writeState(state, home);
	return { state, liveTranscript: hasTranscript || hasWorkspace };
}
