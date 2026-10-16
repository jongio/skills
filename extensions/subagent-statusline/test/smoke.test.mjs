import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SubagentTracker } from "../tracker.mjs";
import { render } from "../render.mjs";
import {
	composeStatusLine,
	detectNerdFontFromWindowsTerminalSettings,
	discoverRenderers,
	ensurePluginStatuslineRegistered,
	isNerdFontName,
	joinOutputsHorizontally,
	runInteractiveStatuslinePicker,
	toUnicodeIcons,
} from "../compose.mjs";
import { configureStatuslines, parseStatuslineArgs } from "../../../scripts/setup-statusline.mjs";

const home = mkdtempSync(join(tmpdir(), "subagent-statusline-test-"));
const event = (type, data = {}, agentId, timestamp = new Date(1000).toISOString()) => ({
	type,
	data,
	agentId,
	timestamp,
});

try {
	const tracker = new SubagentTracker("sub-session");
	// Exploratory subagents are ignored
	tracker.observe(event("subagent.started", { agentId: "exp-1", agentType: "explore", agentName: "explore" }));
	assert.equal(tracker.counts().total, 0);

	// 3 developer subagents start
	tracker.observe(event("subagent.started", { agentId: "agent-1", toolCallId: "tc-1", agentName: "devx-developer" }, "agent-1", new Date(1000).toISOString()));
	tracker.observe(event("subagent.started", { agentId: "agent-2", toolCallId: "tc-2", agentName: "devx-developer" }, "agent-2", new Date(1100).toISOString()));
	tracker.observe(event("subagent.started", { agentId: "agent-3", toolCallId: "tc-3", agentName: "devx-developer" }, "agent-3", new Date(1200).toISOString()));
	assert.deepEqual(tracker.counts(), { total: 3, starting: 3, inPr: 0, merged: 0, done: 0, failed: 0 });

	// agent-1 opens PR #101 -> moves to inPr
	tracker.observe(event("tool.execution_start", {
		toolCallId: "pr-create-1",
		toolName: "powershell",
		arguments: { command: "gh pr create --repo Azure/azure-dev --title 'feat 1'" },
	}, "agent-1", new Date(2000).toISOString()));
	tracker.observe(event("tool.execution_complete", {
		toolCallId: "pr-create-1",
		success: true,
		result: { content: "https://github.com/Azure/azure-dev/pull/101" },
	}, "agent-1", new Date(2100).toISOString()));
	assert.deepEqual(tracker.counts(), { total: 3, starting: 2, inPr: 1, merged: 0, done: 0, failed: 0 });

	// agent-2 opens PR #102 and merges it -> moves to merged
	tracker.observe(event("tool.execution_start", {
		toolCallId: "pr-merge-2",
		toolName: "powershell",
		arguments: { command: "gh pr merge https://github.com/Azure/azure-dev/pull/102 --squash" },
	}, "agent-2", new Date(2500).toISOString()));
	tracker.observe(event("tool.execution_complete", {
		toolCallId: "pr-merge-2",
		success: true,
		result: { content: "Merged" },
	}, "agent-2", new Date(2600).toISOString()));
	assert.deepEqual(tracker.counts(), { total: 3, starting: 1, inPr: 1, merged: 1, done: 0, failed: 0 });

	// Live transcript rendering test
	const transcriptDir = join(home, "session-state", "live-subagents");
	mkdirSync(transcriptDir, { recursive: true });
	const transcriptFile = join(transcriptDir, "events.jsonl");
	writeFileSync(
		transcriptFile,
		[
			JSON.stringify(event("subagent.started", { agentId: "a1", toolCallId: "t1", agentName: "devx-developer" }, "a1", new Date(1000).toISOString())),
			JSON.stringify(event("subagent.started", { agentId: "a2", toolCallId: "t2", agentName: "devx-developer" }, "a2", new Date(1100).toISOString())),
			JSON.stringify(event("tool.execution_start", { toolCallId: "c2", toolName: "powershell", arguments: { command: "gh pr view https://github.com/Azure/azure-dev/pull/4812" } }, "a2", new Date(1200).toISOString())),
		].join("\n") + "\n",
	);
	const plainOut = render({ session_id: "live-subagents", transcript_path: transcriptDir }, { home, links: false, color: false });
	assert.equal(plainOut, "\uF4B8 \uF252 1 starting \uE726 1 in PR");

	// When both subagents finish & merge, pill turns purple and dismisses on next user input
	appendFileSync(
		transcriptFile,
		[
			JSON.stringify(event("tool.execution_start", { toolCallId: "m1", toolName: "powershell", arguments: { command: "gh pr merge https://github.com/Azure/azure-dev/pull/4811 --squash" } }, "a1", new Date(2000).toISOString())),
			JSON.stringify(event("tool.execution_complete", { toolCallId: "m1", success: true, result: { content: "Merged" } }, "a1", new Date(2100).toISOString())),
			JSON.stringify(event("tool.execution_start", { toolCallId: "m2", toolName: "powershell", arguments: { command: "gh pr merge https://github.com/Azure/azure-dev/pull/4812 --squash" } }, "a2", new Date(2200).toISOString())),
			JSON.stringify(event("tool.execution_complete", { toolCallId: "m2", success: true, result: { content: "Merged" } }, "a2", new Date(2300).toISOString())),
			JSON.stringify(event("subagent.completed", { agentId: "a1", toolCallId: "t1", agentName: "devx-developer" }, "a1", new Date(2400).toISOString())),
			JSON.stringify(event("subagent.completed", { agentId: "a2", toolCallId: "t2", agentName: "devx-developer" }, "a2", new Date(2500).toISOString())),
		].join("\n") + "\n",
	);
	const mergedColorOut = render({ session_id: "live-subagents", transcript_path: transcriptDir }, { home, links: false, color: true });
	assert.ok(mergedColorOut.includes("\x1b[1;38;2;237;224;255;48;2;88;44;142m \uF4B8 \uE727 2 merged \x1b[0m"), "all-merged subagents use purple pill");

	appendFileSync(transcriptFile, `${JSON.stringify(event("user.message", { content: "Next task" }, undefined, new Date(3000).toISOString()))}\n`);
	assert.equal(render({ session_id: "live-subagents", transcript_path: transcriptDir }, { home, links: false, color: false }), "");

	// Horizontal composition of multi-line pills
	const joined = joinOutputsHorizontally(["top1\nmid1\nbot1", "top2\nmid2\nbot2"], { color: true });
	assert.equal(joined, "top1 top2\nmid1 mid2\nbot1 bot2");
	assert.equal(await composeStatusLine({ session_id: "none" }, { home }), "");

	// Interactive/CLI setup configurator and statusline-config.json filtering test
	assert.deepEqual(parseStatuslineArgs(["--all"]), ["pr-statusline", "issue-statusline", "subagent-statusline"]);
	assert.deepEqual(parseStatuslineArgs(["--prs", "--subagents"]), ["pr-statusline", "subagent-statusline"]);
	assert.deepEqual(parseStatuslineArgs(["--no-issues"]), ["pr-statusline", "subagent-statusline"]);
	assert.equal(parseStatuslineArgs([]), null);

	const setupHome = mkdtempSync(join(tmpdir(), "statusline-setup-test-"));
	try {
		const res = configureStatuslines({
			enabled: ["pr-statusline"],
			home: setupHome,
		});
		assert.deepEqual(res.enabled, ["pr-statusline"]);
		const mergedRes = configureStatuslines({
			enabled: ["subagent-statusline"],
			merge: true,
			home: setupHome,
		});
		assert.deepEqual(mergedRes.enabled, ["pr-statusline", "subagent-statusline"]);
		const discovered = discoverRenderers(setupHome).map((r) => r.name);
		assert.deepEqual(discovered, ["pr-statusline", "subagent-statusline"]);

		const pluginHome = mkdtempSync(join(tmpdir(), "statusline-plugin-bootstrap-"));
		try {
			const extDir = dirname(fileURLToPath(new URL("../render.mjs", import.meta.url)));
			const boot = ensurePluginStatuslineRegistered("subagent-statusline", extDir, { home: pluginHome });
			assert.equal(boot.firstRun, true);
			const pluginDiscovered = discoverRenderers(pluginHome).map((r) => r.name);
			assert.deepEqual(pluginDiscovered, ["subagent-statusline"]);

			ensurePluginStatuslineRegistered("subagent-statusline", extDir, { home: pluginHome, includeSiblings: true });
			assert.deepEqual(discoverRenderers(pluginHome).map((r) => r.name), ["pr-statusline", "issue-statusline", "subagent-statusline"]);

			// Test interactive elicitation picker via mock session.ui.elicitation
			const logs = [];
			const mockSession = {
				capabilities: { ui: { elicitation: true } },
				ui: {
					elicitation: async (params) => {
						assert.ok(params.requestedSchema.properties.prs);
						assert.ok(params.requestedSchema.properties.issues);
						assert.ok(params.requestedSchema.properties.subagents);
						return {
							action: "accept",
							content: { prs: true, issues: false, subagents: true },
						};
					},
				},
				log: async (msg) => logs.push(msg),
			};
			const pickerRes = await runInteractiveStatuslinePicker(mockSession, { home: pluginHome });
			assert.equal(pickerRes.cancelled, false);
			assert.deepEqual(pickerRes.enabled, ["pr-statusline", "subagent-statusline"]);
			assert.ok(logs.some((m) => m.includes("pr-statusline, subagent-statusline")));

			// Test direct CLI argument mode (/statusline-setup none)
			const disableRes = await runInteractiveStatuslinePicker(mockSession, { home: pluginHome, args: "none" });
			assert.deepEqual(disableRes.enabled, []);

			// Test Nerd Font detection vs Powerline-only / WSL fallback
			assert.equal(isNerdFontName("CaskaydiaCove Nerd Font Mono"), true);
			assert.equal(isNerdFontName("JetBrainsMono NF"), true);
			assert.equal(isNerdFontName("Cascadia Code PL"), false);
			assert.equal(isNerdFontName("Cascadia Mono"), false);
			assert.equal(isNerdFontName(""), false);
			assert.equal(
				detectNerdFontFromWindowsTerminalSettings(
					{
						profiles: {
							defaults: {},
							list: [{ name: "Ubuntu", source: "Windows.Terminal.Wsl", font: { face: "Cascadia Code PL" } }],
						},
					},
					{ wslDistroName: "Ubuntu", isWsl: true },
				),
				false,
			);
			assert.equal(
				detectNerdFontFromWindowsTerminalSettings(
					{
						profiles: {
							defaults: { font: { face: "CaskaydiaCove Nerd Font Mono" } },
							list: [{ name: "Ubuntu", source: "Windows.Terminal.Wsl" }],
						},
					},
					{ wslDistroName: "Ubuntu", isWsl: true },
				),
				true,
			);
			const unicodeConverted = toUnicodeIcons("\uE726 microsoft/cae#3494 \uF058 23/23 \uF071 \uF440 \uF164 1/2 \uF075 3/5");
			assert.equal(unicodeConverted, "\uE0A0 microsoft/cae#3494 \u2713 23/23 \u26A0 \u2691 \u2605 1/2 \u2709 3/5");
			assert.doesNotMatch(unicodeConverted, /[\uE700-\uF8FF]/);
		} finally {
			rmSync(pluginHome, { recursive: true, force: true });
		}
	} finally {
		rmSync(setupHome, { recursive: true, force: true });
	}

	console.log("ok - subagent state counts (starting, in PR, merged), OSC 8 console link, purple merged dismissal, setup configurator, and horizontal compositor");
} finally {
	rmSync(home, { recursive: true, force: true });
}
