import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { configureStatuslines } from "../../../scripts/setup-statusline.mjs";
import { discoverRenderers, ensurePluginStatuslineRegistered, getEnabledStatuslines } from "../compose.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ids = ["pr-statusline", "issue-statusline", "subagent-statusline", "worktree-statusline"];
function fixture(run) {
	const home = mkdtempSync(join(tmpdir(), "statusline-entrypoints-"));
	try { run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}
function node(home, args, input = "") {
	const result = spawnSync(process.execPath, args, {
		input, encoding: "utf8", timeout: 60000, windowsHide: true,
		env: { ...process.env, COPILOT_HOME: home, NO_COLOR: "1" },
	});
	assert.ifError(result.error);
	return result;
}

test("standalone renderers and compositor reject malformed or non-object input without success output", () => fixture((home) => {
	for (const path of [...ids.map((id) => join(root, "extensions", id, "render.mjs")),
		join(root, "extensions", "worktree-statusline", "compose.mjs")]) {
		for (const input of ["{", "null", "[]", "1"]) {
			const result = node(home, [path, "--plain"], input);
			assert.equal(result.status, 1, `${path}: ${input}`);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, /\[(?:worktree|subagent|issue|pr)-statusline\]|\[statusline-compose\]/);
		}
	}
}));

test("standalone renderers and compositor emit zero rows for an empty session", () => fixture((home) => {
	for (const path of [...ids.map((id) => join(root, "extensions", id, "render.mjs")),
		join(root, "extensions", "worktree-statusline", "compose.mjs")]) {
		const result = node(home, [path, "--plain"], "{}");
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "");
	}
}));

