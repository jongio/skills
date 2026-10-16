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
		if (!existsSync(configPath)) {
			atomicWriteText(
				configPath,
				`${JSON.stringify({ version: 1, enabled: PREFERRED_ORDER, updatedAt: new Date().toISOString() }, null, 2)}\n`,
			);
			const settingsPath = join(home, "settings.json");
			let settings = {};
			if (existsSync(settingsPath)) {
				settings = JSON.parse(readFileSync(settingsPath, "utf8"));
			}
			if (!settings.statusLine?.command) {
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
				atomicWriteText(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
			}
		}
	} catch {
		// Never fail extension startup if filesystem registration is read-only.
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
