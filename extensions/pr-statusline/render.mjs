import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { OCTICONS, syncSession } from "./tracker.mjs";
import { composeStatusLine } from "./compose.mjs";

const clean = (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

const PALETTE = {
	critical: {
		mid: "\x1b[1;38;2;255;224;222;48;2;122;32;40m",
		cap: "\x1b[38;2;122;32;40m",
	},
	attention: {
		mid: "\x1b[1;38;2;255;238;196;48;2;118;68;16m",
		cap: "\x1b[38;2;118;68;16m",
	},
	passing: {
		mid: "\x1b[1;38;2;216;250;228;48;2;22;92;50m",
		cap: "\x1b[38;2;22;92;50m",
	},
	merged: {
		mid: "\x1b[1;38;2;237;224;255;48;2;88;44;142m",
		cap: "\x1b[38;2;88;44;142m",
	},
	neutral: {
		mid: "\x1b[1;38;2;226;232;240;48;2;58;70;88m",
		cap: "\x1b[38;2;58;70;88m",
	},
	reset: "\x1b[0m",
};

const SEGMENTER = new Intl.Segmenter(void 0, { granularity: "grapheme" });
const EMOJI_PRES = /\p{Emoji_Presentation}/v;

function visualWidth(text) {
	const plain = String(text).replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
	let width = 0;
	for (const { segment } of SEGMENTER.segment(plain)) {
		const cp = segment.codePointAt(0);
		const wide = cp !== 0x26a1 && (EMOJI_PRES.test(segment) || segment.includes("\uFE0F") || (cp >= 0x1f000 && cp <= 0x1faff));
		width += wide ? 2 : 1;
	}
	return width;
}

function makePill(text, level, { color } = {}) {
	const theme = PALETTE[level] ?? PALETTE.neutral;
	if (!color) return { top: "", mid: text, bot: "" };
	const padded = ` ${text} `;
	const width = visualWidth(padded);
	return {
		top: `${theme.cap}${"▂".repeat(width)}${PALETTE.reset}`,
		mid: `${theme.mid}${padded}${PALETTE.reset}`,
		bot: `${theme.cap}${"▔".repeat(width)}${PALETTE.reset}`,
	};
}

function prAttentionLevel(rawStatus) {
	if (!rawStatus) return "neutral";
	if (rawStatus.includes(OCTICONS.merged) || rawStatus.includes("🟣") || /\bMerged\b/i.test(rawStatus)) return "merged";
	if (rawStatus.includes(OCTICONS.fail) || rawStatus.includes(OCTICONS.conflict) || rawStatus.includes(OCTICONS.changes) ||
			rawStatus.includes("❌") || rawStatus.includes("⚠️") || rawStatus.includes("🔄")) {
		return "critical";
	}
	const commentsMatch = new RegExp(`(?:${OCTICONS.comment}|💬)\\s*(\\d+)\\/(\\d+)`).exec(rawStatus);
	const hasUnresolvedComments = commentsMatch && Number(commentsMatch[1]) < Number(commentsMatch[2]);
	const approvalsMatch = new RegExp(`(?:${OCTICONS.approved}|👍)\\s*(\\d+)\\/(\\d+)`).exec(rawStatus);
	const needsApprovals = approvalsMatch && Number(approvalsMatch[2]) > 0 && Number(approvalsMatch[1]) < Number(approvalsMatch[2]);
	if (hasUnresolvedComments || needsApprovals || rawStatus.includes(OCTICONS.running) || rawStatus.includes("⏳")) {
		return "attention";
	}
	if (rawStatus.includes(OCTICONS.draft) || rawStatus.includes("📝")) return "neutral";
	if (rawStatus.includes(OCTICONS.pass) || rawStatus.includes("✅")) return "passing";
	return "neutral";
}

function formatPrItem(pr, _currentRepo, { links, color }) {
	const displayLabel = pr.label;
	let raw = pr.status ? clean(pr.status).trim() : "";
	const level = prAttentionLevel(raw);
	const theme = PALETTE[level] ?? PALETTE.neutral;
	let leadIcon = `${OCTICONS.pr} `;
	if (raw.startsWith(OCTICONS.draft) || raw.startsWith("📝")) {
		leadIcon = `${OCTICONS.draft} `;
		raw = raw.replace(/^(?:\uF4DD|📝)\s*(?:·\s*)?/, "");
	} else if (raw.startsWith(OCTICONS.merged) || raw.startsWith("\uF419") || raw.startsWith("🟣")) {
		leadIcon = `${OCTICONS.merged} `;
		raw = raw.replace(/^(?:\uE727|\uF419|🟣)\s*/, "");
	}
	const labelText = links
		? (color
			? `\x1b]8;;${pr.url}\x07${displayLabel}\x1b]8;;\x07${PALETTE.reset}${theme.mid}`
			: `\x1b]8;;${pr.url}\x07${displayLabel}\x1b]8;;\x07`)
		: `${displayLabel} (${pr.url})`;
	const content = raw ? `${leadIcon}${labelText} ${raw}` : `${leadIcon}${labelText}`;
	return makePill(content, level, { color });
}

export function render(payload, {
	home,
	now = Date.now(),
	links = true,
	color = links,
	fetchPrStatus,
	prCacheTtlMs,
} = {}) {
	if (!payload.session_id) return "";
	const { state } = syncSession(payload, { home, now, fetchPrStatus, prCacheTtlMs });
	if (!state || !state.prs.length) return "";
	const currentRepo = state.repository || null;
	const allPills = state.prs.map((pr) => formatPrItem(pr, currentRepo, { links, color }));
	if (!color) {
		return allPills.map((p) => p.mid).join(" · ");
	}
	const topLine = allPills.map((p) => p.top).join(" ");
	const midLine = allPills.map((p) => p.mid).join(" ");
	const botLine = allPills.map((p) => p.bot).join(" ");
	return `${topLine}\n${midLine}\n${botLine}`;
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
		const selfPath = fileURLToPath(import.meta.url);
		const composed = await composeStatusLine(payload, { links: !plain, color, selfPath, selfRender: render });
		const output = composed || render(payload, { links: !plain, color });
		if (output) console.log(output);
	} catch (error) {
		console.error(`[pr-statusline] ${error.message}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();


