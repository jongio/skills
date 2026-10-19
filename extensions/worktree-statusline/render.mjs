import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkoutDivergence, checkoutKey, checkoutLabel, gitContext, sessionContexts } from "./tracker.mjs";
import { resolveLinkedCheckouts } from "./worktrees.mjs";
export { composeGroups } from "./grouping.mjs";

function makePill(content, color) {
	return color ? `\x1b[1;38;2;219;234;254;48;2;30;64;115m ${content} \x1b[0m` : content;
}

export function renderEntries(payload, { home, color = true, reserveGitDirectories = 0, deferCheckoutDivergence = false, run } = {}) {
	const contextCache = new Map();
	const { contexts, catchingUp, agentCheckouts, agentCurrentCheckouts, focusKey, remainingGitDirectories } =
		sessionContexts(payload, { home, reserveGitDirectories, run, contextCache });
	if (catchingUp) return [{ text: makePill("branch/worktree syncing session", color) }];
	const current = typeof payload?.cwd === "string" && isAbsolute(payload.cwd) ? gitContext(payload.cwd, { run, contextCache }) : null;
	const currentKey = current ? checkoutKey(current.root) : null;
	return contexts.map((context) => checkoutEntry(context, currentKey, {
		color, agentCheckouts, agentCurrentCheckouts, remainingGitDirectories, focused: checkoutKey(context.root) === focusKey,
		...(deferCheckoutDivergence || checkoutKey(context.root) === currentKey ? {} : { divergence: checkoutDivergence(context, [], { run }) }),
	}));
}

function checkoutEntry(context, currentKey, { color, ...metadata }) {
	const content = checkoutLabel({ ...context, ...metadata });
	return {
		...context, ...metadata, currentKey, kind: "checkout", key: checkoutKey(context.root),
		text: checkoutKey(context.root) === currentKey ? "" : makePill(content, color),
	};
}

export function resolveCheckoutEntries(payload, entries, prs, options = {}) {
	const checkouts = entries.filter((entry) => entry.kind === "checkout");
	const extra = resolveLinkedCheckouts(payload, checkouts, prs, options);
	const currentKey = checkouts[0]?.currentKey ?? null;
	return [...entries, ...extra.map((context) => ({ ...context, kind: "checkout", currentKey, focused: false }))].map((entry) =>
		entry.kind !== "checkout" || checkoutKey(entry.root) === currentKey ? entry : checkoutEntry(entry, currentKey, {
			color: options.color !== false, divergence: checkoutDivergence(entry, prs, options),
		}));
}

export function render(payload, options = {}) {
	return renderEntries(payload, options).map((entry) => entry.text).filter(Boolean).join(options.color === false ? " | " : " ");
}

async function main() {
	try {
		let input = "";
		process.stdin.setEncoding("utf8");
		for await (const chunk of process.stdin) input += chunk;
		const payload = JSON.parse(input);
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Expected session JSON on stdin.");
		const plain = process.argv.includes("--plain");
		const output = render(payload, { color: !plain && !process.argv.includes("--no-color") && !process.env.NO_COLOR });
		if (output) console.log(output);
	} catch (error) {
		console.error(`[worktree-statusline] ${error.message}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
