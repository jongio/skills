const REQUESTS = new Map([
	["permission", "approval"],
	["user_input", "question"],
	["elicitation", "question"],
	["exit_plan_mode", "approval"],
]);

function messageOrigin(data) {
	const source = String(data.source ?? "");
	const content = String(data.content ?? "").trimStart();
	if (source.startsWith("skill-") || source === "session-memory-rollover" ||
		content.startsWith("<skill-context") || content.startsWith("<system_notification>") ||
		content.startsWith("<system_reminder>")) return "injected";
	if (content.startsWith("[Scheduled prompt") || data.isAutopilotContinuation) return "automated";
	return "user";
}

export function isAttentionInteraction(event) {
	return event?.type === "user.message" && !event.agentId && !event.data?.agentId &&
		messageOrigin(event.data ?? {}) === "user";
}

export class AttentionState {
	generation = 0;
	pending = new Map();
	seenRequests = new Set();
	seenErrors = new Set();
	kind = null;
	awaitingReady = false;
	allowReady = null;

	snapshot() {
		const requests = [...this.pending.values()];
		const kind = this.kind === "error" ? "error"
			: requests.includes("question") ? "question"
				: requests.includes("approval") ? "approval" : this.kind;
		return { generation: this.generation, kind };
	}

	clear() {
		this.pending.clear();
		this.kind = null;
		this.awaitingReady = false;
		this.allowReady = null;
	}

	observe(event, { history = false } = {}) {
		if (history || !event) return false;
		const before = JSON.stringify(this.snapshot());
		const data = event.data ?? {};
		const root = !event.agentId && !data.agentId;
		const request = /^(permission|user_input|elicitation|exit_plan_mode)\.(requested|completed)$/.exec(event.type);
		if (request) {
			const [, family, action] = request;
			const id = data.requestId ?? (action === "requested" ? event.id : null);
			const key = `${family}:${id ?? "pending"}`;
			if (action === "requested") {
				if (id != null && this.seenRequests.has(key)) return false;
				if (id != null) this.seenRequests.add(key);
				if (!data.resolvedByHook && !this.pending.has(key)) {
					this.pending.set(key, REQUESTS.get(family));
					this.kind = null;
					this.generation++;
				}
			} else if (id != null) {
				this.pending.delete(key);
			} else {
				const matches = [...this.pending.keys()].filter((key) => key.startsWith(`${family}:`));
				if (matches.length === 1) this.pending.delete(matches[0]);
			}
		} else if (root) {
			if (event.type === "user.message") {
				const origin = messageOrigin(data);
				if (origin === "user") {
					this.clear();
					this.allowReady = true;
				} else if (!this.awaitingReady && this.allowReady !== true) {
					if (origin === "automated") this.kind = null;
					this.allowReady = false;
				}
			}
			if (event.type === "assistant.turn_start" || event.type === "model.turn_started") {
				this.kind = null;
				this.awaitingReady = this.allowReady !== false;
			}
			if (event.type === "session.idle" && this.pending.size === 0) {
				if (this.awaitingReady && this.kind !== "error") {
					this.kind = "ready";
					this.generation++;
				}
				this.awaitingReady = false;
				this.allowReady = null;
			}
			if (event.type === "session.error") {
				if (event.id && this.seenErrors.has(event.id)) return false;
				if (event.id) this.seenErrors.add(event.id);
				if (this.kind !== "error" || event.id) {
					this.generation++;
				}
				this.kind = "error";
				this.awaitingReady = false;
			}
			if (event.type === "abort" || event.type === "session.shutdown" ||
				event.type === "session.start" || event.type === "session.resume") this.clear();
		}
		return before !== JSON.stringify(this.snapshot());
	}
}
