import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ICONS, syncSession } from "./tracker.mjs";
import { shouldUseNerdFont, toUnicodeIcons } from "./compose.mjs";

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

export function subagentHoverUrl(sessionId, counts = null, repository = null, host = "github.com") {
	const safeHost = host || "github.com";
	const base = repository
		? `https://${safeHost}/${repository}/pulls`
		: `https://${safeHost}/pulls`;
	const parts = [`Subagents:${encodeURIComponent(String(sessionId ?? "").slice(0, 8))}`];
	if (counts) {
		if (counts.starting > 0) parts.push(`${counts.starting}_starting`);
		if (counts.exploring > 0) parts.push(`${counts.exploring}_exploring`);
		if (counts.inPr > 0) parts.push(`${counts.inPr}_in_PR`);
		if (counts.merged > 0) parts.push(`${counts.merged}_merged`);
		if (counts.failed > 0) parts.push(`${counts.failed}_failed`);
	}
	return `${base}#${parts.join("__")}`;
}

export function renderGroup(entries, { home, color = true, nerdFont = undefined } = {}) {
	const c = { total: 0, starting: 0, exploring: 0, inPr: 0, merged: 0, failed: 0 };
	for (const entry of entries) for (const key of Object.keys(c)) c[key] += entry.counts[key];
	if (c.total === 0) return "";
	if (c.starting === 0 && c.exploring === 0 && c.inPr === 0 && c.merged === 0 && c.failed === 0) return "";

	const statusParts = [];
	if (c.starting > 0) statusParts.push(`${ICONS.starting} ${c.starting} starting`);
	if (c.exploring > 0) statusParts.push(`${ICONS.exploring} ${c.exploring} exploring`);
	if (c.inPr > 0) statusParts.push(`${ICONS.inPr} ${c.inPr} in PR`);
	if (c.merged > 0) statusParts.push(`${ICONS.merged} ${c.merged} merged`);
	if (c.failed > 0) statusParts.push(`${ICONS.failed} ${c.failed} failed`);

	const level = c.failed > 0
		? "critical"
		: (c.starting > 0 || c.exploring > 0 || c.inPr > 0 ? "attention" : (c.merged > 0 ? "merged" : "passing"));
	const statusText = statusParts.join(" ");
	const rawContent = `${ICONS.agent} ${statusText}`;
	const useNerdFont = shouldUseNerdFont({ home, nerdFont, autoDetect: false });
	const content = useNerdFont ? rawContent : toUnicodeIcons(rawContent);
	const pill = makePill(content, level, { color });
	return pill.mid;
}

export function renderEntries(payload, { home } = {}) {
	if (!payload?.session_id) return [];
	const { tracker } = syncSession(payload, { home });
	if (!tracker) return [];
	return [...tracker.agents].map(([agentId, agent]) => ({
		agentId, prUrls: agent.prs ?? [], counts: tracker.dismissed ? tracker.counts([]) : tracker.counts([agent]),
		working: agent.status === "starting",
	}));
}

export function render(payload, options = {}) {
	return renderGroup(renderEntries(payload, options), options);
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
		console.error(`[subagent-statusline] ${error.message}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
