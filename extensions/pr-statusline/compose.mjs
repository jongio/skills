import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const configHome = () => process.env.COPILOT_HOME || join(homedir(), ".copilot");

const PREFERRED_ORDER = ["worktree-statusline", "pr-statusline", "issue-statusline", "subagent-statusline"];

const NERD_FONT_TO_UNICODE = new Map([
	["\uE726", "\uE0A0"],
	["\uE727", "\uE0A0"],
	["\uF419", "\uE0A0"],
	["\uF4DD", "\u25C7"],
	["\uF058", "\u2713"],
	["\uF252", "\u25F7"],
	["\uF057", "\u2717"],
	["\uF071", "\u26A0"],
	["\uF440", "\u2691"],
	["\uF164", "\u2605"],
	["\uF075", "\u2709"],
	["\uF41B", "\u25CE"],
	["\uF41D", "\u2713"],
	["\uF188", "\u2731"],
	["\uF415", ""],
	["\uF4B8", "\u25C8"],
	["\uF422", "\u25CE"],
	["\uF002", "\u25CE"],
]);

const NERD_FONT_REGEX = /[\uE726\uE727\uF419\uF4DD\uF058\uF252\uF057\uF071\uF440\uF164\uF075\uF41B\uF41D\uF188\uF415\uF4B8\uF422\uF002]/g;

export function toUnicodeIcons(text) {
	return String(text ?? "")
		.replace(/\uF415 ?/g, "@")
		.replace(NERD_FONT_REGEX, (ch) => NERD_FONT_TO_UNICODE.get(ch) ?? ch);
}

export function isNerdFontName(fontName) {
	const raw = String(fontName ?? "").trim();
	if (!raw) return false;
	if (/\bfor\s+powerline\b|\bcascadia\s+(?:code|mono)\s+pl\b/i.test(raw)) return false;
	return /\b(?:nerd\s*font|caskaydia|meslolg[sml]?\s*nf|fira\s*code\s*nf|jetbrains\s*mono\s*nf|hack\s*nf|0xproto\s*nf|[a-z0-9_-]+\s+nf(?:\s+mono|\s+propo)?)\b/i.test(raw);
}

export function stripJsonComments(raw) {
	const src = String(raw ?? "");
	let noComments = "";
	let inString = false;
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		const next = src[i + 1];
		if (inString) {
			noComments += ch;
			if (ch === "\\" && i + 1 < src.length) {
				noComments += next;
				i += 2;
				continue;
			}
			if (ch === "\"") inString = false;
			i++;
			continue;
		}
		if (ch === "\"") {
			inString = true;
			noComments += ch;
			i++;
			continue;
		}
		if (ch === "/" && next === "/") {
			i += 2;
			while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i + 1 < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		noComments += ch;
		i++;
	}
	let out = "";
	inString = false;
	i = 0;
	while (i < noComments.length) {
		const ch = noComments[i];
		if (inString) {
			out += ch;
			if (ch === "\\" && i + 1 < noComments.length) {
				out += noComments[i + 1];
				i += 2;
				continue;
			}
			if (ch === "\"") inString = false;
			i++;
			continue;
		}
		if (ch === "\"") {
			inString = true;
			out += ch;
			i++;
			continue;
		}
		if (ch === ",") {
			let j = i + 1;
			while (j < noComments.length && /\s/.test(noComments[j])) j++;
			if (noComments[j] === "}" || noComments[j] === "]") {
				i++;
				continue;
			}
		}
		out += ch;
		i++;
	}
	return out;
}

function isWslEnvironment(procVersionPath = "/proc/version") {
	if (process.platform !== "linux") return false;
	if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
	try {
		return /microsoft|wsl/i.test(readFileSync(procVersionPath, "utf8"));
	} catch {
		return false;
	}
}