function extensionScript(entry, full) {
	return `
		import assert from "node:assert/strict";
		import { registerHooks } from "node:module";
		let configuration;
		const logs = [];
		const session = {
			sessionId: "handler-fixture", capabilities: {},
			log: async value => logs.push(value),
			on: () => () => {}, getEvents: async () => [],
			rpc: { metadata: { activity: async () => ({ hasActiveWork: false }) } },
		};
		globalThis.joinTestSession = async value => { configuration = value; return session; };
		const sdk = "data:text/javascript," + encodeURIComponent("export const joinSession = globalThis.joinTestSession;");
		registerHooks({ resolve(specifier, context, next) {
			return specifier === "@github/copilot-sdk/extension" ? { url: sdk, shortCircuit: true } : next(specifier, context);
		} });
		await import(${JSON.stringify(pathToFileURL(entry).href)});
		const command = name => {
			const entry = configuration.commands.find(item => item.name === name);
			assert.ok(entry, name);
			assert.ok(entry.description);
			return entry.handler;
		};
		await command("session-worktree")({});
		assert.match(logs.pop(), /No Git checkout found/);
		if (${full}) {
			assert.equal(configuration.commands.some(item => ["statusline", "footer"].includes(item.name)), false);
			await command("session-statusline")({ args: "invalid" });
			assert.match(logs.pop(), /Usage:.*refresh.*clear.*setup/);
			const tool = name => configuration.tools.find(item => item.name === name).handler;
			assert.deepEqual(JSON.parse(tool("session_prs")({ action: "list" })), []);
			assert.throws(() => tool("session_prs")({ action: "add", reference: "invalid" }));
			assert.equal(JSON.parse(tool("session_prs")({ action: "add", reference: "example/widget#1" })).length, 1);
			await command("session-prs")({ args: "list" });
			assert.match(logs.pop(), /example\\/widget#1/);
			assert.equal(JSON.parse(tool("session_prs")({ action: "remove", reference: "example/widget#1" })).length, 0);
			await command("session-prs")({ args: "invalid" });
			assert.match(logs.pop(), /Usage:/);
			await command("session-subagents")({ args: "list" });
			assert.match(logs.pop(), /0 starting/);
			await command("session-subagents")({ args: "clear" });
			assert.match(logs.pop(), /Cleared/);
			assert.deepEqual(JSON.parse(tool("session_subagents")({ action: "list" })), []);
			assert.throws(() => tool("session_subagents")({ action: "remove" }), /agent ID/);
			assert.throws(() => tool("session_statusline")({ action: "invalid" }), /clear or refresh/);
			assert.throws(() => tool("session_issues")({ action: "add", reference: "invalid" }));
			assert.equal(JSON.parse(tool("session_issues")({ action: "add", reference: "example/widget#2" })).length, 1);
			await command("session-issues")({ args: "list" });
			assert.match(logs.pop(), /example\\/widget#2/);
			assert.equal(JSON.parse(tool("session_issues")({ action: "clear" })).length, 0);
			const agentsModule = await import(${JSON.stringify(pathToFileURL(join(root, "extensions", "subagent-statusline", "tracker.mjs")).href)});
			for (const adapter of ["command", "tool"]) {
				tool("session_prs")({ action: "add", reference: "example/widget#3" });
				tool("session_issues")({ action: "add", reference: "example/widget#4" });
				const agents = new agentsModule.SubagentTracker(session.sessionId, agentsModule.readState(session.sessionId));
				agents.ensureAgent("active-" + adapter);
				agentsModule.writeState(agents.snapshot());
				if (adapter === "command") {
					await command("session-statusline")({ args: "clear" });
					assert.match(logs.pop(), /Cleared this session/);
				} else {
					assert.match(tool("session_statusline")({ action: "clear" }), /Cleared this session/);
				}
				assert.deepEqual(JSON.parse(tool("session_prs")({ action: "list" })), []);
				assert.deepEqual(JSON.parse(tool("session_issues")({ action: "list" })), []);
				assert.deepEqual(JSON.parse(tool("session_subagents")({ action: "list" })), []);
			}
			await command("session-statusline")({ args: "clear" });
			assert.match(logs.pop(), /Cleared this session/);
			assert.match(tool("session_statusline")({ action: "clear" }), /Cleared this session/);
			assert.match(tool("session_statusline")({ action: "refresh" }), /^Refreshed this session/);
			await command("session-statusline")({ args: "refresh" });
			assert.match(logs.pop(), /^Refreshed this session/);
			await command("session-statusline")({ args: "setup none" });
			const { getEnabledStatuslines } = await import(${JSON.stringify(pathToFileURL(join(root, "extensions", "pr-statusline", "compose.mjs")).href)});
			assert.deepEqual(getEnabledStatuslines(process.env.COPILOT_HOME), []);
			await command("statusline-setup")({ args: "prs" });
			assert.deepEqual(getEnabledStatuslines(process.env.COPILOT_HOME), ["pr-statusline"]);
			const result = JSON.parse(await tool("statusline_setup")({ selection: "none" }));
			assert.deepEqual(result.enabled, []);
		}
		console.log("handlers passed");
	`;
}

test("unified extension handlers manage session state, validate references and configure selections", () => fixture((home) => {
	configureStatuslines({ home, repoRoot: root, enabled: ids });
	const result = node(home, ["--input-type=module", "-e",
		extensionScript(join(root, "extensions", "pr-statusline", "extension.mjs"), true)]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /handlers passed/);
}));

test("PR-only and worktree-only installs start their SDK entry points without enabling siblings", () => fixture((home) => {
	for (const id of ["pr-statusline", "worktree-statusline"]) {
		const isolated = join(home, id);
		configureStatuslines({ home: isolated, repoRoot: root, enabled: [id] });
		assert.deepEqual(getEnabledStatuslines(isolated), [id]);
		assert.deepEqual(discoverRenderers(isolated).map((entry) => entry.name), [id]);
		const result = node(isolated, ["--input-type=module", "-e",
			extensionScript(join(isolated, "extensions", id, "extension.mjs"), false)]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /handlers passed/);
		assert.deepEqual(getEnabledStatuslines(isolated), [id]);
	}
}));

