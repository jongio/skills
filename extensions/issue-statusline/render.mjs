import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ICONS, syncSession } from "./tracker.mjs";
import { shouldUseNerdFont, toUnicodeIcons } from "./compose.mjs";

const clean = (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

const PALETTE = {
	critical: {
		mid: "\x1b[1;38;2;255;224;222;48;2;122;32;40m",
	},
	attention: {
		mid: "\x1b[1;38;2;255;238;196;48;2;118;68;16m",
	},
	passing: {
		mid: "\x1b[1;38;2;216;250;228;48;2;22;92;50m",
	},
	merged: {
		mid: "\x1b[1;38;2;237;224;255;48;2;88;44;142m",
	},
	neutral: {
		mid: "\x1b[1;38;2;226;232;240;48;2;58;70;88m",
	},
	reset: "\x1b[0m",
};

function makePill(text, level, { color } = {}) {
	const theme = PALETTE[level] ?? PALETTE.neutral;
	if (!color) return { mid: text };
	const padded = ` ${text} `;
	return {
		mid: `${theme.mid}${padded}${PALETTE.reset}`,
	};
}

function issueAttentionLevel(rawStatus) {
	if (!rawStatus) return "attention";
	if (rawStatus.includes(ICONS.closed) || /\bClosed\b/i.test(rawStatus)) return "merged";
	if (rawStatus.includes(ICONS.bug) || /\b(?:P0|critical|blocker|security)\b/i.test(rawStatus)) return "critical";
	if (rawStatus.includes(ICONS.linkedPr) || rawStatus.includes(ICONS.assignee)) return "passing";
	return "attention";
}

function formatIssueItem(issue, _currentRepo, { links, color, nerdFont = true }) {
	const displayLabel = issue.label;
	let raw = issue.status ? clean(issue.status).trim() : "";
	const level = issueAttentionLevel(raw);
	const theme = PALETTE[level] ?? PALETTE.neutral;
	let leadIcon = `${ICONS.open} `;
	if (raw.startsWith(ICONS.closed)) {
		leadIcon = `${ICONS.closed} `;
		raw = raw.replace(/^\uF41D\s*/, "");
	} else if (raw.startsWith(ICONS.bug)) {
		leadIcon = `${ICONS.bug} `;
		raw = raw.replace(/^\uF188\s*/, "");
	}
	const labelText = links
		? (color
			? `\x1b]8;;${issue.url}\x07${displayLabel}\x1b]8;;\x07${PALETTE.reset}${theme.mid}`
			: `\x1b]8;;${issue.url}\x07${displayLabel}\x1b]8;;\x07`)
		: `${displayLabel} (${issue.url})`;
	const rawContent = raw ? `${leadIcon}${labelText} ${raw}` : `${leadIcon}${labelText}`;
	const content = nerdFont ? rawContent : toUnicodeIcons(rawContent);
	return makePill(content, level, { color });
}

export function render(payload, {
	home,
	now = Date.now(),
	links = true,
	color = links,
	nerdFont = undefined,
	fetchIssueStatus,
	issueCacheTtlMs,
} = {}) {
	if (!payload?.session_id) return "";
	const { state } = syncSession(payload, { home, now, fetchIssueStatus, issueCacheTtlMs });
	if (!state || !state.issues.length) return "";
	const useNerdFont = shouldUseNerdFont({ home, nerdFont, autoDetect: false });
	const currentRepo = state.repository || null;
	const allPills = state.issues.map((item) => formatIssueItem(item, currentRepo, { links, color, nerdFont: useNerdFont }));
	if (!color) {
		return allPills.map((p) => p.mid).join(" · ");
	}
	return allPills.map((p) => p.mid).join(" ");
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
		const output = render(payload, { links: !plain, color, nerdFont: shouldUseNerdFont({ autoDetect: true }) });
		if (output) console.log(output);
	} catch (error) {
		console.error(`[issue-statusline] ${error.message}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