function candidateWindowsTerminalSettingsPaths() {
	const paths = [];
	if (process.platform === "win32" && process.env.LOCALAPPDATA) {
		const local = process.env.LOCALAPPDATA;
		paths.push(
			join(local, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"),
			join(local, "Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"),
			join(local, "Microsoft", "Windows Terminal", "settings.json"),
		);
	} else if (process.platform === "linux" && existsSync("/mnt/c/Users")) {
		try {
			const skip = new Set(["Public", "Default", "Default User", "All Users"]);
			for (const entry of readdirSync("/mnt/c/Users", { withFileTypes: true })) {
				if (!entry.isDirectory() || skip.has(entry.name)) continue;
				const local = join("/mnt/c/Users", entry.name, "AppData", "Local");
				paths.push(
					join(local, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"),
					join(local, "Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"),
					join(local, "Microsoft", "Windows Terminal", "settings.json"),
				);
			}
		} catch {
			// Ignore unreadable /mnt/c/Users.
		}
	}
	return paths;
}

const INSTALLED_NERD_FONT_CANDIDATES = [
	["CaskaydiaCoveNerdFontMono-Regular.ttf", "CaskaydiaCove Nerd Font Mono"],
	["CaskaydiaCoveNerdFont-Regular.ttf", "CaskaydiaCove Nerd Font"],
	["JetBrainsMonoNerdFontMono-Regular.ttf", "JetBrainsMono Nerd Font Mono"],
	["JetBrainsMonoNerdFont-Regular.ttf", "JetBrainsMono Nerd Font"],
	["FiraCodeNerdFontMono-Regular.ttf", "FiraCode Nerd Font Mono"],
	["FiraCodeNerdFont-Regular.ttf", "FiraCode Nerd Font"],
	["MesloLGSNerdFontMono-Regular.ttf", "MesloLGS Nerd Font Mono"],
	["MesloLGS NF Regular.ttf", "MesloLGS NF"],
	["HackNerdFontMono-Regular.ttf", "Hack Nerd Font Mono"],
	["0xProtoNerdFontMono-Regular.ttf", "0xProto Nerd Font Mono"],
];

function candidateWindowsFontDirs() {
	const dirs = [];
	if (process.platform === "win32") {
		if (process.env.LOCALAPPDATA) {
			dirs.push(join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"));
		}
		if (process.env.WINDIR) {
			dirs.push(join(process.env.WINDIR, "Fonts"));
		}
	} else if (process.platform === "linux" && existsSync("/mnt/c")) {
		try {
			const skip = new Set(["Public", "Default", "Default User", "All Users"]);
			if (existsSync("/mnt/c/Users")) {
				for (const entry of readdirSync("/mnt/c/Users", { withFileTypes: true })) {
					if (!entry.isDirectory() || skip.has(entry.name)) continue;
					dirs.push(join("/mnt/c/Users", entry.name, "AppData", "Local", "Microsoft", "Windows", "Fonts"));
				}
			}
			dirs.push("/mnt/c/Windows/Fonts");
		} catch {
			// Ignore unreadable /mnt/c paths.
		}
	}
	return dirs;
}

export function detectInstalledWindowsNerdFontFace({ fontDirs = null } = {}) {
	const dirs = fontDirs ?? candidateWindowsFontDirs();
	for (const dir of dirs) {
		if (!dir || !existsSync(dir)) continue;
		for (const [fileName, face] of INSTALLED_NERD_FONT_CANDIDATES) {
			if (existsSync(join(dir, fileName))) return face;
		}
	}
	return null;
}

function resolveWindowsTerminalProfile(settingsObj, {
	wtProfileId = process.env.WT_PROFILE_ID,
	wslDistroName = process.env.WSL_DISTRO_NAME,
	isWsl = process.platform === "linux",
} = {}) {
	const list = Array.isArray(settingsObj?.profiles?.list) ? settingsObj.profiles.list : [];
	let matchedProfile = null;
	if (wtProfileId) {
		matchedProfile = list.find((p) => String(p?.guid ?? "").toLowerCase() === String(wtProfileId).toLowerCase()) ?? null;
	}
	if (!matchedProfile && isWsl) {
		if (wslDistroName) {
			const target = wslDistroName.toLowerCase();
			matchedProfile = list.find((p) =>
				String(p?.name ?? "").toLowerCase() === target ||
				(String(p?.source ?? "").toLowerCase().includes("wsl") && String(p?.name ?? "").toLowerCase().includes(target)),
			) ?? null;
		}
		if (!matchedProfile) {
			matchedProfile = list.find((p) => String(p?.source ?? "").toLowerCase().includes("wsl")) ?? null;
		}
	}
	if (!matchedProfile && !isWsl && settingsObj?.defaultProfile) {
		const defTarget = String(settingsObj.defaultProfile).toLowerCase();
		matchedProfile = list.find((p) =>
			String(p?.guid ?? "").toLowerCase() === defTarget ||
			String(p?.name ?? "").toLowerCase() === defTarget,
		) ?? null;
	}
	return matchedProfile;
}

export function ensureWindowsTerminalNerdFont({
	wtSettingsPaths = null,
	fontDirs = null,
	wtProfileId = process.env.WT_PROFILE_ID,
	wslDistroName = process.env.WSL_DISTRO_NAME,
	isWsl = isWslEnvironment(),
} = {}) {
	const installedFace = detectInstalledWindowsNerdFontFace({ fontDirs });
	if (!installedFace) return null;
	const paths = wtSettingsPaths ?? candidateWindowsTerminalSettingsPaths();
	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const parsed = JSON.parse(stripJsonComments(readFileSync(p, "utf8")));
			if (!parsed || typeof parsed !== "object") continue;
			const matchedProfile = resolveWindowsTerminalProfile(parsed, { wtProfileId, wslDistroName, isWsl });
			const defaultFace = String(parsed?.profiles?.defaults?.font?.face ?? "").trim();
			const profileFace = String(matchedProfile?.font?.face ?? "").trim();
			if (profileFace || defaultFace) {
				return isNerdFontName(profileFace || defaultFace) ? (profileFace || defaultFace) : null;
			}
			if (!parsed.profiles || typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles)) {
				parsed.profiles = {};
			}
			if (!parsed.profiles.defaults || typeof parsed.profiles.defaults !== "object" || Array.isArray(parsed.profiles.defaults)) {
				parsed.profiles.defaults = {};
			}
			if (!parsed.profiles.defaults.font || typeof parsed.profiles.defaults.font !== "object" || Array.isArray(parsed.profiles.defaults.font)) {
				parsed.profiles.defaults.font = {};
			}
			parsed.profiles.defaults.font.face = installedFace;
			atomicWriteText(p, `${JSON.stringify(parsed, null, 4)}\n`);
			return installedFace;
		} catch {
			// Best-effort heal; ignore read-only or malformed settings files.
		}
	}
	return null;
}

