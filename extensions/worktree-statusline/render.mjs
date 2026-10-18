import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkoutKey, gitContext, sessionContexts } from "./tracker.mjs";
export { composeGroups } from "./grouping.mjs";

function safeLabel(value) {
	return String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "");
}

function makePill(content, color) {
	return color ? `\x1b[1;38;2;219;234;254;48;2;30;64;115m ${content} \x1b[0m` : content;
}

export function renderEntries(payload, { home, color = true } = {}) {
	const { contexts, catchingUp, agentCheckouts } = sessionContexts(payload, { home });
	if (catchingUp) return [{ text: makePill("branch/worktree syncing session", color) }];
	const current = typeof payload?.cwd === "string" && isAbsolute(payload.cwd) ? gitContext(payload.cwd) : null;
	const currentKey = current ? checkoutKey(current.root) : null;
	return contexts.map((context) => {
		const content = `${safeLabel(context.root)} [${safeLabel(context.branch)}]`;
		return {
			...context, kind: "checkout", key: checkoutKey(context.root), agentCheckouts,
			text: checkoutKey(context.root) === currentKey ? "" : makePill(content, color),
		};
	});
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
