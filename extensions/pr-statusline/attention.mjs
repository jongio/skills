import { spawn as spawnProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watchFile, unwatchFile, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withStateLock } from "../state-lock.mjs";
import { AttentionState, isAttentionInteraction } from "./attention-state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = ["border", "background", "both"];
const COLORS = Object.freeze({ approval: "#FFBB24", question: "#B48CFF", ready: "#5BD463", error: "#EF5F5F" });
export const ATTENTION_DEFAULTS = Object.freeze({ enabled: false, style: "both", colors: COLORS });
const defaultHome = () => process.env.COPILOT_HOME || join(homedir(), ".copilot");
export const attentionConfigPath = (home = defaultHome()) => join(home, "statusline-attention.json");

function object(value) {
	return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeConfig(value) {
	if (!object(value)) throw new Error("Window attention settings must be a JSON object.");
	if (value.version !== undefined && value.version !== 1) throw new Error("Unsupported window attention settings version.");
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("Attention enabled must be true or false.");
	if (value.style !== undefined && !STYLES.includes(value.style)) throw new Error("Attention style must be border, background, or both.");
	if (value.colors !== undefined && !object(value.colors)) throw new Error("Attention colors must be an object.");
	const colors = { ...COLORS, ...value.colors };
	for (const kind of Object.keys(COLORS)) {
		if (!/^#[0-9a-f]{6}$/i.test(colors[kind])) throw new Error(`Attention ${kind} color must use #RRGGBB.`);
	}
	return { ...value, version: 1, enabled: value.enabled ?? false, style: value.style ?? "both", colors };
}

export function readAttentionConfig(home = defaultHome()) {
	try {
		return normalizeConfig(JSON.parse(readFileSync(attentionConfigPath(home), "utf8")));
	} catch (error) {
		if (error.code === "ENOENT") return normalizeConfig({});
		throw error;
	}
}

export function setAttentionConfig(update, { home = defaultHome() } = {}) {
	if (!object(update)) throw new Error("Window attention settings must be a JSON object.");
	if (update.colors !== undefined && !object(update.colors)) throw new Error("Attention colors must be an object.");
	const file = attentionConfigPath(home);
	return withStateLock(file, () => {
		const previous = readAttentionConfig(home);
		const config = normalizeConfig({ ...previous, ...update, colors: { ...previous.colors, ...update.colors } });
		const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			renameSync(temporary, file);
		} finally {
			rmSync(temporary, { force: true });
		}
		return config;
	});
}

export async function buildAttentionHelper({
	home = defaultHome(), env = process.env, spawn = spawnProcess, source = join(HERE, "attention.windows.cs"),
} = {}) {
	const content = readFileSync(source);
	const hash = createHash("sha256").update(content).digest("hex").slice(0, 20);
	const directory = join(home, "statusline-attention", "bin");
	const destination = join(directory, `attention-${hash}.exe`);
	if (existsSync(destination)) return destination;
	const framework = join(env.WINDIR || "C:\\Windows", "Microsoft.NET",
		process.arch === "ia32" ? "Framework" : "Framework64", "v4.0.30319");
	const compiler = join(framework, "csc.exe");
	if (!existsSync(compiler)) throw new Error("Windows .NET Framework compiler is unavailable; window attention is disabled.");
	mkdirSync(directory, { recursive: true });
	const temporary = join(directory, `attention-${hash}-${process.pid}-${randomUUID()}.exe`);
	try {
		await new Promise((resolve, reject) => {
			const child = spawn(compiler, ["/nologo", "/optimize+", "/target:winexe",
				`/reference:${join(framework, "System.Web.Extensions.dll")}`, `/out:${temporary}`, source], {
				windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			let timeoutError = null;
			for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => {
				output = (output + data).slice(-8000);
			});
			const timer = setTimeout(() => {
				timeoutError = new Error("Window attention helper compilation timed out.");
				child.kill();
			}, 30000);
			child.once("error", (error) => { clearTimeout(timer); reject(error); });
			child.once("close", (code) => {
				clearTimeout(timer);
				if (timeoutError) reject(timeoutError);
				else if (code === 0) resolve();
				else reject(new Error(`Window attention helper compilation failed: ${output.trim()}`));
			});
		});
		try {
			renameSync(temporary, destination);
		} catch (error) {
			if (!existsSync(destination)) throw error;
		}
		return destination;
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function createSessionAttention({
	home = defaultHome(), platform = process.platform, env = process.env,
	ownerProcessId = process.pid, spawn = spawnProcess, build = buildAttentionHelper,
	report = console.error, watch = true,
} = {}) {
	const state = new AttentionState();
	const supported = platform === "win32" && Boolean(env.WT_SESSION);
	let config = { ...ATTENTION_DEFAULTS };
	let child = null, starting = null, cancelStart = null, stopped = false, failed = false, binding = null, lastError = null;
	let acknowledgedGeneration = 0;
	let previous = null;
	let preview = null;

	const status = () => ({ enabled: config.enabled, supported, style: config.style,
		binding, error: lastError, ...state.snapshot() });
	const fail = (error) => {
		if (lastError !== error.message) report(`[session-attention] ${error.message}`);
		lastError = error.message;
		failed = true;
	};
	function stopChild() {
		cancelStart?.();
		const current = child;
		child = null;
		binding = null;
		previous = null;
		if (!current) return;
		current.stdin.end();
		const timer = setTimeout(() => current.kill(), 1500);
		timer.unref();
		current.once("close", () => clearTimeout(timer));
	}
	function send(message) {
		if (child && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
	}
	function publish() {
		if (!child || !binding) return;
		const snapshot = state.snapshot();
		const message = { type: "alert", ...snapshot, style: config.style,
			color: config.colors[snapshot.kind] ?? COLORS.approval,
			acknowledged: snapshot.generation <= acknowledgedGeneration || !config.enabled };
		const comparable = JSON.stringify(message);
		if (comparable !== previous) {
			previous = comparable;
			send(message);
		}
		if (preview) {
			send({ type: "preview", ...preview, style: config.style, color: config.colors[preview.kind] });
			preview = null;
		}
	}
	async function start() {
		if (child || starting || stopped || failed || !supported) return starting;
		starting = (async () => {
			try {
				const executable = await build({ home, env, spawn });
				if (stopped || (!preview && (!config.enabled || !state.snapshot().kind ||
					state.generation <= acknowledgedGeneration))) return;
				const current = spawn(executable, [String(ownerProcessId)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
				child = current;
				let buffer = "", stderr = "";
				let finish;
				const ready = new Promise((resolve, reject) => {
					let settled = false;
					const timer = setTimeout(() => {
						finish(new Error("Window attention helper did not confirm its console binding."));
						stopChild();
					}, 10000);
					finish = (error) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						cancelStart = null;
						if (error) reject(error);
						else resolve();
					};
					cancelStart = () => finish(new Error("Window attention startup cancelled."));
				});
				current.stdout.setEncoding("utf8");
				current.stdout.on("data", (data) => {
					if (child !== current) return;
					buffer += data;
					if (buffer.length > 16384) {
						const error = new Error("Invalid window attention helper response.");
						fail(error);
						finish(error);
						stopChild();
						return;
					}
					let newline;
					while ((newline = buffer.indexOf("\n")) >= 0) {
						const line = buffer.slice(0, newline).trim();
						buffer = buffer.slice(newline + 1);
						if (!line) continue;
						try {
							const message = JSON.parse(line);
							if (message.type === "ready" || message.type === "binding") {
								if (!/^[1-9]\d*$/.test(String(message.windowHandle))) throw new Error("Invalid Terminal window binding.");
								binding = String(message.windowHandle);
								lastError = null;
								finish();
								publish();
							} else if (message.type === "acknowledged" && Number.isSafeInteger(message.generation) &&
								String(message.windowHandle) === binding &&
								message.generation <= state.generation) {
								acknowledgedGeneration = Math.max(acknowledgedGeneration, message.generation);
							} else if (message.type === "previewComplete" &&
								String(message.windowHandle) === binding && !config.enabled) {
								stopChild();
							} else if (message.type === "unavailable") {
								const error = new Error(String(message.message));
								fail(error);
								finish(error);
								stopChild();
							}
						} catch (error) {
							fail(error);
							finish(error);
							stopChild();
						}
					}
				});
				current.stderr.on("data", (data) => { stderr = (stderr + data).slice(-2000); });
				current.stdin.on("error", (error) => { if (child === current && !stopped) fail(error); });
				current.once("error", (error) => {
					if (child === current) { fail(error); finish(error); stopChild(); }
				});
				current.once("close", (code) => {
					if (child !== current) return;
					child = null;
					binding = null;
					previous = null;
					const error = new Error(stderr.trim() || `Window attention helper exited (${code}). Run /session-attention on to retry.`);
					finish(error);
					if (!stopped) fail(error);
				});
				await ready;
			} catch (error) {
				if (!stopped && (config.enabled || preview)) fail(error);
			} finally {
				starting = null;
			}
		})();
		return starting;
	}
	function synchronize() {
		if (!config.enabled && !preview) { stopChild(); return; }
		if (!supported) return;
		if (!child && !preview && state.generation <= acknowledgedGeneration) return;
		if (!child && (state.snapshot().kind || preview)) void start();
		else publish();
	}
	function reload() {
		try {
			const next = readAttentionConfig(home);
			if (!next.enabled) acknowledgedGeneration = Math.max(acknowledgedGeneration, state.generation);
			config = next;
			synchronize();
		} catch (error) {
			config = { ...ATTENTION_DEFAULTS };
			stopChild();
			fail(error);
		}
	}
	reload();
	const onConfigChange = () => {
		if (!stopped) { failed = false; lastError = null; reload(); }
	};
	if (watch) watchFile(attentionConfigPath(home), { persistent: false, interval: 1000 }, onConfigChange);

	return {
		observe(event) {
			if (stopped) return;
			const changed = state.observe(event);
			if (isAttentionInteraction(event) || (event.type === "abort" && !event.agentId && !event.data?.agentId)) {
				acknowledgedGeneration = state.generation;
			}
			if (!config.enabled) acknowledgedGeneration = state.generation;
			if (changed || isAttentionInteraction(event)) {
				synchronize();
			}
			if (event.type === "session.shutdown" && !event.agentId && !event.data?.agentId) this.stop();
		},
		status,
		configure(update) {
			setAttentionConfig(update, { home });
			failed = false;
			lastError = null;
			reload();
			return status();
		},
		async preview(kind = "approval") {
			if (!Object.hasOwn(COLORS, kind)) throw new Error("Preview kind must be approval, question, ready, or error.");
			if (!supported) throw new Error("Window attention requires Windows Terminal on Windows.");
			failed = false;
			lastError = null;
			preview = { kind };
			await start();
			publish();
			if (lastError) {
				preview = null;
				throw new Error(lastError);
			}
		},
		stop() {
			stopped = true;
			preview = null;
			if (watch) unwatchFile(attentionConfigPath(home), onConfigChange);
			stopChild();
		},
	};
}

export async function runAttentionCommand(attention, args = "") {
	const [action = "status", kind, ...extra] = String(args).trim().split(/\s+/).filter(Boolean);
	if (extra.length || (kind && action !== "preview")) throw new Error("Usage: /session-attention [on | off | border | background | both | preview [approval | question | ready | error] | status]");
	if (action === "on" || action === "off") attention.configure({ enabled: action === "on" });
	else if (STYLES.includes(action)) attention.configure({ enabled: true, style: action });
	else if (action === "preview") {
		await attention.preview(kind);
		return "Preview is pulsing until you click/type in this terminal or switch away and return; there is no timeout.";
	} else if (action !== "status") throw new Error("Usage: /session-attention [on | off | border | background | both | preview [approval | question | ready | error] | status]");
	const current = attention.status();
	return `Window attention: ${current.enabled ? "on" : "off"}; style: ${current.style}; ${
		!current.supported ? "requires Windows Terminal on Windows"
			: current.error ? current.error : current.binding ? `bound to Terminal window ${current.binding}`
				: "binds to this session's console on its next attention event"}.`;
}