export function detectNerdFontFromWindowsTerminalSettings(settingsObj, {
	wtProfileId = process.env.WT_PROFILE_ID,
	wslDistroName = process.env.WSL_DISTRO_NAME,
	isWsl = process.platform === "linux",
} = {}) {
	if (!settingsObj || typeof settingsObj !== "object") return null;
	const defaultFace = settingsObj?.profiles?.defaults?.font?.face ?? "";
	const matchedProfile = resolveWindowsTerminalProfile(settingsObj, { wtProfileId, wslDistroName, isWsl });
	const effectiveFace = matchedProfile?.font?.face || defaultFace || "";
	return isNerdFontName(effectiveFace);
}

export function detectNerdFontSupport({
	wtSettingsPaths = null,
	wtProfileId = process.env.WT_PROFILE_ID,
	wslDistroName = process.env.WSL_DISTRO_NAME,
	termProgram = process.env.TERM_PROGRAM,
	vscodeSettingsPaths = null,
	fontDirs = null,
} = {}) {
	const envChoice = String(process.env.COPILOT_STATUSLINE_ICONS ?? "").trim().toLowerCase();
	if (["nerdfont", "nerd", "nf", "true", "1"].includes(envChoice)) return true;
	if (["unicode", "ascii", "plain", "false", "0"].includes(envChoice)) return false;

	if (String(termProgram ?? "").toLowerCase() === "vscode") {
		const vsPaths = vscodeSettingsPaths ?? candidateVsCodeSettingsPaths();
		for (const p of vsPaths) {
			if (!existsSync(p)) continue;
			try {
				const parsed = JSON.parse(stripJsonComments(readFileSync(p, "utf8")));
				const face = parsed?.["terminal.integrated.fontFamily"] || parsed?.["editor.fontFamily"] || "";
				if (String(face).trim()) return isNerdFontName(face);
			} catch {
				// Ignore malformed VS Code settings.json.
			}
		}
	}

	const wsl = isWslEnvironment();
	const paths = wtSettingsPaths ?? candidateWindowsTerminalSettingsPaths();
	for (const p of paths) {
		if (!existsSync(p)) continue;
		try {
			const parsed = JSON.parse(stripJsonComments(readFileSync(p, "utf8")));
			const matchedProfile = resolveWindowsTerminalProfile(parsed, { wtProfileId, wslDistroName, isWsl: wsl });
			const effectiveFace = String(matchedProfile?.font?.face || parsed?.profiles?.defaults?.font?.face || "").trim();
			if (!effectiveFace) {
				return Boolean(detectInstalledWindowsNerdFontFace({ fontDirs }));
			}
			const res = detectNerdFontFromWindowsTerminalSettings(parsed, {
				wtProfileId,
				wslDistroName,
				isWsl: wsl,
			});
			if (typeof res === "boolean") return res;
		} catch {
			// Ignore malformed settings file and try next candidate.
		}
	}
	if (wsl) return false;
	return true;
}

