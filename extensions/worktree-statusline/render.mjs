import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitContext, sessionContexts } from "./tracker.mjs";

function safeLabel(value) {
	return String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "");
}

function makePill(content, color) {
	return color ? `\x1b[1;38;2;219;234;254;48;2;30;64;115m ${content} \x1b[0m` : content;
}

function checkoutKey(root) {
	const path = resolve(root);
	return process.platform === "win32" ? path.toLowerCase() : path;
}

export function render(payload, { home, color = true } = {}) {
	const { contexts, catchingUp } = sessionContexts(payload, { home });
	if (catchingUp) return makePill("branch/worktree syncing session", color);
	const current = typeof payload?.cwd === "string" && isAbsolute(payload.cwd) ? gitContext(payload.cwd) : null;
	const currentKey = current ? checkoutKey(current.root) : null;
	return contexts.filter((context) => checkoutKey(context.root) !== currentKey).map((context) => {
		const content = `${safeLabel(context.root)} [${safeLabel(context.branch)}]`;
		return makePill(content, color);
	}).join(color ? " " : " | ");
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
