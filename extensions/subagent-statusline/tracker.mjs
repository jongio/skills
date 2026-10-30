import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withStateLock } from "../state-lock.mjs";
import { dismissSettledAgents, observeSettlement } from "./settlement.mjs";

const INITIAL_HEAD_BYTES = 64 * 1024;
const INITIAL_TAIL_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const RELEVANT_EVENT_LINE = /"type"\s*:\s*"(?:session\.(?:start|resume|context_changed)|user\.message|tool\.execution_(?:start|complete)|subagent\.(?:started|completed|failed))"/;

export const ICONS = {
	agent: "\uF4B8",
	starting: "\uF252",
	exploring: "\uF422",
	inPr: "\uE726",
	merged: "\uE727",
	done: "\uF058",
	failed: "\uF057",
};

const READONLY_AGENT_TYPES = new Set(["explore", "research", "rubber-duck", "code-review", "security-review"]);

export function isExploreAgentType(agentType) {
	return /^(?:explore|research)$/i.test(String(agentType ?? "").trim());
}

function isReadonlyAgentType(agentType) {
	return READONLY_AGENT_TYPES.has(String(agentType ?? "").trim().toLowerCase());
}

export const configHome = () => process.env.COPILOT_HOME || join(homedir(), ".copilot");

export function statePath(sessionId, home = configHome()) {
	if (typeof sessionId !== "string" || !/^[\w-]{1,128}$/.test(sessionId)) {
		throw new Error("A valid session_id is required.");
	}
	return join(home, "subagent-statusline", `${sessionId}.json`);
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

function atomicWriteJson(filePath, data) {
	mkdirSync(join(filePath, ".."), { recursive: true });
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

export function normalizePrUrl(reference) {
	if (typeof reference !== "string") return null;
	const qualified = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(reference.trim());
	let url;
	try {
		url = new URL(qualified ? `https://github.com/${qualified[1]}/pull/${qualified[2]}` : reference.trim());
	} catch {
		return null;
	}
	const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
	if (url.protocol !== "https:" || !match) return null;
	return `https://${url.hostname}/${match[1]}/${match[2]}/pull/${match[3]}`;
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
	if (state.version !== 1 || state.sessionId !== sessionId || typeof state.agents !== "object" || state.agents === null) {
		throw new Error("Invalid subagent statusline state.");
	}
	return state;
}

export function writeState(state, home = configHome()) {
	return updateState(state.sessionId, (current) => {
		if ((current?.clearedAt ?? 0) > (state.clearedAt ?? 0)) return current;
		if ((current?.dismissedThroughAt ?? 0) > (state.dismissedThroughAt ?? 0)) return current;
		const ignored = new Set([...(current?.ignored ?? []), ...(state.ignored ?? [])]);
		for (const [call, id] of Object.entries(state.taskCalls ?? {})) {
			if (ignored.has(call)) ignored.add(id);
		}
		return {
			...state, ignored: [...ignored],
			dismissedThroughAt: Math.max(current?.dismissedThroughAt ?? 0, state.dismissedThroughAt ?? 0),
			agents: Object.fromEntries(Object.entries(state.agents).filter(([id]) => !ignored.has(id))),
			taskCalls: Object.fromEntries(Object.entries(state.taskCalls ?? {}).filter(([call, id]) => !ignored.has(call) && !ignored.has(id))),
			agentToolCalls: Object.fromEntries(Object.entries(state.agentToolCalls ?? {}).filter(([, call]) => !ignored.has(call.agentId))),
		};
	}, home);
}

export function updateState(sessionId, update, home = configHome()) {
	return withStateLock(statePath(sessionId, home), () => {
		const state = update(readState(sessionId, home));
		atomicWriteJson(statePath(sessionId, home), state);
		return state;
	});
}

function readSharedPrCache(home) {
	try {
		return JSON.parse(readFileSync(join(home, "pr-statusline", "pr-cache.json"), "utf8"));
	} catch {
		return {};
	}
}

export class SubagentTracker {
	constructor(sessionId, previous = null) {
		statePath(sessionId);
		this.sessionId = sessionId;
		this.clearedAt = previous?.clearedAt ?? 0;
		this.dismissedThroughAt = Number.isFinite(previous?.dismissedThroughAt) ? previous.dismissedThroughAt : 0;
		this.repository = previous?.repository ?? null;
		this.host = previous?.host ?? "github.com";
		this.lastUserInputAt = Number.isFinite(previous?.lastUserInputAt) ? previous.lastUserInputAt : 0;
		this.transcriptOffset = Number.isInteger(previous?.transcriptOffset) && previous.transcriptOffset >= 0
			? previous.transcriptOffset
			: 0;
		this.dismissed = Boolean(previous?.dismissed);
		this.simulated = Boolean(previous?.simulated);
		const legacy = !this.simulated && previous?.version === 1 && previous.activeTrackingVersion !== 2;
		this.agents = new Map(Object.entries(legacy ? {} : previous?.agents ?? {}));
		this.ignored = new Set(previous?.ignored ?? []);
		if (!this.simulated && previous?.mergeStateVersion !== 1) {
			for (const [id, agent] of this.agents) {
				if (!agent.mergedPrs?.length) continue;
				const recovered = { ...agent, mergedPrs: [] };
				delete recovered.settlementObservedAt;
				delete recovered.settlementDismissed;
				this.agents.set(id, recovered);
				this.dismissed = false;
			}
		}
		this.taskCalls = new Map(Object.entries(legacy ? {} : previous?.taskCalls ?? {}));
		this.agentToolCalls = new Map(Object.entries(previous?.activeTrackingVersion === 2 ? previous.agentToolCalls ?? {} : {}));
	}

	ensureAgent(id, meta = {}) {
		if (!id || this.ignored.has(id)) return null;
		let entry = this.agents.get(id);
		if (!entry) {
			entry = {
				id,
				name: meta.name || "subagent",
				agentType: meta.agentType || meta.name || "subagent",
				description: meta.description || "",
				status: "starting",
				executionMode: meta.executionMode || "sync",
				prs: [],
				mergedPrs: [],
				startedAt: meta.timestamp || Date.now(),
				completedAt: 0,
			};
			this.agents.set(id, entry);
			this.dismissed = false;
		} else {
			if (meta.name && entry.name === "subagent") entry.name = meta.name;
			if (meta.agentType && (!entry.agentType || entry.agentType === "subagent")) entry.agentType = meta.agentType;
			if (meta.description && !entry.description) entry.description = meta.description;
			if (meta.executionMode === "background") entry.executionMode = "background";
		}
		return entry;
	}

	linkPr(agentId, prUrl, isMerged = false, observedAt = Date.now()) {
		const normalized = normalizePrUrl(prUrl);
		if (!normalized) return;
		const agent = this.ensureAgent(agentId);
		if (!agent || isReadonlyAgentType(agent.agentType || agent.name)) return;
		if (!agent.prs.includes(normalized)) {
			agent.prs.push(normalized);
			delete agent.settlementObservedAt;
			delete agent.settlementDismissed;
		}
		if (isMerged && !agent.mergedPrs.includes(normalized)) {
			agent.mergedPrs.push(normalized);
		}
		observeSettlement(agent, observedAt);
		this.dismissed = false;
	}

	clear(now = Date.now()) {
		this.dismissedThroughAt = Math.max(this.dismissedThroughAt, now);
		for (const id of this.agents.keys()) this.ignored.add(id);
		for (const id of this.taskCalls.keys()) this.ignored.add(id);
		this.agents.clear();
		this.taskCalls.clear();
		this.agentToolCalls.clear();
		this.dismissed = true;
	}

	manage(action, id) {
		if (action === "clear") this.clear();
		else if (action === "remove") {
			if (!id) throw new Error("Provide a tracked agent ID.");
			this.ignored.add(id);
			this.agents.delete(id);
			for (const [call, agentId] of this.taskCalls) {
				if (agentId === id) {
					this.ignored.add(call);
					this.taskCalls.delete(call);
				}
			}
		} else if (action !== "list") throw new Error("Use list, remove, or clear.");
		return [...this.agents.values()];
	}

	observe(event, dismissedHistory = false) {
		if (this.clearedAt && event.timestamp && Date.parse(event.timestamp) <= this.clearedAt) return;
		const data = event.data ?? {};
		const ts = event.timestamp ? Date.parse(event.timestamp) : NaN;
		const eventTime = Number.isFinite(ts) ? ts : Date.now();
		if (this.dismissedThroughAt && (!Number.isFinite(ts) || eventTime <= this.dismissedThroughAt)) dismissedHistory = true;

		if (event.type === "session.start" || event.type === "session.resume" || event.type === "session.context_changed") {
			const context = data.context ?? data;
			if (context.repository) this.repository = context.repository;
			if (context.repositoryHost) this.host = context.repositoryHost;
		}

		if (event.type === "user.message" && !event.agentId && !data.agentId) {
			const content = String(data.content ?? "");
			const source = String(data.source ?? "");
			const isAutomated = source.startsWith("skill-") ||
				content.trimStart().startsWith("<skill-context") ||
				Boolean(data.isAutopilotContinuation) ||
				source === "session-memory-rollover" ||
				content.trimStart().startsWith("[Scheduled prompt");
			if (!isAutomated) {
				if (eventTime >= this.lastUserInputAt) this.lastUserInputAt = eventTime;
				dismissSettledAgents(this, eventTime);
			}
		}

		if (event.type === "subagent.started") {
			const id = event.agentId || data.agentId || data.toolCallId;
			if (dismissedHistory) {
				if (id) this.ignored.add(id);
				if (data.toolCallId) this.ignored.add(data.toolCallId);
			}
			if (this.ignored.has(id) || this.ignored.has(data.toolCallId)) return;
			if (data.toolCallId && id && data.toolCallId !== id && this.agents.has(data.toolCallId)) {
				const prior = this.agents.get(data.toolCallId);
				this.agents.delete(data.toolCallId);
				const merged = this.ensureAgent(id, {
					name: data.agentDisplayName || data.agentName || prior.name || "subagent",
					agentType: data.agentType || data.agentName || prior.agentType || "subagent",
					description: String(data.agentDescription || data.description || prior.description || "").slice(0, 140),
					executionMode: data.executionMode || prior.executionMode || "sync",
					timestamp: prior.startedAt || eventTime,
				});
				merged.status = "starting";
				for (const prUrl of prior.prs ?? []) this.linkPr(id, prUrl, prior.mergedPrs?.includes(prUrl));
				this.taskCalls.set(data.toolCallId, merged.id);
				return;
			}
			const agent = this.ensureAgent(id, {
				name: data.agentDisplayName || data.agentName || "subagent",
				agentType: data.agentType || data.agentName || "subagent",
				description: String(data.agentDescription || data.description || "").slice(0, 140),
				executionMode: data.executionMode || "sync",
				timestamp: eventTime,
			});
			if (agent) {
				agent.status = "starting";
				if (data.toolCallId) {
					this.taskCalls.set(data.toolCallId, id);
				}
			}
		}

		if (event.type === "subagent.completed") {
			const id = event.agentId || data.agentId || this.taskCalls.get(data.toolCallId) || data.toolCallId;
			const agent = this.agents.get(id);
			if (agent) {
				agent.status = data.cancelled ? "cancelled" : "completed";
				agent.completedAt = eventTime;
				observeSettlement(agent, eventTime);
			}
		}

		if (event.type === "subagent.failed") {
			const id = event.agentId || data.agentId || this.taskCalls.get(data.toolCallId) || data.toolCallId;
			const agent = this.agents.get(id);
			if (agent) {
				agent.status = "failed";
				agent.completedAt = eventTime;
				observeSettlement(agent, eventTime);
			}
		}

		if (event.type === "tool.execution_start") {
			const args = data.arguments ?? {};
			const name = data.mcpToolName ?? data.toolName ?? "";
			if (/(?:^|[.])task$/.test(name) && typeof args.agent_type === "string" && args.agent_type.trim()) {
				const id = data.toolCallId;
				if (dismissedHistory && id) this.ignored.add(id);
				if (this.ignored.has(id)) return;
				const rawDesc = String(args.description || String(args.prompt ?? "").split(/\r?\n/)[0] || "").trim().slice(0, 140);
				this.ensureAgent(id, {
					name: args.name || args.agent_type || "subagent",
					agentType: args.agent_type || "subagent",
					description: rawDesc,
					executionMode: args.mode === "background" ? "background" : "sync",
					timestamp: eventTime,
				});
				this.taskCalls.set(data.toolCallId, id);
				return;
			}

			const agentId = event.agentId || data.agentId;
			if (agentId && this.agents.has(agentId) && /(?:^|[._-])session_prs$/.test(name) && args.action === "add") {
				const reference = normalizePrUrl(args.reference);
				if (reference) this.agentToolCalls.set(data.toolCallId, { agentId, reference });
			}
		}

		if (event.type === "tool.execution_complete") {
			const taskAgentId = this.taskCalls.get(data.toolCallId);
			if (taskAgentId && this.agents.has(taskAgentId)) {
				const agent = this.agents.get(taskAgentId);
				if (data.success) {
					if (agent.status === "starting" && agent.executionMode !== "background") {
						agent.status = "completed";
						agent.completedAt = eventTime;
						observeSettlement(agent, eventTime);
					}
				} else if (agent.status === "starting") {
					agent.status = "failed";
					agent.completedAt = eventTime;
					observeSettlement(agent, eventTime);
				}
			}
			const subCall = this.agentToolCalls.get(data.toolCallId);
			this.agentToolCalls.delete(data.toolCallId);
			if (subCall && data.success && this.agents.has(subCall.agentId)) {
				this.linkPr(subCall.agentId, subCall.reference, false, eventTime);
			}
		}
	}

	syncWithPrCache(prCache = {}, now = Date.now()) {
		let changed = false;
		for (const agent of this.agents.values()) {
			for (const prUrl of agent.prs) {
				const cached = prCache[prUrl];
				const stateName = String(cached?.info?.state ?? "").toUpperCase();
				const age = now - cached?.checkedAt;
				const ttl = cached?.ttlMs ?? (stateName === "MERGED" ? 120000 : 45000);
				if (cached?.lastError || !Number.isFinite(age) || cached.checkedAt <= 0 ||
					!Number.isFinite(ttl) || ttl <= 0 || age < 0 || age >= ttl) continue;
				if (stateName === "MERGED" && !agent.mergedPrs.includes(prUrl)) {
					agent.mergedPrs.push(prUrl);
					changed = true;
				}
				if (stateName === "OPEN" && agent.mergedPrs.includes(prUrl)) {
					agent.mergedPrs = agent.mergedPrs.filter((url) => url !== prUrl);
					delete agent.settlementObservedAt;
					delete agent.settlementDismissed;
					this.dismissed = false;
					changed = true;
				}
				if (observeSettlement(agent, Math.max(now, this.lastUserInputAt))) changed = true;
			}
		}
		return changed;
	}

	latestSettlementTime() {
		let maxTime = 0;
		for (const agent of this.agents.values()) {
			maxTime = Math.max(maxTime, agent.completedAt || agent.startedAt || 0);
		}
		return maxTime;
	}

	counts(agents = this.agents.values()) {
		let starting = 0;
		let exploring = 0;
		let inPr = 0;
		let merged = 0;
		let done = 0;
		let failed = 0;
		for (const agent of agents) {
			if (agent.settlementDismissed && agent.status !== "starting") continue;
			const hasMerged = agent.mergedPrs?.length > 0 && agent.mergedPrs.length >= agent.prs.length;
			const hasOpenPr = agent.prs?.length > 0 && !hasMerged;
			if (hasMerged && !agent.settlementDismissed) merged++;
			else if (hasOpenPr) inPr++;
			else if (agent.status === "starting") {
				if (isExploreAgentType(agent.agentType) || isExploreAgentType(agent.name)) exploring++;
				else starting++;
			} else if (agent.status === "failed") failed++;
			else if (agent.status === "completed") done++;
		}
		return {
			total: starting + exploring + inPr + merged + done + failed,
			starting,
			exploring,
			inPr,
			merged,
			done,
			failed,
		};
	}

	snapshot() {
		return {
			version: 1,
			activeTrackingVersion: 2,
			mergeStateVersion: 1,
			sessionId: this.sessionId,
			clearedAt: this.clearedAt,
			dismissedThroughAt: this.dismissedThroughAt,
			repository: this.repository,
			host: this.host,
			lastUserInputAt: this.lastUserInputAt,
			transcriptOffset: this.transcriptOffset,
			dismissed: this.dismissed,
			...(this.simulated ? { simulated: true } : {}),
			updatedAt: Date.now(),
			agents: Object.fromEntries(this.agents),
			ignored: [...this.ignored],
			taskCalls: Object.fromEntries(this.taskCalls),
			agentToolCalls: Object.fromEntries(this.agentToolCalls),
		};
	}
}

function observeChunk(tracker, fd, startOffset, length, skipFirstPartialLine = false, replayed = null) {
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
						const time = Date.parse(event.timestamp);
						const dismissedHistory = Boolean(replayed && (completed <= replayed.offset || !Number.isFinite(time) || time <= replayed.savedAt));
						tracker.observe(event, dismissedHistory);
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

export function syncSession(payload, { home = configHome(), now = Date.now() } = {}) {
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
	let previous = null;
	try {
		previous = readState(sessionId, home);
	} catch (error) {
		if (!hasTranscript) throw error;
		const path = statePath(sessionId, home);
		try {
			renameSync(path, `${path}.corrupt`);
		} catch {
			rmSync(path, { force: true });
		}
	}
	if (!hasTranscript && !previous) return { tracker: null };

	const migrate = previous && previous.activeTrackingVersion !== 2;
	const reset = hasTranscript && (!previous || migrate ||
		!Number.isInteger(previous.transcriptOffset) || previous.transcriptOffset > stat.size);
	const tracker = new SubagentTracker(
		sessionId,
		reset ? { ...(previous?.simulated ? { agents: previous.agents, simulated: true } : {}), ignored: previous?.ignored, dismissed: previous?.dismissed,
			dismissedThroughAt: previous?.dismissedThroughAt, clearedAt: previous?.clearedAt,
			...(previous?.clearedAt ? { repository: previous.repository, host: previous.host, lastUserInputAt: previous.lastUserInputAt } : {}) } : previous,
	);
	let offset = reset ? 0 : tracker.transcriptOffset;
	if (migrate && previous.dismissed && !previous.simulated && Number.isFinite(previous.updatedAt)) {
		tracker.dismissedThroughAt = Math.max(tracker.dismissedThroughAt, previous.updatedAt);
	}
	let changed = Boolean(previous && (previous.mergeStateVersion !== 1 || previous.activeTrackingVersion !== 2)) ||
		(hasTranscript && (!previous || reset));

	const prCache = readSharedPrCache(home);
	if (tracker.syncWithPrCache(prCache, now)) changed = true;

	if (hasTranscript && stat.size > offset) {
		const fd = openSync(transcriptFile, "r");
		try {
			let nextOffset = offset;
			const replayed = migrate && previous.dismissed && !previous.simulated ? {
				offset: Number.isInteger(previous.transcriptOffset) && previous.transcriptOffset <= stat.size ? previous.transcriptOffset : 0,
				savedAt: Number.isFinite(previous.updatedAt) ? previous.updatedAt : Infinity,
			} : null;
			if (!migrate && offset === 0 && stat.size > INITIAL_HEAD_BYTES + INITIAL_TAIL_BYTES) {
				observeChunk(tracker, fd, 0, INITIAL_HEAD_BYTES, false, replayed);
				const tailStart = stat.size - INITIAL_TAIL_BYTES;
				nextOffset = observeChunk(tracker, fd, tailStart, stat.size - tailStart, true, replayed);
			} else {
				nextOffset = observeChunk(tracker, fd, offset, stat.size - offset, false, replayed);
			}
			if (nextOffset !== offset) {
				tracker.transcriptOffset = nextOffset;
				changed = true;
			}
		} finally {
			closeSync(fd);
		}
	}

	if (tracker.syncWithPrCache(prCache, now)) changed = true;
	if (changed) {
		const saved = writeState(tracker.snapshot(), home);
		return { tracker: new SubagentTracker(sessionId, saved) };
	}
	return { tracker };
}