function candidateVsCodeSettingsPaths() {
	const paths = [];
	if (process.platform === "win32" && process.env.APPDATA) {
		paths.push(
			join(process.env.APPDATA, "Code", "User", "settings.json"),
			join(process.env.APPDATA, "Code - Insiders", "User", "settings.json"),
		);
	} else if (process.platform === "linux" && existsSync("/mnt/c/Users")) {
		try {
			const skip = new Set(["Public", "Default", "Default User", "All Users"]);
			for (const entry of readdirSync("/mnt/c/Users", { withFileTypes: true })) {
				if (!entry.isDirectory() || skip.has(entry.name)) continue;
				const roaming = join("/mnt/c/Users", entry.name, "AppData", "Roaming");
				paths.push(
					join(roaming, "Code", "User", "settings.json"),
					join(roaming, "Code - Insiders", "User", "settings.json"),
				);
			}
		} catch {
			// Ignore unreadable /mnt/c/Users.
		}
	} else if (process.platform === "darwin") {
		const support = join(homedir(), "Library", "Application Support");
		paths.push(
			join(support, "Code", "User", "settings.json"),
			join(support, "Code - Insiders", "User", "settings.json"),
		);
	} else {
		const cfg = join(homedir(), ".config");
		paths.push(
			join(cfg, "Code", "User", "settings.json"),
			join(cfg, "Code - Insiders", "User", "settings.json"),
		);
	}
	return paths;
}

export function shouldUseNerdFont({
	home = configHome(),
	nerdFont = undefined,
	autoDetect = false,
} = {}) {
	if (typeof nerdFont === "boolean") return nerdFont;
	const envChoice = String(process.env.COPILOT_STATUSLINE_ICONS ?? "").trim().toLowerCase();
	if (["nerdfont", "nerd", "nf", "true", "1"].includes(envChoice)) return true;
	if (["unicode", "ascii", "plain", "false", "0"].includes(envChoice)) return false;
	try {
		const raw = JSON.parse(readFileSync(join(home, "statusline-config.json"), "utf8"));
		if (raw?.iconMode === "unicode") return false;
		if (raw?.iconMode === "nerdfont") return true;
	} catch {
		if (!autoDetect) return true;
	}
	return autoDetect ? detectNerdFontSupport() : true;
}

