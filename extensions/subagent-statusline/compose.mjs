import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const configHome = () => process.env.COPILOT_HOME || join(homedir(), ".copilot");

const PREFERRED_ORDER = ["pr-statusline", "issue-statusline", "subagent-statusline"];

function atomicWriteText(filePath, content) {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	writeFileSync(tmpPath, content, "utf8");
	try {
		renameSync(tmpPath, filePath);
	} catch (error) {
		if (error?.code === "EPERM" || error?.code === "EACCES") {
			writeFileSync(filePath, content, "utf8");
			return;
		}
		throw error;
	} finally {
		rmSync(tmpPath, { force: true });
	}
}

export function getEnabledStatuslines(home = configHome()) {
	const enabled = readEnabledConfig(home);
	if (!enabled) return [...PREFERRED_ORDER];
	return PREFERRED_ORDER.filter((id) => enabled.has(id));
}

export function setEnabledStatuslines(enabledIds, {
	home = configHome(),
	nodePath = process.execPath,
} = {}) {
	mkdirSync(home, { recursive: true });
	const wanted = new Set((enabledIds ?? []).map(String));
	const validEnabled = PREFERRED_ORDER.filter((id) => wanted.has(id));
	const configPath = join(home, "statusline-config.json");
	const composerDst = join(home, "statusline-compose.mjs");
	const settingsPath = join(home, "settings.json");

	atomicWriteText(
		configPath,
		`${JSON.stringify({ version: 1, enabled: validEnabled, updatedAt: new Date().toISOString() }, null, 2)}\n`,
	);

	let settings = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		} catch {
			settings = {};
		}
	}
	if (validEnabled.length > 0) {
		settings.statusLine = {
			type: "command",
			command: `"${nodePath}" "${composerDst}"`,
			padding: 0,
			refreshInterval: 2,
		};
		if (!settings.footer || typeof settings.footer !== "object" || Array.isArray(settings.footer)) {
			settings.footer = {};
		}
		settings.footer.showCustom = true;
	} else {
		delete settings.statusLine;
		if (settings.footer && typeof settings.footer !== "object" && !Array.isArray(settings.footer)) {
			settings.footer.showCustom = false;
		}
	}
	atomicWriteText(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	return { enabled: validEnabled, configPath, settingsPath, composerPath: composerDst };
}

export function parseQuickSetupTokens(rawArgs = "") {
	const tokens = String(rawArgs ?? "")
		.trim()
		.toLowerCase()
		.split(/[\s,]+/)
		.filter(Boolean);
	if (!tokens.length) return null;
	if (tokens.includes("none") || tokens.includes("off") || tokens.includes("disable")) {
		return [];
	}
	if (tokens.includes("all") || tokens.includes("--all")) {
		return [...PREFERRED_ORDER];
	}
	const map = {
		pr: "pr-statusline",
		prs: "pr-statusline",
		"--prs": "pr-statusline",
		"pr-statusline": "pr-statusline",
		issue: "issue-statusline",
		issues: "issue-statusline",
		"--issues": "issue-statusline",
		"issue-statusline": "issue-statusline",
		subagent: "subagent-statusline",
		subagents: "subagent-statusline",
		"--subagents": "subagent-statusline",
		"subagent-statusline": "subagent-statusline",
	};
	const picked = new Set();
	for (const tok of tokens) {
		if (map[tok]) picked.add(map[tok]);
	}
	return picked.size > 0 ? PREFERRED_ORDER.filter((id) => picked.has(id)) : null;
}

export async function runInteractiveStatuslinePicker(session, {
	home = configHome(),
	args = "",
	nodePath = process.execPath,
} = {}) {
	const direct = parseQuickSetupTokens(args);
	if (direct !== null) {
		const res = setEnabledStatuslines(direct, { home, nodePath });
		const msg = res.enabled.length
			? `Configured Copilot CLI statusline: ${res.enabled.join(", ")}`
			: "Disabled Copilot CLI statuslines.";
		await session?.log?.(msg);
		return { cancelled: false, enabled: res.enabled, message: msg };
	}

	if (session?.capabilities?.ui?.elicitation && typeof session?.ui?.elicitation === "function") {
		const current = new Set(getEnabledStatuslines(home));
		const response = await session.ui.elicitation({
			message: "Choose which Copilot CLI statuslines to display in your terminal footer:",
			requestedSchema: {
				type: "object",
				properties: {
					prs: {
						type: "boolean",
						title: "Pull Requests (pr-statusline)",
						description: "Track session PRs with clickable links, CI checks, approvals, review threads, and purple Merged pills",
						default: current.has("pr-statusline"),
					},
					issues: {
						type: "boolean",
						title: "GitHub Issues (issue-statusline)",
						description: "Render a separate clickable pill per active session issue with labels, linked PR icon, assignee, and comments",
						default: current.has("issue-statusline"),
					},
					subagents: {
						type: "boolean",
						title: "Subagents (subagent-statusline)",
						description: "Show session subagent phase counters (starting, in PR, merged, failed)",
						default: current.has("subagent-statusline"),
					},
				},
			},
		});
		if (response?.action !== "accept" || !response.content) {
			return { cancelled: true, enabled: [...current], message: "Statusline setup cancelled." };
		}
		const selected = [];
		if (response.content.prs !== false) selected.push("pr-statusline");
		if (response.content.issues !== false) selected.push("issue-statusline");
		if (response.content.subagents !== false) selected.push("subagent-statusline");
		const res = setEnabledStatuslines(selected, { home, nodePath });
		const msg = res.enabled.length
			? `Configured Copilot CLI statusline: ${res.enabled.join(", ")}`
			: "Disabled Copilot CLI statuslines.";
		await session?.log?.(msg);
		return { cancelled: false, enabled: res.enabled, message: msg };
	}

	const current = getEnabledStatuslines(home);
	const msg = `Current statuslines: ${current.join(", ") || "none"}. Run /statusline-setup [all | none | prs issues subagents] to change.`;
	await session?.log?.(msg);
	return { cancelled: false, enabled: current, message: msg };
}

