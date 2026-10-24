import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AttentionState } from "../attention-state.mjs";
import {
	attentionConfigPath, buildAttentionHelper, createSessionAttention, readAttentionConfig,
	runAttentionCommand, setAttentionConfig,
} from "../attention.mjs";
import { collect } from "../collector.mjs";
import { ensurePluginStatuslineRegistered, setEnabledStatuslines } from "../compose.mjs";
import { configureStatuslines } from "../../../scripts/setup-statusline.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const event = (type, data = {}, extra = {}) => ({ type, data, ...extra });
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(run) {
	const home = realpathSync.native(mkdtempSync(join(tmpdir(), "statusline-attention-")));
	try { await run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

function fakeHelper() {
	const children = [], messages = [];
	function spawn(executable, args, options) {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.stdin = new Writable({
			write(data, _encoding, done) { messages.push(JSON.parse(String(data))); done(); },
		});
		child.stdin.once("finish", () => queueMicrotask(() => child.emit("close", 0)));
		child.kill = () => { child.emit("close", 0); };
		child.message = (value) => child.stdout.write(`${JSON.stringify({ windowHandle: "1234", ...value })}\n`);
		children.push({ child, executable, args, options });
		queueMicrotask(() => child.message({ type: "ready", windowHandle: "1234" }));
		return child;
	}
	return { children, messages, spawn };
}

function controller(home, overrides = {}) {
	const helper = fakeHelper();
	const reports = [];
	const attention = createSessionAttention({
		home, platform: "win32", env: { WT_SESSION: "fixture" }, ownerProcessId: 321,
		spawn: helper.spawn, build: async () => "attention.exe", watch: false,
		report: (value) => reports.push(value), ...overrides,
	});
	return { attention, helper, reports };
}

test("historical and auto-resolved requests never create alerts; duplicate live requests do not re-arm", () => {
	const state = new AttentionState();
	assert.equal(state.observe(event("permission.requested", { requestId: "old" }), { history: true }), false);
	assert.equal(state.observe(event("permission.requested", { requestId: "auto", resolvedByHook: true })), false);
	assert.deepEqual(state.snapshot(), { generation: 0, kind: null });
	assert.equal(state.observe(event("permission.requested", { requestId: "real" })), true);
	assert.deepEqual(state.snapshot(), { generation: 1, kind: "approval" });
	assert.equal(state.observe(event("permission.requested", { requestId: "real" })), false);
	state.observe(event("permission.completed", { requestId: "unknown" }));
	assert.equal(state.snapshot().kind, "approval");
	state.observe(event("permission.completed", { requestId: "real" }));
	assert.deepEqual(state.snapshot(), { generation: 1, kind: null });
	assert.equal(state.observe(event("permission.requested", { requestId: "real" })), false);
	assert.equal(state.observe(event("permission.requested", { requestId: "auto" })), false);
});

test("questions and plan approval have distinct generations and unrelated completions cannot clear them", () => {
	const state = new AttentionState();
	state.observe(event("exit_plan_mode.requested", { requestId: "plan" }));
	assert.equal(state.snapshot().kind, "approval");
	state.observe(event("user_input.requested", { requestId: "answer" }));
	assert.deepEqual(state.snapshot(), { generation: 2, kind: "question" });
	state.observe(event("user_input.completed", { requestId: "answer" }));
	assert.deepEqual(state.snapshot(), { generation: 2, kind: "approval" });
	state.observe(event("exit_plan_mode.completed", { requestId: "plan" }));
	state.observe(event("elicitation.requested", { requestId: "dialog" }, { agentId: "child" }));
	assert.deepEqual(state.snapshot(), { generation: 3, kind: "question" });
});

test("only root idle after live work emits ready; individual turns, background completion and repeated idle do not", () => {
	const state = new AttentionState();
	state.observe(event("user.message", { content: "work" }));
	state.observe(event("assistant.turn_start"));
	for (const type of ["assistant.turn_end", "model.turn_ended", "subagent.completed", "subagent.failed"]) {
		state.observe(event(type));
		assert.equal(state.snapshot().kind, null);
	}
	state.observe(event("session.idle", {}, { agentId: "child" }));
	assert.equal(state.snapshot().kind, null);
	state.observe(event("session.idle"));
	assert.deepEqual(state.snapshot(), { generation: 1, kind: "ready" });
	assert.equal(state.observe(event("session.idle")), false);
	assert.equal(state.observe(event("subagent.completed")), false);
});

test("idle cannot replace a question; error is not success; interruption, shutdown and new work clear alerts", () => {
	const state = new AttentionState();
	state.observe(event("assistant.turn_start"));
	state.observe(event("user_input.requested", { requestId: "answer" }));
	state.observe(event("session.idle"));
	assert.equal(state.snapshot().kind, "question");
	state.observe(event("session.error", {}, { id: "error" }));
	const failed = state.snapshot();
	assert.equal(failed.kind, "error");
	assert.equal(state.observe(event("session.error", {}, { id: "error" })), false);
	state.observe(event("session.idle"));
	assert.deepEqual(state.snapshot(), failed);
	state.observe(event("user.message", { content: "retry" }));
	assert.equal(state.snapshot().kind, null);
	assert.equal(state.observe(event("session.error", {}, { id: "error" })), false);
	state.observe(event("abort"));
	state.observe(event("session.idle"));
	assert.equal(state.snapshot().kind, null);
	state.observe(event("permission.requested", { requestId: "permission" }));
	state.observe(event("session.shutdown"));
	assert.equal(state.snapshot().kind, null);
});

test("scheduled and injected messages do not create response-ready alerts", () => {
	for (const data of [
		{ content: "[Scheduled prompt tick]" }, { source: "skill-foo" },
		{ content: "<skill-context>instructions" }, { source: "session-memory-rollover" },
		{ content: "<system_notification>background finished</system_notification>" },
		{ isAutopilotContinuation: true },
	]) {
		const state = new AttentionState();
		state.observe(event("user.message", data));
		state.observe(event("assistant.turn_start"));
		state.observe(event("session.idle"));
		assert.equal(state.snapshot().kind, null, JSON.stringify(data));
	}
});

test("settings-only messages cannot create ready, and skill injections do not erase a real user turn", () => {
	const state = new AttentionState();
	state.observe(event("user.message", { content: "/session-attention on" }));
	state.observe(event("session.idle"));
	assert.deepEqual(state.snapshot(), { generation: 0, kind: null });
	state.observe(event("user.message", { content: "real work" }));
	state.observe(event("user.message", { source: "skill-example", content: "instructions" }));
	state.observe(event("assistant.turn_start"));
	state.observe(event("user.message", { content: "<system_notification>background status</system_notification>" }));
	state.observe(event("session.idle"));
	assert.deepEqual(state.snapshot(), { generation: 1, kind: "ready" });
	state.observe(event("user.message", { source: "session-memory-rollover" }));
	assert.deepEqual(state.snapshot(), { generation: 1, kind: "ready" });
});

test("configuration is opt-in, validates presentation, and preserves future settings and custom colors", async () => fixture((home) => {
	assert.equal(readAttentionConfig(home).enabled, false);
	writeFileSync(attentionConfigPath(home), '{"future":{"keep":true},"colors":{"approval":"#123456"}}');
	const saved = setAttentionConfig({ enabled: true, style: "background" }, { home });
	assert.equal(saved.enabled, true);
	assert.equal(saved.colors.approval, "#123456");
	assert.deepEqual(saved.future, { keep: true });
	assert.throws(() => setAttentionConfig({ style: "unsupported" }, { home }), /style/);
	assert.throws(() => setAttentionConfig({ colors: { ready: "red" } }, { home }), /RRGGBB/);
	assert.throws(() => setAttentionConfig({ colors: null }, { home }), /object/);
	assert.throws(() => setAttentionConfig({ enabled: "true" }, { home }), /true or false/);
	assert.equal(readAttentionConfig(home).style, "background");
	writeFileSync(attentionConfigPath(home), "{invalid");
	assert.throws(() => setAttentionConfig({ enabled: true }, { home }));
	assert.equal(readFileSync(attentionConfigPath(home), "utf8"), "{invalid");
}));

test("helper starts lazily, binds to the session process and receives no prompts or tool content", async () => fixture(async (home) => {
	setAttentionConfig({ enabled: true }, { home });
	const { attention, helper } = controller(home);
	try {
		assert.equal(helper.children.length, 0);
		attention.observe(event("user.message", { content: "PRIVATE PROMPT" }));
		assert.equal(helper.children.length, 0);
		attention.observe(event("user_input.requested", { requestId: "q", prompt: "PRIVATE QUESTION" }));
		await flush();
		assert.equal(helper.children.length, 1);
		assert.deepEqual(helper.children[0].args, ["321"]);
		assert.equal(helper.children[0].options.windowsHide, true);
		assert.equal(attention.status().binding, "1234");
		assert.deepEqual(helper.messages[0], {
			type: "alert", generation: 1, kind: "question", style: "both", color: "#B48CFF", acknowledged: false,
		});
		assert.doesNotMatch(JSON.stringify(helper.messages), /PRIVATE/);
		const count = helper.messages.length;
		attention.observe(event("user_input.requested", { requestId: "q" }));
		attention.observe(event("tool.execution_complete", { content: "PRIVATE RESULT" }));
		assert.equal(helper.messages.length, count);
	} finally { attention.stop(); }
}));

test("focus acknowledgment survives settings changes; a new request gets a fresh alert", async () => fixture(async (home) => {
	setAttentionConfig({ enabled: true }, { home });
	const { attention, helper } = controller(home);
	try {
		attention.observe(event("permission.requested", { requestId: "one" }));
		await flush();
		helper.children[0].child.message({ type: "acknowledged", generation: 1 });
		attention.configure({ style: "border" });
		assert.equal(helper.messages.at(-1).acknowledged, true);
		assert.equal(helper.messages.at(-1).generation, 1);
		attention.observe(event("permission.requested", { requestId: "two" }));
		assert.equal(helper.messages.at(-1).generation, 2);
		assert.equal(helper.messages.at(-1).acknowledged, false);
		attention.observe(event("abort"));
		assert.equal(helper.messages.at(-1).kind, null);
		assert.equal(helper.messages.at(-1).acknowledged, true);
	} finally { attention.stop(); }
}));

test("only acknowledgment from this session's exact bound window can dismiss its alert or preview", async () => fixture(async (home) => {
	setAttentionConfig({ enabled: true }, { home });
	const { attention, helper } = controller(home);
	try {
		attention.observe(event("permission.requested", { requestId: "current" }));
		await flush();
		const child = helper.children[0].child;
		child.message({ type: "acknowledged", generation: 1, windowHandle: "9999" });
		attention.configure({ style: "border" });
		assert.equal(helper.messages.at(-1).acknowledged, false);
		child.message({ type: "acknowledged", generation: 1 });
		attention.configure({ style: "both" });
		assert.equal(helper.messages.at(-1).acknowledged, true);
	} finally { attention.stop(); }
	const preview = controller(home);
	try {
		preview.attention.configure({ enabled: false });
		await preview.attention.preview();
		const child = preview.helper.children[0].child;
		child.message({ type: "previewComplete", windowHandle: "9999" });
		assert.equal(child.stdin.writableEnded, false);
		child.message({ type: "previewComplete" });
		await flush();
		assert.equal(child.stdin.writableEnded, true);
	} finally { preview.attention.stop(); }
}));

test("unresolved input stays active through working/idle updates; resolving it and resuming clears it", async () => fixture(async (home) => {
	setAttentionConfig({ enabled: true }, { home });
	const { attention, helper } = controller(home);
	try {
		attention.observe(event("permission.requested", { requestId: "pending" }));
		await flush();
		for (let tick = 0; tick < 100; tick++) {
			for (const type of ["assistant.turn_start", "assistant.turn_end", "model.turn_started",
				"session.compaction_start", "session.compaction_complete", "subagent.completed", "session.idle"]) {
				attention.observe(event(type));
				assert.equal(helper.messages.at(-1).kind, "approval", type);
				assert.equal(helper.messages.at(-1).acknowledged, false, type);
			}
		}
		assert.equal(helper.messages.length, 1, "A pending request must not acquire a timer or be reset by refreshes.");
		attention.observe(event("permission.completed", { requestId: "pending" }));
		attention.observe(event("assistant.turn_start"));
		assert.equal(helper.messages.at(-1).kind, null, "No alert is needed once Copilot can continue.");
		attention.observe(event("user_input.requested", { requestId: "next" }));
		assert.equal(helper.messages.at(-1).kind, "question");
		assert.equal(helper.messages.at(-1).acknowledged, false);
		attention.observe(event("user.message", { content: "Here is my answer" }));
		assert.equal(helper.messages.at(-1).kind, null);
		assert.equal(helper.messages.at(-1).acknowledged, true);
	} finally { attention.stop(); }
}));

test("response-ready clears when Copilot resumes on its own rather than latching obsolete attention", async () => fixture(async (home) => {
	setAttentionConfig({ enabled: true }, { home });
	const { attention, helper } = controller(home);
	try {
		attention.observe(event("assistant.turn_start"));
		attention.observe(event("session.idle"));
		await flush();
		assert.equal(helper.messages.at(-1).kind, "ready");
		attention.observe(event("user.message", { content: "[Scheduled prompt continue working]" }));
		attention.observe(event("assistant.turn_start"));
		assert.equal(helper.messages.at(-1).kind, null);
	} finally { attention.stop(); }
}));

test("running sessions reload shared preferences independently without re-arming seen alerts", { timeout: 10000 }, async () => fixture(async (home) => {
	setAttentionConfig({ enabled: true }, { home });
	const first = controller(home, { watch: true });
	const second = controller(home, { watch: true });
	async function until(predicate) {
		const deadline = Date.now() + 5000;
		while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
		assert.ok(predicate(), "Running sessions did not reload shared preferences.");
	}
	try {
		first.attention.observe(event("permission.requested", { requestId: "first" }));
		second.attention.observe(event("permission.requested", { requestId: "second" }));
		await flush();
		first.helper.children[0].child.message({ type: "acknowledged", generation: 1 });
		setAttentionConfig({ style: "background" }, { home });
		await until(() => first.attention.status().style === "background" && second.attention.status().style === "background");
		assert.equal(first.helper.messages.at(-1).generation, 1);
		assert.equal(first.helper.messages.at(-1).acknowledged, true);
		assert.equal(second.helper.messages.at(-1).acknowledged, false);
		first.attention.stop();
		setAttentionConfig({ enabled: false }, { home });
		await until(() => !second.attention.status().enabled);
		assert.equal(second.helper.children[0].child.stdin.writableEnded, true);
	} finally {
		first.attention.stop();
		second.attention.stop();
	}
}));

test("disabled events do not replay on enable, and disabling stops the owned helper", async () => fixture(async (home) => {
	const { attention, helper } = controller(home);
	try {
		attention.observe(event("permission.requested", { requestId: "old" }));
		assert.equal(helper.children.length, 0);
		attention.configure({ enabled: true });
		await flush();
		assert.equal(helper.children.length, 0);
		attention.observe(event("permission.requested", { requestId: "new" }));
		await flush();
		assert.equal(helper.messages.at(-1).acknowledged, false);
		assert.equal(helper.messages.at(-1).generation, 2);
		attention.configure({ enabled: false });
		await flush();
		assert.equal(helper.children[0].child.stdin.writableEnded, true);
		assert.equal(attention.status().binding, null);
	} finally { attention.stop(); }
}));

test("unsupported platforms never spawn; native failures are isolated and explicitly reported", async () => fixture(async (home) => {
	setAttentionConfig({ enabled: true }, { home });
	for (const overrides of [{ platform: "linux" }, { platform: "darwin" }, { env: {} }]) {
		const { attention, helper } = controller(home, overrides);
		try {
			attention.observe(event("permission.requested", { requestId: "q" }));
			await flush();
			assert.equal(helper.children.length, 0);
			await assert.rejects(attention.preview(), /requires Windows Terminal/);
		} finally { attention.stop(); }
	}
	const { attention, helper, reports } = controller(home);
	try {
		attention.observe(event("permission.requested", { requestId: "q" }));
		await flush();
		helper.children[0].child.message({ type: "unavailable", message: "No verified console owner." });
		await flush();
		assert.match(attention.status().error, /verified console/);
		assert.equal(reports.length, 1);
		assert.equal(attention.status().binding, null);
	} finally { attention.stop(); }
}));

test("stopping during compilation prevents an orphan helper from launching", async () => fixture(async (home) => {
	setAttentionConfig({ enabled: true }, { home });
	let finish;
	const { attention, helper } = controller(home, { build: () => new Promise((resolve) => { finish = resolve; }) });
	attention.observe(event("permission.requested", { requestId: "q" }));
	attention.stop();
	finish("attention.exe");
	await flush();
	assert.equal(helper.children.length, 0);
}));

test("a request resolved during compilation does not launch a stale alert helper", async () => fixture(async (home) => {
	setAttentionConfig({ enabled: true }, { home });
	let finish;
	const { attention, helper } = controller(home, { build: () => new Promise((resolve) => { finish = resolve; }) });
	try {
		attention.observe(event("permission.requested", { requestId: "q" }));
		attention.observe(event("permission.completed", { requestId: "q" }));
		finish("attention.exe");
		await flush();
		assert.equal(helper.children.length, 0);
	} finally { attention.stop(); }
}));

test("preview has no timer, clears on interaction, works while disabled and does not opt the user in", async () => fixture(async (home) => {
	const { attention, helper } = controller(home);
	try {
		assert.match(await runAttentionCommand(attention, "preview error"), /no timeout/);
		await flush();
		assert.equal(readAttentionConfig(home).enabled, false);
		assert.equal(helper.messages.at(-1).type, "preview");
		assert.equal(helper.messages.at(-1).color, "#EF5F5F");
		assert.equal(Object.hasOwn(helper.messages.at(-1), "durationMs"), false);
		helper.children[0].child.message({ type: "previewComplete" });
		await flush();
		assert.equal(helper.children[0].child.stdin.writableEnded, true);
		await assert.rejects(runAttentionCommand(attention, "preview invalid"), /Preview kind/);
		await assert.rejects(runAttentionCommand(attention, "on invalid"), /Usage:/);
	} finally { attention.stop(); }
}));

test("collector forwards queued and live events, never replayed history, and owns attention cleanup", async () => fixture(async (home) => {
	let handler, stopped = false;
	const observed = [];
	const collector = await collect({
		sessionId: "attention-fixture",
		on(fn) { handler = fn; return () => {}; },
		async getEvents() {
			handler(event("user_input.requested", { requestId: "live" }));
			return [event("permission.requested", { requestId: "old" })];
		},
		rpc: { metadata: { activity: async () => ({ hasActiveWork: false }) } },
	}, {
		home, interval: 100000,
		attention: { observe(value) { observed.push(value); }, stop() { stopped = true; } },
	});
	try {
		assert.deepEqual(observed.map((value) => value.data.requestId), ["live"]);
		handler(event("permission.requested", { requestId: "next" }));
		assert.deepEqual(observed.map((value) => value.data.requestId), ["live", "next"]);
	} finally { collector.stop(); }
	assert.equal(stopped, true);
}));

test("statusline reconfiguration preserves independent attention settings and packages every helper asset", async () => fixture((home) => {
	setAttentionConfig({ enabled: true, style: "border" }, { home });
	const original = readFileSync(attentionConfigPath(home), "utf8");
	configureStatuslines({ home, repoRoot: root, enabled: ["pr-statusline"] });
	for (const file of ["attention.mjs", "attention-state.mjs", "attention.windows.cs"]) {
		assert.equal(existsSync(join(home, "extensions", "pr-statusline", file)), true, file);
	}
	setEnabledStatuslines([], { home });
	assert.equal(readFileSync(attentionConfigPath(home), "utf8"), original);
	const pluginHome = join(home, "plugin");
	ensurePluginStatuslineRegistered("pr-statusline", join(root, "extensions", "pr-statusline"), { home: pluginHome, includeSiblings: true });
	assert.equal(existsSync(join(pluginHome, "extensions", "pr-statusline", "attention.windows.cs")), true);
	for (const script of ["install-statusline.ps1", "install-statusline.sh"]) {
		const source = readFileSync(join(root, script), "utf8");
		for (const file of ["attention.mjs", "attention-state.mjs", "attention.windows.cs"]) assert.ok(source.includes(file), `${script}: ${file}`);
	}
}));

test("native helper compiles, caches its build, latches focus until a new generation, and never guesses a window", {
	skip: process.platform !== "win32",
}, async (t) => fixture(async (home) => {
	const executable = await buildAttentionHelper({ home });
	assert.equal(await buildAttentionHelper({ home }), executable);
	const latch = spawnSync(executable, ["--self-test"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
	assert.equal(latch.status, 0, latch.stderr);
	assert.deepEqual(JSON.parse(latch.stdout), { type: "selfTest", passed: true });
	const isolated = spawnSync(executable, ["--focus-isolation-test"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
	assert.equal(isolated.status, 0, isolated.stderr || isolated.stdout);
	assert.deepEqual(JSON.parse(isolated.stdout), {
		type: "focusIsolationTest", passed: true, sameProcessWindows: true,
		ownedWindowExcluded: true, newWindowExcluded: true, transientActivationExcluded: true,
	});
	const persistence = spawnSync(executable, ["--persistence-test"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
	assert.equal(persistence.status, 0, persistence.stderr || persistence.stdout);
	const sustained = JSON.parse(persistence.stdout);
	assert.equal(sustained.type, "persistenceTest");
	assert.equal(sustained.passed, true);
	assert.ok(sustained.elapsedMs >= 12500, "Attention must outlive the old six-second preview cutoff.");
	assert.ok(sustained.samples >= 10);
	const unavailable = spawnSync(executable, ["429496729"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
	assert.equal(unavailable.status, 1);
	assert.equal(JSON.parse(unavailable.stdout).type, "unavailable");
	if (process.env.WT_SESSION) {
		const bound = spawnSync(executable, [String(process.pid), "--probe"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
		assert.equal(bound.status, 0, bound.stderr || bound.stdout);
		const value = JSON.parse(bound.stdout);
		assert.equal(value.type, "ready");
		assert.match(value.windowHandle, /^[1-9]\d*$/);
		assert.match(value.consoleWindow, /^[1-9]\d*$/);
		const powershell = join(process.env.WINDIR, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		const rendered = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
			join(root, "extensions", "pr-statusline", "test", "attention-render.ps1"),
			"-Executable", executable, "-OwnerProcessId", String(process.pid)], {
			encoding: "utf8", windowsHide: true, timeout: 15000,
		});
		assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);
		const pixels = JSON.parse(rendered.stdout.trim());
		assert.equal(pixels.type, "renderTest");
		if (pixels.visible) assert.equal(pixels.passed, true);
		t.diagnostic(pixels.visible ? "Border/background pixels verified on the bound Terminal window."
			: `Native pixel comparison unavailable: ${pixels.reason}`);
		setAttentionConfig({ enabled: true }, { home });
		let helperProcess;
		const reports = [];
		const attention = createSessionAttention({
			home, watch: false, build: async () => executable,
			spawn(...args) { helperProcess = spawn(...args); return helperProcess; },
			report: (message) => reports.push(message),
		});
		try {
			attention.observe(event("permission.requested", { requestId: "native" }));
			const deadline = Date.now() + 5000;
			while (!attention.status().binding && !attention.status().error && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.equal(attention.status().binding, value.windowHandle, reports.join("\n"));
			const closed = once(helperProcess, "close");
			attention.stop();
			const [code] = await closed;
			assert.equal(code, 0, reports.join("\n"));
			assert.deepEqual(reports, []);
		} finally {
			attention.stop();
			if (helperProcess && helperProcess.exitCode === null) helperProcess.kill();
		}
	}
}));