export function resolveNodeCommand(nodePath = process.execPath) {
	const base = basename(String(nodePath || "")).toLowerCase();
	if (!base || base.startsWith("copilot")) {
		if (process.platform === "win32") {
			if (existsSync("C:\\Program Files\\nodejs\\node.exe")) {
				return "\"C:\\Program Files\\nodejs\\node.exe\"";
			}
			return "node";
		}
		const pathDirs = String(process.env.PATH ?? "").split(":").filter(Boolean);
		const home = homedir();
		const candidates = [
			...pathDirs.map((dir) => join(dir, "node")),
			join(home, ".local", "share", "mise", "shims", "node"),
			join(home, ".volta", "bin", "node"),
			"/opt/homebrew/bin/node",
			"/usr/local/bin/node",
			"/usr/bin/node",
		];
		for (const candidate of candidates) {
			if (candidate && !candidate.startsWith("/mnt/") && existsSync(candidate)) {
				return `"${candidate}"`;
			}
		}
		return "node";
	}
	return `"${nodePath}"`;
}

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
	iconMode = undefined,
} = {}) {
	mkdirSync(home, { recursive: true });
	const wanted = new Set((enabledIds ?? []).map(String));
	const validEnabled = PREFERRED_ORDER.filter((id) => wanted.has(id));
	const configPath = join(home, "statusline-config.json");
	const composerDst = join(home, "statusline-compose.mjs");
	const settingsPath = join(home, "settings.json");

	let existingIconMode = "auto";
	if (existsSync(configPath)) {
		try {
			const prev = JSON.parse(readFileSync(configPath, "utf8"));
			if (["auto", "nerdfont", "unicode"].includes(prev?.iconMode)) {
				existingIconMode = prev.iconMode;
			}
		} catch {
			existingIconMode = "auto";
		}
	}
	const resolvedIconMode = ["auto", "nerdfont", "unicode"].includes(iconMode) ? iconMode : existingIconMode;
	if (resolvedIconMode !== "unicode" && resolve(home) === resolve(configHome())) {
		ensureWindowsTerminalNerdFont();
	}

	atomicWriteText(
		configPath,
		`${JSON.stringify({ version: 1, enabled: validEnabled, iconMode: resolvedIconMode, updatedAt: new Date().toISOString() }, null, 2)}\n`,
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
		const nodeCmd = resolveNodeCommand(nodePath);
		settings.statusLine = {
			type: "command",
			command: `${nodeCmd} "${composerDst}"`,
			padding: 0,
			refreshInterval: 5,
		};
		if (!settings.footer || typeof settings.footer !== "object" || Array.isArray(settings.footer)) {
			settings.footer = {};
		}
		settings.footer.showCustom = true;
	} else {
		delete settings.statusLine;
		if (settings.footer && typeof settings.footer === "object" && !Array.isArray(settings.footer)) {
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
		branch: "worktree-statusline",
		branches: "worktree-statusline",
		worktree: "worktree-statusline",
		worktrees: "worktree-statusline",
		"--worktrees": "worktree-statusline",
		"worktree-statusline": "worktree-statusline",
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
	const rawTokens = String(args ?? "").trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
	let explicitIconMode;
	if (rawTokens.includes("unicode") || rawTokens.includes("--unicode")) explicitIconMode = "unicode";
	else if (rawTokens.includes("nerdfont") || rawTokens.includes("--nerdfont")) explicitIconMode = "nerdfont";
	else if (rawTokens.includes("auto-icons") || rawTokens.includes("--auto-icons")) explicitIconMode = "auto";

	const direct = parseQuickSetupTokens(args);
	if (direct !== null || explicitIconMode) {
		const targetEnabled = direct !== null ? direct : getEnabledStatuslines(home);
		const res = setEnabledStatuslines(targetEnabled, { home, nodePath, iconMode: explicitIconMode });
		const msg = res.enabled.length
			? `Configured Copilot CLI statusline: ${res.enabled.join(", ")} (icons: ${explicitIconMode || "auto"})`
			: "Disabled Copilot CLI statuslines.";
		await session?.log?.(msg);
		return { cancelled: false, enabled: res.enabled, message: msg };
	}

	if (session?.capabilities?.ui?.elicitation && typeof session?.ui?.elicitation === "function") {
		const current = new Set(getEnabledStatuslines(home));
		const currentUseNerd = shouldUseNerdFont({ home, autoDetect: true });
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
						description: "Show session subagent phase counters (starting, exploring, in PR, merged, failed)",
						default: current.has("subagent-statusline"),
					},
					worktrees: {
						type: "boolean",
						title: "Branch and Worktree (worktree-statusline)",
						description: "Follow the session's active Git branch and checkout directory",
						default: current.has("worktree-statusline"),
					},
					nerdFontIcons: {
						type: "boolean",
						title: "Use Nerd Font icons",
						description: "Uncheck if icons render as ? diamonds in your terminal or WSL profile (uses built-in Powerline + Unicode symbols instead)",
						default: currentUseNerd,
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
		if (response.content.worktrees === true) selected.push("worktree-statusline");
		const pickedIconMode = typeof response.content.nerdFontIcons === "boolean"
			? (response.content.nerdFontIcons ? "nerdfont" : "unicode")
			: undefined;
		const res = setEnabledStatuslines(selected, { home, nodePath, iconMode: pickedIconMode });
		const msg = res.enabled.length
			? `Configured Copilot CLI statusline: ${res.enabled.join(", ")}`
			: "Disabled Copilot CLI statuslines.";
		await session?.log?.(msg);
		return { cancelled: false, enabled: res.enabled, message: msg };
	}

	const current = getEnabledStatuslines(home);
	const msg = `Current statuslines: ${current.join(", ") || "none"}. Run /statusline-setup [all | none | prs issues subagents worktrees] to change.`;
	await session?.log?.(msg);
	return { cancelled: false, enabled: current, message: msg };
}

export function ensurePluginStatuslineRegistered(extensionId, extensionDir, {
	home = configHome(),
	nodePath = process.execPath,
	includeSiblings = false,
} = {}) {
	try {
		mkdirSync(home, { recursive: true });
		const extRoot = join(home, "extensions");
		const parentDir = dirname(extensionDir);
		const lockSrc = join(parentDir, "state-lock.mjs");
		const lockDst = join(extRoot, "state-lock.mjs");
		if (existsSync(lockSrc) && resolve(lockSrc) !== resolve(lockDst)) {
			mkdirSync(extRoot, { recursive: true });
			copyFileSync(lockSrc, lockDst);
		}
		const candidateIds = includeSiblings ? new Set([extensionId, ...PREFERRED_ORDER]) : new Set([extensionId]);
		for (const id of candidateIds) {
			const srcDir = id === extensionId ? extensionDir : join(parentDir, id);
			if (!existsSync(join(srcDir, "render.mjs"))) continue;
			const dstDir = join(extRoot, id);
			mkdirSync(dstDir, { recursive: true });
			for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
				if (!entry.isFile()) continue;
				if (entry.name === "extension.mjs") continue;
				if (entry.name.endsWith(".mjs") || entry.name === "copilot-extension.json") {
					copyFileSync(join(srcDir, entry.name), join(dstDir, entry.name));
				}
			}
		}

		const composerSrc = join(extensionDir, "compose.mjs");
		const composerDst = join(home, "statusline-compose.mjs");
		if (existsSync(composerSrc)) {
			copyFileSync(composerSrc, composerDst);
		}

		const configPath = join(home, "statusline-config.json");
		const firstRun = !existsSync(configPath);
		if (resolve(home) === resolve(configHome())) {
			let currentIconMode = "auto";
			if (!firstRun) {
				try {
					const rawCfg = JSON.parse(readFileSync(configPath, "utf8"));
					if (["auto", "nerdfont", "unicode"].includes(rawCfg?.iconMode)) {
						currentIconMode = rawCfg.iconMode;
					}
				} catch {
					currentIconMode = "auto";
				}
			}
			if (currentIconMode !== "unicode") {
				ensureWindowsTerminalNerdFont();
			}
		}
		if (firstRun) {
			setEnabledStatuslines(PREFERRED_ORDER, { home, nodePath });
		} else {
			const settingsPath = join(home, "settings.json");
			if (existsSync(settingsPath)) {
				const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
				if (
					(typeof settings?.statusLine?.command === "string" && settings.statusLine.command.toLowerCase().includes("copilot.exe")) ||
					settings?.statusLine?.refreshInterval === 2
				) {
					setEnabledStatuslines(getEnabledStatuslines(home), { home, nodePath });
				}
			}
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
	nerdFont = undefined,
	selfPath = null,
	selfRender = null,
} = {}) {
	const renderers = discoverRenderers(home);
	if (!renderers.length) return "";
	const useNerdFont = shouldUseNerdFont({ home, nerdFont, autoDetect: true });
	const options = {
		home, now, links, color, nerdFont: useNerdFont,
		deferCheckoutDivergence: true,
		reserveGitDirectories: renderers.some(({ name }) => name === "pr-statusline") ? 4 : 0,
	};
	const modules = await Promise.all(renderers.map(async ({ name, path }) => {
		try {
			return { name, path, mod: await import(pathToFileURL(path).href) };
		} catch {
			return { name, path, mod: {} };
		}
	}));
	const checkoutModule = modules.find(({ name }) => name === "worktree-statusline")?.mod;
	const grouped = typeof checkoutModule?.renderEntries === "function" && typeof checkoutModule?.composeGroups === "function";
	const agentModule = modules.find(({ name }) => name === "subagent-statusline")?.mod;
	const structured = grouped || (typeof agentModule?.renderEntries === "function" && typeof agentModule?.renderGroup === "function");
	const blocks = await Promise.all(
		modules.map(async ({ name, path, mod }) => {
			try {
				if (structured && PREFERRED_ORDER.includes(name) && typeof mod.renderEntries === "function") {
					return { name, entries: await mod.renderEntries(payload, options), renderGroup: mod.renderGroup };
				}
				if (selfPath && typeof selfRender === "function" && resolve(path) === resolve(selfPath)) {
					return { name, entries: [{ text: await selfRender(payload, options) }] };
				}
				if (typeof mod.render === "function") {
					return { name, entries: [{ text: await mod.render(payload, options) }] };
				}
			} catch {
				// Ignore broken renderer module so sibling statusline extensions still render.
			}
			return { name, entries: [] };
		}),
	);
	if (grouped && typeof checkoutModule.resolveCheckoutEntries === "function") {
		const checkoutBlock = blocks.find((block) => block.name === "worktree-statusline");
		const prs = blocks.find((block) => block.name === "pr-statusline")?.entries ?? [];
		checkoutBlock.entries = await checkoutModule.resolveCheckoutEntries(payload, checkoutBlock.entries, prs, options);
	}
	const agentBlock = blocks.find((block) => block.name === "subagent-statusline");
	const agentSummary = agentBlock?.renderGroup?.(agentBlock.entries, options) ?? "";
	const agentPrUrls = new Set(agentSummary ? agentBlock.entries.flatMap((entry) => entry.prUrls ?? []) : []);
	for (const entry of blocks.find((block) => block.name === "pr-statusline")?.entries ?? []) {
		entry.compact = entry.provenance?.root === false && entry.provenance?.unknown === false && agentPrUrls.has(entry.url);
	}
	const joined = grouped
		? checkoutModule.composeGroups(blocks, options)
		: joinOutputsHorizontally(blocks.map((block) => block.renderGroup
			? block.renderGroup(block.entries, options)
			: block.entries.filter((entry) => !entry.compact).map((entry) => entry.text).join(color ? " " : " · ")), { color });
	return useNerdFont ? joined : toUnicodeIcons(joined);
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