export function ensurePluginStatuslineRegistered(extensionId, extensionDir, {
	home = configHome(),
	nodePath = process.execPath,
} = {}) {
	try {
		mkdirSync(home, { recursive: true });
		const extRoot = join(home, "extensions");
		const dstDir = join(extRoot, extensionId);
		mkdirSync(dstDir, { recursive: true });

		for (const entry of readdirSync(extensionDir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			if (entry.name.endsWith(".mjs") || entry.name === "copilot-extension.json") {
				copyFileSync(join(extensionDir, entry.name), join(dstDir, entry.name));
			}
		}

		const composerSrc = join(extensionDir, "compose.mjs");
		const composerDst = join(home, "statusline-compose.mjs");
		if (existsSync(composerSrc)) {
			copyFileSync(composerSrc, composerDst);
		}

		const configPath = join(home, "statusline-config.json");
		const firstRun = !existsSync(configPath);
		if (firstRun) {
			setEnabledStatuslines(PREFERRED_ORDER, { home, nodePath });
		}
		return { firstRun };
	} catch {
		// Never fail extension startup if filesystem registration is read-only.
		return { firstRun: false };
	}
}

function readEnabledConfig(home) {
	try {
		const raw = JSON.parse(readFileSync(join(home, "statusline-config.json"), "utf8"));
		if (Array.isArray(raw?.enabled)) return new Set(raw.enabled.map(String));
	} catch {
		// No config file means all installed statusline extensions are enabled.
	}
	return null;
}

export function discoverRenderers(home = configHome()) {
	const extRoot = join(home, "extensions");
	if (!existsSync(extRoot)) return [];
	const enabled = readEnabledConfig(home);
	let dirs = [];
	try {
		dirs = readdirSync(extRoot, { withFileTypes: true })
			.filter((d) => d.isDirectory() && (!enabled || enabled.has(d.name)))
			.map((d) => d.name);
	} catch {
		return [];
	}
	dirs.sort((a, b) => {
		const ai = PREFERRED_ORDER.indexOf(a);
		const bi = PREFERRED_ORDER.indexOf(b);
		if (ai !== -1 && bi !== -1) return ai - bi;
		if (ai !== -1) return -1;
		if (bi !== -1) return 1;
		return a.localeCompare(b);
	});
	const renderers = [];
	for (const name of dirs) {
		const candidate = join(extRoot, name, "render.mjs");
		if (existsSync(candidate)) renderers.push({ name, path: candidate });
	}
	return renderers;
}

export function joinOutputsHorizontally(outputs, { color = true } = {}) {
	const active = outputs
		.map((out) => String(out ?? "").replace(/\r\n/g, "\n").trimEnd())
		.filter((out) => out.trim().length > 0);
	if (!active.length) return "";
	if (!color) {
		return active.map((out) => out.replace(/\n+/g, " ")).join(" · ");
	}
	const splitBlocks = active.map((out) => out.split("\n"));
	const maxRows = Math.max(...splitBlocks.map((b) => b.length));
	if (maxRows === 1) return splitBlocks.map((b) => b[0]).join(" ");
	const rows = [];
	for (let r = 0; r < maxRows; r++) {
		const parts = splitBlocks.map((lines) => {
			if (lines.length === maxRows) return lines[r] ?? "";
			if (lines.length === 1) return r === Math.floor(maxRows / 2) ? lines[0] : "";
			return lines[r] ?? "";
		}).filter(Boolean);
		rows.push(parts.join(" "));
	}
	return rows.join("\n");
}

export async function composeStatusLine(payload, {
	home = configHome(),
	links = true,
	color = links,
	now = Date.now(),
	selfPath = null,
	selfRender = null,
} = {}) {
	const renderers = discoverRenderers(home);
	if (!renderers.length) return "";
	const outputs = await Promise.all(
		renderers.map(async ({ path }) => {
			try {
				if (selfPath && typeof selfRender === "function" && resolve(path) === resolve(selfPath)) {
					return await selfRender(payload, { home, now, links, color });
				}
				const mod = await import(pathToFileURL(path).href);
				if (typeof mod.render === "function") {
					return await mod.render(payload, { home, now, links, color });
				}
			} catch {
				// Ignore broken renderer module so sibling statusline extensions still render.
			}
			return "";
		}),
	);
	return joinOutputsHorizontally(outputs, { color });
}

async function main() {
	try {
		let input = "";
		process.stdin.setEncoding("utf8");
		for await (const chunk of process.stdin) input += chunk;
		const payload = JSON.parse(input);
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			throw new Error("Expected session JSON on stdin.");
		}
		const plain = process.argv.includes("--plain");
		const color = !plain && !process.argv.includes("--no-color") && !process.env.NO_COLOR;
		const output = await composeStatusLine(payload, { links: !plain, color });
		if (output) console.log(output);
	} catch (error) {
		console.error(`[statusline-compose] ${error.message}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
