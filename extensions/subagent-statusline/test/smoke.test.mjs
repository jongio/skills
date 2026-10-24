import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SubagentTracker } from "../tracker.mjs";
import { render } from "../render.mjs";
import {
	composeStatusLine,
	detectInstalledWindowsNerdFontFace,
	detectNerdFontFromWindowsTerminalSettings,
	detectNerdFontSupport,
	discoverRenderers,
	ensurePluginStatuslineRegistered,
	ensureWindowsTerminalNerdFont,
	isNerdFontName,
	joinOutputsHorizontally,
	runInteractiveStatuslinePicker,
	stripJsonComments,
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
	// Exploratory subagents are tracked in the `exploring` counter while running, and move to `done` on completion
	tracker.observe(event("subagent.started", { agentId: "exp-1", toolCallId: "tc-exp-1", agentType: "explore", agentName: "explore", executionMode: "background" }));
	tracker.observe(event("tool.execution_complete", { toolCallId: "tc-exp-1", success: true, result: { content: "Background agent launched" } }));
	assert.deepEqual(tracker.counts(), { total: 1, starting: 0, exploring: 1, inPr: 0, merged: 0, done: 0, failed: 0 });
	tracker.observe(event("subagent.completed", { agentId: "exp-1", toolCallId: "tc-exp-1", agentType: "explore", agentName: "explore" }));
	assert.deepEqual(tracker.counts(), { total: 1, starting: 0, exploring: 0, inPr: 0, merged: 0, done: 1, failed: 0 });

	// 3 developer subagents start
	tracker.observe(event("subagent.started", { agentId: "agent-1", toolCallId: "tc-1", agentName: "devx-developer" }, "agent-1", new Date(1000).toISOString()));
	tracker.observe(event("subagent.started", { agentId: "agent-2", toolCallId: "tc-2", agentName: "devx-developer" }, "agent-2", new Date(1100).toISOString()));
	tracker.observe(event("subagent.started", { agentId: "agent-3", toolCallId: "tc-3", agentName: "devx-developer" }, "agent-3", new Date(1200).toISOString()));
	assert.deepEqual(tracker.counts(), { total: 4, starting: 3, exploring: 0, inPr: 0, merged: 0, done: 1, failed: 0 });

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
	assert.equal(tracker.counts().inPr, 0, "creation output cannot associate a PR");
	tracker.linkPr("agent-1", "https://github.com/Azure/azure-dev/pull/101");
	assert.deepEqual(tracker.counts(), { total: 4, starting: 2, exploring: 0, inPr: 1, merged: 0, done: 1, failed: 0 });

	// Explicitly tracked agent-2 PR moves to merged only after remote confirmation.
	tracker.linkPr("agent-2", "https://github.com/Azure/azure-dev/pull/102");
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
	assert.equal(tracker.counts().merged, 0, "merge command success is not remote merge confirmation");
	tracker.syncWithPrCache({ "https://github.com/Azure/azure-dev/pull/102": { info: { state: "MERGED" } } }, 2600);
	assert.deepEqual(tracker.counts(), { total: 4, starting: 1, exploring: 0, inPr: 1, merged: 1, done: 1, failed: 0 });

	// Live transcript rendering test (including parallel general-purpose + explore subagents)
	const transcriptDir = join(home, "session-state", "live-subagents");
	mkdirSync(transcriptDir, { recursive: true });
	const transcriptFile = join(transcriptDir, "events.jsonl");
	writeFileSync(
		transcriptFile,
		[
			JSON.stringify(event("subagent.started", { agentId: "a1", toolCallId: "t1", agentName: "devx-developer" }, "a1", new Date(1000).toISOString())),
			JSON.stringify(event("subagent.started", { agentId: "a2", toolCallId: "t2", agentName: "devx-developer" }, "a2", new Date(1100).toISOString())),
			JSON.stringify(event("subagent.started", { agentId: "e1", toolCallId: "te1", agentType: "explore", agentName: "explore" }, "e1", new Date(1150).toISOString())),
			JSON.stringify(event("tool.execution_start", { toolCallId: "c2", toolName: "session_prs", arguments: { action: "add", reference: "Azure/azure-dev#4812" } }, "a2", new Date(1200).toISOString())),
			JSON.stringify(event("tool.execution_complete", { toolCallId: "c2", success: true, result: { content: "Tracked" } }, "a2", new Date(1250).toISOString())),
		].join("\n") + "\n",
	);
	const plainOut = render({ session_id: "live-subagents", transcript_path: transcriptDir }, { home, links: false, color: false });
	assert.equal(plainOut, "\uF4B8 \uF252 1 starting \uF422 1 exploring \uE726 1 in PR");
	const unicodeOut = render({ session_id: "live-subagents", transcript_path: transcriptDir }, { home, links: false, color: false, nerdFont: false });
	assert.equal(unicodeOut, "\u25C8 \u25F7 1 starting \u25CE 1 exploring \uE0A0 1 in PR");

	// Colored output is a single compact line (no top/bottom cap lines wasting vertical rows)
	const activeColorOut = render({ session_id: "live-subagents", transcript_path: transcriptDir }, { home, links: false, color: true });
	assert.equal(activeColorOut.split("\n").length, 1, "colored pill must be a single line without extra vertical cap rows");

	// When subagents finish & merge, pill turns purple and dismisses on next user input
	appendFileSync(
		transcriptFile,
		[
			JSON.stringify(event("subagent.completed", { agentId: "e1", toolCallId: "te1", agentType: "explore", agentName: "explore" }, "e1", new Date(1900).toISOString())),
			JSON.stringify(event("tool.execution_start", { toolCallId: "claim-a1", toolName: "session_prs", arguments: { action: "add", reference: "Azure/azure-dev#4811" } }, "a1", new Date(1950).toISOString())),
			JSON.stringify(event("tool.execution_complete", { toolCallId: "claim-a1", success: true, result: { content: "Tracked" } }, "a1", new Date(1960).toISOString())),
			JSON.stringify(event("tool.execution_start", { toolCallId: "m1", toolName: "powershell", arguments: { command: "gh pr merge https://github.com/Azure/azure-dev/pull/4811 --squash" } }, "a1", new Date(2000).toISOString())),
			JSON.stringify(event("tool.execution_complete", { toolCallId: "m1", success: true, result: { content: "Merged" } }, "a1", new Date(2100).toISOString())),
			JSON.stringify(event("tool.execution_start", { toolCallId: "m2", toolName: "powershell", arguments: { command: "gh pr merge https://github.com/Azure/azure-dev/pull/4812 --squash" } }, "a2", new Date(2200).toISOString())),
			JSON.stringify(event("tool.execution_complete", { toolCallId: "m2", success: true, result: { content: "Merged" } }, "a2", new Date(2300).toISOString())),
			JSON.stringify(event("subagent.completed", { agentId: "a1", toolCallId: "t1", agentName: "devx-developer" }, "a1", new Date(2400).toISOString())),
			JSON.stringify(event("subagent.completed", { agentId: "a2", toolCallId: "t2", agentName: "devx-developer" }, "a2", new Date(2500).toISOString())),
		].join("\n") + "\n",
	);
	mkdirSync(join(home, "pr-statusline"), { recursive: true });
	writeFileSync(join(home, "pr-statusline", "pr-cache.json"), JSON.stringify({
		"https://github.com/Azure/azure-dev/pull/4811": { info: { state: "MERGED" }, checkedAt: 2600 },
		"https://github.com/Azure/azure-dev/pull/4812": { info: { state: "MERGED" }, checkedAt: 2600 },
	}));
	const mergedColorOut = render({ session_id: "live-subagents", transcript_path: transcriptDir }, { home, now: 2600, links: false, color: true });
	assert.equal(mergedColorOut, "\x1b[1;38;2;237;224;255;48;2;88;44;142m \uF4B8 \uE727 2 merged \x1b[0m", "all-merged subagents use single-line purple pill");

	appendFileSync(transcriptFile, `${JSON.stringify(event("user.message", { content: "Next task" }, undefined, new Date(3000).toISOString()))}\n`);
	assert.equal(render({ session_id: "live-subagents", transcript_path: transcriptDir }, { home, links: false, color: false }), "");

	// Horizontal composition of multi-line pills
	const joined = joinOutputsHorizontally(["top1\nmid1\nbot1", "top2\nmid2\nbot2"], { color: true });
	assert.equal(joined, "top1 top2\nmid1 mid2\nbot1 bot2");
	assert.equal(await composeStatusLine({ session_id: "none" }, { home }), "");

	// Interactive/CLI setup configurator and statusline-config.json filtering test
	assert.deepEqual(parseStatuslineArgs(["--all"]), ["pr-statusline", "issue-statusline", "subagent-statusline", "worktree-statusline"]);
	assert.deepEqual(parseStatuslineArgs(["--prs", "--subagents"]), ["pr-statusline", "subagent-statusline"]);
	assert.deepEqual(parseStatuslineArgs(["--no-issues"]), ["pr-statusline", "subagent-statusline", "worktree-statusline"]);
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
			assert.deepEqual(discoverRenderers(pluginHome).map((r) => r.name), ["worktree-statusline", "pr-statusline", "issue-statusline", "subagent-statusline"]);

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
			assert.equal(toUnicodeIcons("\uF41B Azure/azure-dev#3315 P1 \uE726 \uF415 jongio \uF075 4"), "\u25CE Azure/azure-dev#3315 P1 \uE0A0 @jongio \u2709 4");

			// Test JSONC inline comment stripping with URLs and string-literal commas preserved
			const parsedJsonc = JSON.parse(stripJsonComments(`{
				"$help": "https://aka.ms/terminal-documentation", // inline URL comment
				"commandline": "pwsh -Command \\"Write-Output ',]'\\", }",
				"profiles": {
					"defaults": {
						"font": { "face": "CaskaydiaCove Nerd Font Mono" }, /* block */
					},
				}
			}`));
			assert.equal(parsedJsonc.$help, "https://aka.ms/terminal-documentation");
			assert.equal(parsedJsonc.commandline, "pwsh -Command \"Write-Output ',]'\", }");
			assert.equal(parsedJsonc.profiles.defaults.font.face, "CaskaydiaCove Nerd Font Mono");

			// Test defaultProfile fallback when WT_PROFILE_ID is unset (and not when WT_PROFILE_ID is set to an unknown GUID)
			assert.equal(
				detectNerdFontFromWindowsTerminalSettings(
					{
						defaultProfile: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
						profiles: {
							defaults: {},
							list: [{ guid: "{574e775e-4f2a-5b96-ac1e-a2962a402336}", name: "PowerShell", font: { face: "CaskaydiaCove Nerd Font Mono" } }],
						},
					},
					{ wtProfileId: "", isWsl: false },
				),
				true,
			);
			assert.equal(
				detectNerdFontFromWindowsTerminalSettings(
					{
						defaultProfile: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
						profiles: {
							defaults: {},
							list: [{ guid: "{574e775e-4f2a-5b96-ac1e-a2962a402336}", name: "PowerShell", font: { face: "CaskaydiaCove Nerd Font Mono" } }],
						},
					},
					{ wtProfileId: "{99999999-9999-9999-9999-999999999999}", isWsl: false },
				),
				false,
			);

			// Test auto-healing Windows Terminal settings.json when defaults.font.face was reset but Nerd Font is installed
			const fakeFontsDir = join(pluginHome, "Fonts");
			const emptyFontsDir = join(pluginHome, "EmptyFonts");
			mkdirSync(fakeFontsDir, { recursive: true });
			mkdirSync(emptyFontsDir, { recursive: true });
			writeFileSync(join(fakeFontsDir, "CaskaydiaCoveNerdFontMono-Regular.ttf"), "font");
			assert.equal(detectInstalledWindowsNerdFontFace({ fontDirs: [fakeFontsDir] }), "CaskaydiaCove Nerd Font Mono");
			assert.equal(detectInstalledWindowsNerdFontFace({ fontDirs: [emptyFontsDir] }), null);
			const fakeWtSettings = join(pluginHome, "wt-settings.json");
			writeFileSync(fakeWtSettings, JSON.stringify({
				defaultProfile: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
				profiles: {
					defaults: {},
					list: [{ guid: "{574e775e-4f2a-5b96-ac1e-a2962a402336}", name: "PowerShell" }],
				},
			}, null, 4));
			assert.equal(
				detectNerdFontSupport({
					wtSettingsPaths: [fakeWtSettings],
					fontDirs: [emptyFontsDir],
					wtProfileId: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
					termProgram: "",
				}),
				false,
			);
			assert.equal(
				detectNerdFontSupport({
					wtSettingsPaths: [fakeWtSettings],
					fontDirs: [fakeFontsDir],
					wtProfileId: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
					termProgram: "",
				}),
				false,
			);
			assert.equal(
				ensureWindowsTerminalNerdFont({
					wtSettingsPaths: [fakeWtSettings],
					fontDirs: [fakeFontsDir],
					wtProfileId: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
					termProgram: "",
					isWsl: false,
				}),
				"CaskaydiaCove Nerd Font Mono",
			);
			assert.equal(
				JSON.parse(readFileSync(fakeWtSettings, "utf8")).profiles.defaults.font.face,
				"CaskaydiaCove Nerd Font Mono",
			);
			assert.equal(
				detectNerdFontSupport({
					wtSettingsPaths: [fakeWtSettings],
					fontDirs: [fakeFontsDir],
					wtProfileId: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
					termProgram: "",
				}),
				true,
			);

			// Explicit non-Nerd Font choice (including legacy fontFace) and JSONC comments are never overwritten by ensureWindowsTerminalNerdFont
			writeFileSync(fakeWtSettings, JSON.stringify({
				defaultProfile: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
				profiles: {
					defaults: { font: { face: "Cascadia Code PL" } },
					list: [{ guid: "{574e775e-4f2a-5b96-ac1e-a2962a402336}", name: "PowerShell" }],
				},
			}, null, 4));
			assert.equal(
				ensureWindowsTerminalNerdFont({
					wtSettingsPaths: [fakeWtSettings],
					fontDirs: [fakeFontsDir],
					wtProfileId: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
					termProgram: "",
					isWsl: false,
				}),
				null,
			);
			assert.equal(
				JSON.parse(readFileSync(fakeWtSettings, "utf8")).profiles.defaults.font.face,
				"Cascadia Code PL",
			);
			writeFileSync(fakeWtSettings, JSON.stringify({
				defaultProfile: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
				profiles: {
					defaults: {},
					list: [{ guid: "{574e775e-4f2a-5b96-ac1e-a2962a402336}", name: "PowerShell", fontFace: "Consolas" }],
				},
			}, null, 4));
			assert.equal(
				ensureWindowsTerminalNerdFont({
					wtSettingsPaths: [fakeWtSettings],
					fontDirs: [fakeFontsDir],
					wtProfileId: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
					termProgram: "",
					isWsl: false,
				}),
				null,
			);
			// Legacy array-valued "profiles": [...] is never overwritten
			const legacyArrayProfiles = JSON.stringify({
				defaultProfile: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
				profiles: [{ guid: "{574e775e-4f2a-5b96-ac1e-a2962a402336}", name: "PowerShell" }],
			}, null, 4);
			writeFileSync(fakeWtSettings, legacyArrayProfiles);
			assert.equal(
				ensureWindowsTerminalNerdFont({
					wtSettingsPaths: [fakeWtSettings],
					fontDirs: [fakeFontsDir],
					wtProfileId: "",
					termProgram: "",
					isWsl: false,
				}),
				null,
			);
			assert.equal(readFileSync(fakeWtSettings, "utf8"), legacyArrayProfiles);
			const commentedWtSettings = `{\n  // user comment preserved\n  "profiles": {\n    "defaults": {\n      /* nested comment */\n      "startingDirectory": "C:\\\\code",\n    },\n    "list": [{ "guid": "{574e775e-4f2a-5b96-ac1e-a2962a402336}", "name": "PowerShell", }],\n  },\n}\n`;
			writeFileSync(fakeWtSettings, commentedWtSettings);
			assert.equal(
				ensureWindowsTerminalNerdFont({
					wtSettingsPaths: [fakeWtSettings],
					fontDirs: [fakeFontsDir],
					wtProfileId: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
					termProgram: "",
					isWsl: false,
				}),
				"CaskaydiaCove Nerd Font Mono",
			);
			const healedCommentedRaw = readFileSync(fakeWtSettings, "utf8");
			assert.ok(healedCommentedRaw.includes("// user comment preserved"));
			assert.ok(healedCommentedRaw.includes("/* nested comment */"));
			assert.equal(
				JSON.parse(stripJsonComments(healedCommentedRaw)).profiles.defaults.font.face,
				"CaskaydiaCove Nerd Font Mono",
			);

			// Existing unset font.face ("" or null) is replaced in place without duplicating keys on repeated healing
			for (const unsetValue of ["\"\"", "null"]) {
				const unsetFaceSettings = `{\n  // keep comment\n  "profiles": {\n    "defaults": {\n      "font": { "face": ${unsetValue}, "size": 11 }\n    },\n    "list": [{ "guid": "{574e775e-4f2a-5b96-ac1e-a2962a402336}", "name": "PowerShell" }]\n  }\n}\n`;
				writeFileSync(fakeWtSettings, unsetFaceSettings);
				for (let attempt = 0; attempt < 2; attempt++) {
					assert.equal(
						ensureWindowsTerminalNerdFont({
							wtSettingsPaths: [fakeWtSettings],
							fontDirs: [fakeFontsDir],
							wtProfileId: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
							termProgram: "",
							isWsl: false,
						}),
						"CaskaydiaCove Nerd Font Mono",
					);
				}
				const healedUnsetRaw = readFileSync(fakeWtSettings, "utf8");
				assert.equal((healedUnsetRaw.match(/"face"\s*:/g) ?? []).length, 1);
				assert.equal(
					JSON.parse(stripJsonComments(healedUnsetRaw)).profiles.defaults.font.face,
					"CaskaydiaCove Nerd Font Mono",
				);
			}

			// Running inside VS Code never modifies Windows Terminal settings
			writeFileSync(fakeWtSettings, JSON.stringify({
				profiles: {
					defaults: {},
					list: [{ guid: "{574e775e-4f2a-5b96-ac1e-a2962a402336}", name: "PowerShell" }],
				},
			}, null, 4));
			assert.equal(
				ensureWindowsTerminalNerdFont({
					wtSettingsPaths: [fakeWtSettings],
					fontDirs: [fakeFontsDir],
					wtProfileId: "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
					termProgram: "vscode",
					isWsl: false,
				}),
				null,
			);
			assert.equal(JSON.parse(readFileSync(fakeWtSettings, "utf8")).profiles.defaults.font, undefined);

			// When multiple Windows Terminal candidates exist (e.g. Stable + Preview), only heal the unambiguous profile match
			const fakeWtStable = join(pluginHome, "wt-stable.json");
			const fakeWtPreview = join(pluginHome, "wt-preview.json");
			writeFileSync(fakeWtStable, JSON.stringify({
				profiles: {
					defaults: {},
					list: [{ guid: "{11111111-1111-1111-1111-111111111111}", name: "StablePS" }],
				},
			}, null, 4));
			writeFileSync(fakeWtPreview, JSON.stringify({
				profiles: {
					defaults: {},
					list: [{ guid: "{22222222-2222-2222-2222-222222222222}", name: "PreviewPS" }],
				},
			}, null, 4));
			assert.equal(
				ensureWindowsTerminalNerdFont({
					wtSettingsPaths: [fakeWtStable, fakeWtPreview],
					fontDirs: [fakeFontsDir],
					wtProfileId: "{22222222-2222-2222-2222-222222222222}",
					termProgram: "",
					isWsl: false,
				}),
				"CaskaydiaCove Nerd Font Mono",
			);
			assert.equal(JSON.parse(readFileSync(fakeWtStable, "utf8")).profiles.defaults.font, undefined);
			assert.equal(
				JSON.parse(readFileSync(fakeWtPreview, "utf8")).profiles.defaults.font.face,
				"CaskaydiaCove Nerd Font Mono",
			);

			// Ambiguous multiple candidates (both match WT_PROFILE_ID) skip auto-heal without writing
			writeFileSync(fakeWtPreview, JSON.stringify({
				profiles: {
					defaults: {},
					list: [{ guid: "{11111111-1111-1111-1111-111111111111}", name: "PreviewPS" }],
				},
			}, null, 4));
			assert.equal(
				ensureWindowsTerminalNerdFont({
					wtSettingsPaths: [fakeWtStable, fakeWtPreview],
					fontDirs: [fakeFontsDir],
					wtProfileId: "{11111111-1111-1111-1111-111111111111}",
					termProgram: "",
					isWsl: false,
				}),
				null,
			);
			assert.equal(JSON.parse(readFileSync(fakeWtStable, "utf8")).profiles.defaults.font, undefined);
			assert.equal(JSON.parse(readFileSync(fakeWtPreview, "utf8")).profiles.defaults.font, undefined);

			// VS Code with unset font keys preserves Unicode fallback instead of falling through to Windows Terminal
			const fakeVsCodeSettings = join(pluginHome, "vscode-settings.json");
			writeFileSync(fakeVsCodeSettings, JSON.stringify({ "workbench.colorTheme": "Default Dark+" }));
			assert.equal(
				detectNerdFontSupport({
					termProgram: "vscode",
					vscodeSettingsPaths: [fakeVsCodeSettings],
					wtSettingsPaths: [fakeWtSettings],
					fontDirs: [fakeFontsDir],
				}),
				false,
			);

			// COPILOT_STATUSLINE_ICONS=unicode skips ensureWindowsTerminalNerdFont without modifying settings
			const prevIconsEnv = process.env.COPILOT_STATUSLINE_ICONS;
			process.env.COPILOT_STATUSLINE_ICONS = "unicode";
			try {
				assert.equal(
					ensureWindowsTerminalNerdFont({
						wtSettingsPaths: [fakeWtStable],
						fontDirs: [fakeFontsDir],
						wtProfileId: "{11111111-1111-1111-1111-111111111111}",
						isWsl: false,
					}),
					null,
				);
				assert.equal(JSON.parse(readFileSync(fakeWtStable, "utf8")).profiles.defaults.font, undefined);
			} finally {
				if (prevIconsEnv === undefined) delete process.env.COPILOT_STATUSLINE_ICONS;
				else process.env.COPILOT_STATUSLINE_ICONS = prevIconsEnv;
			}
		} finally {
			rmSync(pluginHome, { recursive: true, force: true });
		}
	} finally {
		rmSync(setupHome, { recursive: true, force: true });
	}

	console.log("ok - subagent counts, GitHub-confirmed merges, non-linked summary, merged dismissal, setup configurator, and horizontal compositor");
} finally {
	rmSync(home, { recursive: true, force: true });
}
