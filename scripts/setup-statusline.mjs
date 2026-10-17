import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

export const EXTENSION_CATALOG = [
	{
		id: "pr-statusline",
		flag: "--prs",
		noFlag: "--no-prs",
		label: "Pull Requests (pr-statusline)",
		description: "Track session PRs across repos/worktrees with CI checks, approvals, review threads, and purple Merged pills",
		files: ["extension.mjs", "collector.mjs", "tracker.mjs", "github.mjs", "render.mjs", "compose.mjs", "copilot-extension.json"],
	},
	{
		id: "issue-statusline",
		flag: "--issues",
		noFlag: "--no-issues",
		label: "GitHub Issues (issue-statusline)",
		description: "Render a separate clickable pill per active session issue with labels, linked PR icon, assignee, and comments",
		files: ["extension.mjs", "tracker.mjs", "github.mjs", "render.mjs", "compose.mjs", "copilot-extension.json"],
	},
	{
		id: "subagent-statusline",
		flag: "--subagents",
		noFlag: "--no-subagents",
		label: "Subagents (subagent-statusline)",
		description: "Show session subagent state counts (starting, exploring, in PR, merged, failed)",
		files: ["extension.mjs", "tracker.mjs", "render.mjs", "compose.mjs", "copilot-extension.json"],
	},
];

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

export function parseStatuslineArgs(argv = []) {
	if (argv.includes("--all")) {
		return EXTENSION_CATALOG.map((e) => e.id);
	}
	const explicitPositives = EXTENSION_CATALOG.filter((e) => argv.includes(e.flag)).map((e) => e.id);
	const explicitNegatives = new Set(EXTENSION_CATALOG.filter((e) => argv.includes(e.noFlag)).map((e) => e.id));
	if (explicitPositives.length > 0) {
		return explicitPositives.filter((id) => !explicitNegatives.has(id));
	}
	if (explicitNegatives.size > 0) {
		return EXTENSION_CATALOG.map((e) => e.id).filter((id) => !explicitNegatives.has(id));
	}
	return null;
}

function parseYesNo(answer, defaultYes = true) {
	const clean = String(answer ?? "").trim().toLowerCase();
	if (!clean) return defaultYes;
	if (["y", "yes", "1", "true"].includes(clean)) return true;
	if (["n", "no", "0", "false"].includes(clean)) return false;
	return defaultYes;
}

export async function promptStatuslineSelection({ input = process.stdin, output = process.stdout } = {}) {
	const rl = createInterface({ input, output });
	try {
		output.write("\nGitHub Copilot CLI Statusline Setup\n");
		output.write("Choose which composable statusline items to enable (press Enter for Yes):\n\n");
		const selected = [];
		for (const item of EXTENSION_CATALOG) {
			const ans = await rl.question(`  Enable ${item.label}? (${item.description}) [Y/n]: `);
			if (parseYesNo(ans, true)) selected.push(item.id);
		}
		return selected;
	} finally {
		rl.close();
	}
}

export function configureStatuslines({
	enabled = EXTENSION_CATALOG.map((e) => e.id),
	merge = false,
	home = process.env.COPILOT_HOME || join(homedir(), ".copilot"),
	repoRoot = REPO_ROOT,
	nodePath = process.execPath,
} = {}) {
	mkdirSync(home, { recursive: true });
	const extRoot = join(home, "extensions");
	mkdirSync(extRoot, { recursive: true });
	const composerPath = join(home, "statusline-compose.mjs");
	const configPath = join(home, "statusline-config.json");
	const settingsPath = join(home, "settings.json");

	let combinedEnabled = [...enabled];
	if (merge && existsSync(configPath)) {
		try {
			const existingCfg = JSON.parse(readFileSync(configPath, "utf8"));
			if (Array.isArray(existingCfg?.enabled)) {
				combinedEnabled = [...new Set([...existingCfg.enabled.map(String), ...combinedEnabled])];
			}
		} catch {
			// Ignore unreadable prior config during merge.
		}
	}
	const validEnabled = EXTENSION_CATALOG.map((e) => e.id).filter((id) => combinedEnabled.includes(id));

	// Copy composer from pr-statusline
	const sourceComposer = join(repoRoot, "extensions", "pr-statusline", "compose.mjs");
	copyFileSync(sourceComposer, composerPath);

	// Copy selected extensions into ~/.copilot/extensions/<id>
	for (const item of EXTENSION_CATALOG) {
		if (!validEnabled.includes(item.id)) continue;
		const srcDir = join(repoRoot, "extensions", item.id);
		const dstDir = join(extRoot, item.id);
		mkdirSync(dstDir, { recursive: true });
		for (const file of item.files) {
			const srcFile = join(srcDir, file);
			if (existsSync(srcFile)) {
				copyFileSync(srcFile, join(dstDir, file));
			}
		}
	}

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

	// Write statusline-config.json so compose.mjs only renders the selected extensions
	atomicWriteText(
		configPath,
		`${JSON.stringify({ version: 1, enabled: validEnabled, iconMode: existingIconMode, updatedAt: new Date().toISOString() }, null, 2)}\n`,
	);

	// Update settings.json
	let settings = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		} catch {
			throw new Error(`Could not parse existing ${settingsPath}`);
		}
		const backupPath = `${settingsPath}.statusline.bak`;
		if (!existsSync(backupPath)) {
			copyFileSync(settingsPath, backupPath);
		}
	}

	const command = `"${nodePath}" "${composerPath}"`;
	if (validEnabled.length > 0) {
		settings.statusLine = {
			type: "command",
			command,
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

	return {
		home,
		composerPath,
		configPath,
		settingsPath,
		enabled: validEnabled,
	};
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log([
			"Usage: node scripts/setup-statusline.mjs [options]",
			"",
			"Interactive by default (prompts for PRs, Issues, and Subagents).",
			"",
			"Options:",
			"  --all          Enable all three statuslines without prompting",
			"  --prs          Enable Pull Requests statusline (pr-statusline)",
			"  --issues       Enable GitHub Issues statusline (issue-statusline)",
			"  --subagents    Enable Subagents statusline (subagent-statusline)",
			"  --merge        Merge enabled flag(s) with existing statusline-config.json",
			"  --no-prs       Disable Pull Requests statusline",
			"  --no-issues    Disable GitHub Issues statusline",
			"  --no-subagents Disable Subagents statusline",
		].join("\n"));
		return;
	}
	const merge = argv.includes("--merge");
	let enabled = parseStatuslineArgs(argv);
	if (enabled === null) {
		if (!process.stdin.isTTY) {
			enabled = EXTENSION_CATALOG.map((e) => e.id);
		} else {
			enabled = await promptStatuslineSelection();
		}
	}
	const result = configureStatuslines({ enabled, merge });
	if (result.enabled.length === 0) {
		console.log("\nDisabled custom statuslines in settings.json.");
	} else {
		console.log(`\nConfigured Copilot CLI statusline (${result.enabled.join(", ")})`);
		console.log(`  Compositor: ${result.composerPath}`);
		console.log(`  Config:     ${result.configPath}`);
		console.log(`  Settings:   ${result.settingsPath}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((err) => {
		console.error(`[setup-statusline] ${err.message}`);
		process.exitCode = 1;
	});
}
