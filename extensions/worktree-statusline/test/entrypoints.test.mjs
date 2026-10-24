import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
		env: { ...process.env, COPILOT_HOME: home, LOCALAPPDATA: join(home, "appdata"), NO_COLOR: "1" },
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
		import { mkdirSync, writeFileSync } from "node:fs";
		import { join } from "node:path";
		import { registerHooks } from "node:module";
		import { createSdkHost } from ${JSON.stringify(pathToFileURL(join(root, "extensions", "worktree-statusline", "test", "mock-sdk.mjs")).href)};
		let configuration, observer;
		const logs = [];
		const session = {
			sessionId: "handler-fixture", capabilities: {},
			log: async value => logs.push(value),
			on: fn => { observer = fn; return () => {}; }, getEvents: async () => [],
			rpc: { metadata: { activity: async () => ({ hasActiveWork: false }) } },
		};
		globalThis.joinTestSession = createSdkHost(session, value => { configuration = value; }).joinSession;
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
			await command("session-attention")({ args: "status" });
			assert.match(logs.pop(), /Window attention: off/);
			await command("session-attention")({ args: "both" });
			assert.match(logs.pop(), /Window attention: on; style: both/);
			await command("session-attention")({ args: "off" });
			assert.match(logs.pop(), /Window attention: off/);
			await command("session-attention")({ args: "invalid" });
			assert.match(logs.pop(), /Usage:.*session-attention/);
			await command("session-statusline")({ args: "invalid" });
			assert.match(logs.pop(), /Usage:.*refresh.*clear.*setup/);
			const tool = name => configuration.tools.find(item => item.name === name).handler;
			assert.deepEqual(JSON.parse(await tool("session_prs")({ action: "list" })), []);
			await assert.rejects(tool("session_prs")({ action: "add", reference: "invalid" }));
			assert.equal(JSON.parse(await tool("session_prs")({ action: "add", reference: "example/widget#1" })).length, 1);
			await command("session-prs")({ args: "list" });
			assert.match(logs.pop(), /example\\/widget#1/);
			assert.equal(JSON.parse(await tool("session_prs")({ action: "remove", reference: "example/widget#1" })).length, 0);
			observer({ type: "subagent.started", data: { agentId: "actual-worker" } });
			observer({ type: "tool.execution_start", agentId: "actual-worker", data: {
				toolCallId: "claim-child", toolName: "session_prs",
				arguments: { action: "add", reference: "example/widget#10" },
			} });
			assert.deepEqual(JSON.parse(await tool("session_prs")({ action: "list" })), []);
			const claimed = JSON.parse(await tool("session_prs")({ action: "add", reference: "example/widget#10" },
				{ sessionId: session.sessionId, toolCallId: "claim-child" }));
			assert.equal(claimed[0].owned, true);
			assert.deepEqual(claimed[0].provenance, { root: false, unknown: false, agents: ["actual-worker"] });
			const readded = JSON.parse(await tool("session_prs")({ action: "add", reference: "example/widget#10" },
				{ sessionId: session.sessionId, toolCallId: "unobserved-readd" }));
			assert.deepEqual(readded[0].provenance, { root: false, unknown: true, agents: ["actual-worker"] });
			const unknown = JSON.parse(await tool("session_prs")({ action: "add", reference: "example/widget#11" },
				{ sessionId: session.sessionId, toolCallId: "unobserved-call" }));
			assert.deepEqual(unknown[1].provenance, { root: false, unknown: true, agents: [] });
			await command("session-prs")({ args: "clear" });
			logs.pop();
			await command("session-prs")({ args: "invalid" });
			assert.match(logs.pop(), /Usage:/);
			await command("session-subagents")({ args: "list" });
			assert.match(logs.pop(), /0 starting/);
			await command("session-subagents")({ args: "clear" });
			assert.match(logs.pop(), /Cleared/);
			assert.deepEqual(JSON.parse(await tool("session_subagents")({ action: "list" })), []);
			await assert.rejects(tool("session_subagents")({ action: "remove" }), /agent ID/);
			await assert.rejects(tool("session_statusline")({ action: "invalid" }), /clear or refresh/);
			await assert.rejects(tool("session_issues")({ action: "add", reference: "invalid" }));
			assert.equal(JSON.parse(await tool("session_issues")({ action: "add", reference: "example/widget#2" })).length, 1);
			await command("session-issues")({ args: "list" });
			assert.match(logs.pop(), /example\\/widget#2/);
			assert.equal(JSON.parse(await tool("session_issues")({ action: "clear" })).length, 0);
			const agentsModule = await import(${JSON.stringify(pathToFileURL(join(root, "extensions", "subagent-statusline", "tracker.mjs")).href)});
			await tool("session_prs")({ action: "add", reference: "example/widget#88" });
			const directory = join(process.env.COPILOT_HOME, "session-state", session.sessionId);
			mkdirSync(directory, { recursive: true });
			const transcript = join(directory, "events.jsonl");
			writeFileSync(transcript, '{"type":"tool.execution_start","data":');
			const busy = await tool("session_statusline")({ action: "clear" });
			assert.equal(busy.resultType, "failure");
			assert.match(busy.textResultForLlm, /history is still catching up/);
			assert.equal(JSON.parse(await tool("session_prs")({ action: "list" })).length, 1);
			writeFileSync(transcript, JSON.stringify({ type: "session.start", data: {} }) + "\\n");
			assert.match(await tool("session_statusline")({ action: "clear" }), /^Cleared/);
			for (const adapter of ["command", "tool"]) {
				await tool("session_prs")({ action: "add", reference: "example/widget#3" });
				await tool("session_issues")({ action: "add", reference: "example/widget#4" });
				const agents = new agentsModule.SubagentTracker(session.sessionId, agentsModule.readState(session.sessionId));
				agents.ensureAgent("active-" + adapter);
				agentsModule.writeState(agents.snapshot());
				if (adapter === "command") {
					await command("session-statusline")({ args: "clear" });
					assert.match(logs.pop(), /Cleared this session/);
				} else {
					assert.match(await tool("session_statusline")({ action: "clear" }), /Cleared this session/);
				}
				assert.deepEqual(JSON.parse(await tool("session_prs")({ action: "list" })), []);
				assert.deepEqual(JSON.parse(await tool("session_issues")({ action: "list" })), []);
				assert.deepEqual(JSON.parse(await tool("session_subagents")({ action: "list" })), []);
			}
			await command("session-statusline")({ args: "clear" });
			assert.match(logs.pop(), /Cleared this session/);
			assert.match(await tool("session_statusline")({ action: "clear" }), /Cleared this session/);
			assert.match(await tool("session_statusline")({ action: "refresh" }), /^Refreshed this session/);
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
		extensionScript(join(home, "extensions", "pr-statusline", "extension.mjs"), true)]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /handlers passed/);
}));