test("plugin auto-registration installs the shared state helper for every standalone component", () => fixture((home) => {
	for (const id of ids) {
		const isolated = join(home, id);
		ensurePluginStatuslineRegistered(id, join(root, "extensions", id), { home: isolated });
		assert.equal(existsSync(join(isolated, "extensions", "state-lock.mjs")), true);
		const tracker = pathToFileURL(join(isolated, "extensions", id, "tracker.mjs")).href;
		const result = node(isolated, ["--input-type=module", "-e", `await import(${JSON.stringify(tracker)});`]);
		assert.equal(result.status, 0, result.stderr);
	}
}));

test("unified and standalone agent commands and tools share populated remove/clear behavior", () => fixture((home) => {
	for (const id of ["pr-statusline", "subagent-statusline"]) {
		const isolated = join(home, id);
		configureStatuslines({ home: isolated, repoRoot: root, enabled: [id] });
		const entry = pathToFileURL(join(isolated, "extensions", id, "extension.mjs")).href;
		const tracker = pathToFileURL(join(root, "extensions", "subagent-statusline", "tracker.mjs")).href;
		const result = node(isolated, ["--input-type=module", "-e", `
			import assert from "node:assert/strict";
			import { readFileSync } from "node:fs";
			import { join } from "node:path";
			import { registerHooks } from "node:module";
			import { SubagentTracker, readState, writeState } from ${JSON.stringify(tracker)};
			let configuration;
			const logs = [];
			const session = {
				sessionId: "adapter-fixture", capabilities: {},
				log: async value => logs.push(value),
				on: () => () => {}, getEvents: async () => [],
				rpc: { metadata: { activity: async () => ({ hasActiveWork: false }) } },
			};
			globalThis.joinTestSession = async value => { configuration = value; return session; };
			const sdk = "data:text/javascript," + encodeURIComponent("export const joinSession = globalThis.joinTestSession;");
			registerHooks({ resolve(specifier, context, next) {
				return specifier === "@github/copilot-sdk/extension" ? { url: sdk, shortCircuit: true } : next(specifier, context);
			} });
			await import(${JSON.stringify(entry)});
			const configPath = join(process.env.COPILOT_HOME, "statusline-config.json");
			const settingsPath = join(process.env.COPILOT_HOME, "settings.json");
			const before = [configPath, settingsPath].map(path => readFileSync(path, "utf8"));
			const other = new SubagentTracker("other-session");
			other.ensureAgent("unrelated");
			writeState(other.snapshot());
			const otherBefore = readState("other-session");
			const command = configuration.commands.find(item => item.name === "session-subagents").handler;
			const tool = configuration.tools.find(item => item.name === "session_subagents").handler;
			for (const adapter of ["command", "tool"]) {
				const first = adapter + "-first", second = adapter + "-second";
				const current = new SubagentTracker(session.sessionId, readState(session.sessionId));
				current.ensureAgent(first);
				current.ensureAgent(second);
				writeState(current.snapshot());
				if (adapter === "command") {
					await command({ args: "list" });
					assert.ok(logs.pop().includes(first));
					await command({ args: "remove " + first });
				} else {
					assert.equal(JSON.parse(tool({ action: "list" })).length, 2);
					assert.deepEqual(JSON.parse(tool({ action: "remove", id: first })).map(agent => agent.id), [second]);
				}
				assert.deepEqual(Object.keys(readState(session.sessionId).agents), [second]);
				if (adapter === "command") await command({ args: "clear" });
				else assert.deepEqual(JSON.parse(tool({ action: "clear" })), []);
				assert.deepEqual(readState(session.sessionId).agents, {});
				assert.deepEqual(readState("other-session"), otherBefore);
				assert.deepEqual([configPath, settingsPath].map(path => readFileSync(path, "utf8")), before);
			}
			console.log("agent adapter parity passed");
		`]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /agent adapter parity passed/);
	}
}));