test("installer exposes one SDK controller and preserves standalone entry points when upgrading to unified controls", () => fixture((home) => {
	configureStatuslines({ home, repoRoot: root, enabled: ids.filter((id) => id !== "pr-statusline") });
	const customized = join(home, "extensions", "issue-statusline", "extension.mjs");
	const previous = `${readFileSync(customized, "utf8")}\n// Local standalone customization.\n`;
	writeFileSync(customized, previous);
	configureStatuslines({ home, repoRoot: root, enabled: ["pr-statusline"], merge: true });
	assert.deepEqual(new Set(getEnabledStatuslines(home)), new Set(ids));
	assert.deepEqual(ids.filter((id) => existsSync(join(home, "extensions", id, "extension.mjs"))), ["pr-statusline"]);
	const backups = readdirSync(dirname(customized)).filter((name) => name.startsWith("extension.mjs.disabled-"));
	assert.equal(backups.length, 1);
	assert.equal(readFileSync(join(dirname(customized), backups[0]), "utf8"), previous);
	configureStatuslines({ home, repoRoot: root, enabled: ["issue-statusline"] });
	assert.deepEqual(getEnabledStatuslines(home), ["issue-statusline"]);
	assert.deepEqual(ids.filter((id) => existsSync(join(home, "extensions", id, "extension.mjs"))), ["pr-statusline"]);
	const result = node(home, ["--input-type=module", "-e",
		extensionScript(join(home, "extensions", "pr-statusline", "extension.mjs"), true)]);
	assert.equal(result.status, 0, result.stderr);
}));

for (const [legacy, timing] of [
	["subagent-statusline", "normal"], ["pr-statusline", "normal"],
	["subagent-statusline", "already-moved"], ["pr-statusline", "concurrent-move"],
]) {
	test(`plugin startup takes over ${legacy} with ${timing} entrypoints without losing work`, () => fixture((home) => {
		configureStatuslines({ home, repoRoot: root, enabled: [legacy] });
		const oldEntry = join(home, "extensions", legacy, "extension.mjs");
		const original = `${readFileSync(oldEntry, "utf8")}\n// Preserve standalone customization.\n`;
		writeFileSync(oldEntry, original);
		if (timing === "already-moved") renameSync(oldEntry, `${oldEntry}.disabled-other-session`);
		const entry = pathToFileURL(join(root, "extensions", "pr-statusline", "extension.mjs")).href;
		const result = node(home, ["--input-type=module", "-e", `
			import assert from "node:assert/strict";
			import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
			import { dirname, join } from "node:path";
			import { registerHooks } from "node:module";
			import { SubagentTracker, readState as readAgents, writeState as writeAgents } from ${JSON.stringify(pathToFileURL(join(root, "extensions", "subagent-statusline", "tracker.mjs")).href)};
			import { readState } from ${JSON.stringify(pathToFileURL(join(root, "extensions", "pr-statusline", "tracker.mjs")).href)};
			const home = process.env.COPILOT_HOME, id = "plugin-upgrade";
			const worker = new SubagentTracker(id);
			worker.ensureAgent("running-worker");
			writeAgents(worker.snapshot());
			const beforeAgents = readAgents(id);
			const beforeConfig = readFileSync(join(home, "statusline-config.json"), "utf8");
			const legacyId = ${JSON.stringify(`user:${legacy}`)};
			const observers = [], disabled = [];
			let configuration, definitions, joins = 0;
			const session = {
				sessionId: id, capabilities: {}, log: async () => {},
				disconnect: async () => {},
				on(fn) { observers.push(fn); return () => {}; },
				getEvents: async () => [],
				rpc: {
					metadata: { activity: async () => ({ hasActiveWork: false }) },
					extensions: {
						list: async () => ({ extensions: [
							{ id: "plugin:jongio-skills:pr-statusline", pid: process.pid },
							{ id: legacyId, pid: process.pid + 1 },
							{ id: "user:unrelated", pid: process.pid + 2 },
						] }),
						disable: async ({ id }) => { assert.equal(id, legacyId); disabled.push(id); },
					},
				},
			};
			globalThis.joinTestSession = async value => {
				configuration = value;
				if (joins++ === 0) {
					assert.deepEqual(value.tools, [], "bootstrap must not claim conflicting tool names");
					if (${JSON.stringify(timing)} === "concurrent-move") {
						renameSync(${JSON.stringify(oldEntry)}, ${JSON.stringify(`${oldEntry}.disabled-other-session`)});
					}
				} else {
					assert.deepEqual(disabled, [legacyId], "old provider must stop before names are claimed");
					definitions = value.tools;
				}
				return session;
			};
			const sdk = "data:text/javascript," + encodeURIComponent("export const joinSession = globalThis.joinTestSession;");
			registerHooks({ resolve(specifier, context, next) {
				return specifier === "@github/copilot-sdk/extension" ? { url: sdk, shortCircuit: true } : next(specifier, context);
			} });
			await import(${JSON.stringify(entry)});
			assert.deepEqual(readAgents(id), beforeAgents, "SDK handover must not stop or dismiss work agents");
			assert.equal(readFileSync(join(home, "statusline-config.json"), "utf8"), beforeConfig);
			assert.equal(existsSync(${JSON.stringify(oldEntry)}), false);
			const backup = readdirSync(${JSON.stringify(dirname(oldEntry))}).find(name => name.startsWith("extension.mjs.disabled-"));
			assert.equal(readFileSync(join(${JSON.stringify(dirname(oldEntry))}, backup), "utf8"), ${JSON.stringify(original)});
			assert.equal(joins, 2);
			assert.ok(definitions.every(tool => typeof tool.handler === "function"));
			for (const name of ["session_prs", "session_issues", "session_subagents", "session_statusline"]) {
				assert.ok(definitions.some(tool => tool.name === name), name);
			}
			let sequence = 0;
			const emit = event => observers.forEach(handler => handler(event));
			const invoke = async (toolName, args, toolCallId = "tool-" + sequence++) => {
				try {
					return { result: await definitions.find(tool => tool.name === toolName).handler(args, {
						sessionId: id, toolCallId, toolName, arguments: args,
					}) };
				} catch (error) { return { error: error.message }; }
			};
			const args = { action: "add", reference: "acme/app#42" };
			emit({ type: "tool.execution_start", agentId: "running-worker", data: {
				toolName: "session_prs", toolCallId: "owned-call", arguments: args,
			} });
			const added = await invoke("session_prs", args, "owned-call");
			assert.equal(JSON.parse(added.result)[0].owned, true);
			assert.deepEqual(readState(id).prs[0].provenance, { root: false, unknown: false, agents: ["running-worker"] });
			await invoke("session_prs", args);
			assert.equal(readState(id).prs[0].provenance.unknown, true);
			assert.ok((await invoke("session_prs", { action: "add", reference: "invalid" })).error);
			assert.equal(JSON.parse((await invoke("session_subagents", { action: "list" })).result).length, 1);
			assert.match((await invoke("session_statusline", { action: "clear" })).result, /^Cleared/);
			assert.deepEqual(readState(id).prs, []);
			assert.deepEqual(readAgents(id).agents, {});
			console.log("plugin upgrade passed");
		`]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /plugin upgrade passed/);
	}));
}

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
			import { createSdkHost } from ${JSON.stringify(pathToFileURL(join(root, "extensions", "worktree-statusline", "test", "mock-sdk.mjs")).href)};
			let configuration;
			const logs = [];
			const session = {
				sessionId: "adapter-fixture", capabilities: {},
				log: async value => logs.push(value),
				on: () => () => {}, getEvents: async () => [],
				rpc: { metadata: { activity: async () => ({ hasActiveWork: false }) } },
			};
			globalThis.joinTestSession = createSdkHost(session, value => { configuration = value; }).joinSession;
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
					assert.equal(JSON.parse(await tool({ action: "list" })).length, 2);
					assert.deepEqual(JSON.parse(await tool({ action: "remove", id: first })).map(agent => agent.id), [second]);
				}
				assert.deepEqual(Object.keys(readState(session.sessionId).agents), [second]);
				if (adapter === "command") await command({ args: "clear" });
				else assert.deepEqual(JSON.parse(await tool({ action: "clear" })), []);
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
