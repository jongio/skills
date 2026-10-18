import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkoutLabel, describeSessionDirectory, dirtyMarkers, gitContext } from "../tracker.mjs";
import { render } from "../render.mjs";
import { composeStatusLine } from "../compose.mjs";
import { configureStatuslines } from "../../../scripts/setup-statusline.mjs";

test("porcelain markers distinguish status columns and skip literal rename and copy paths", () => {
	for (const [input, expected] of [
		["", ""], [" M file\0", "*"], ["M  file\0", "+"], ["?? file\0", "%"],
		[" M file\0?? other\0", "*%"], ["A  file\0?? other\0", "+%"],
		["MM file\0", "*+"], ["MM file\0?? other\0", "*+%"],
		["!! ignored\0", ""], ["R  destination\0?? old-name\0", "+"],
		["C  destination\0 M old-name\0", "+"], ["UU conflict\0", "*+"],
	]) assert.equal(dirtyMarkers(input), expected, JSON.stringify(input));
	assert.equal(checkoutLabel({ root: "path\x1b\n", branch: "feature\u202e", dirty: "*+%" }), "path [⎇ feature*+%]");
});

test("live native markers cover clean, each state, combinations and staged then unstaged changes", async () => {
	const home = mkdtempSync(join(tmpdir(), "checkout-markers-"));
	try {
		const root = join(home, "repo ; $literal");
		mkdirSync(root);
		const git = (...args) => {
			const result = spawnSync("git", ["-C", root, ...args], {
				encoding: "utf8", timeout: 10000, windowsHide: true,
			});
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
		};
		const settle = () => {
			git("add", ".");
			git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
				"-c", `core.hooksPath=${join(home, "no-hooks")}`, "commit", "-m", "fixture");
		};
		git("init", "--initial-branch=main");
		writeFileSync(join(root, "tracked.txt"), "original\n");
		settle();
		assert.equal(gitContext(root).dirty, "");
		assert.equal(checkoutLabel({ ...gitContext(root), root }), `${root} [⎇ main]`);
		writeFileSync(join(root, "tracked.txt"), "unstaged\n");
		assert.equal(gitContext(root).dirty, "*");
		git("add", "tracked.txt");
		assert.equal(gitContext(root).dirty, "+");
		writeFileSync(join(root, "tracked.txt"), "staged then modified\n");
		assert.equal(gitContext(root).dirty, "*+");
		settle();
		writeFileSync(join(root, "untracked.txt"), "untracked\n");
		assert.equal(gitContext(root).dirty, "%", "untracked files must not set staged or unstaged markers");
		writeFileSync(join(root, "tracked.txt"), "unstaged again\n");
		assert.equal(gitContext(root).dirty, "*%");
		git("add", "tracked.txt");
		assert.equal(gitContext(root).dirty, "+%");
		writeFileSync(join(root, "tracked.txt"), "changed after staging\n");
		assert.equal(gitContext(root).dirty, "*+%");
		const session = join(home, "session-state", "markers");
		mkdirSync(session, { recursive: true });
		writeFileSync(join(session, "events.jsonl"), JSON.stringify({
			type: "session.start", data: { context: { cwd: root } },
		}) + "\n");
		const payload = { session_id: "markers", cwd: home };
		configureStatuslines({
			home, repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
			enabled: ["worktree-statusline"],
		});
		const label = `${root} [⎇ main*+%]`;
		assert.equal(render(payload, { home, color: false }), label);
		assert.equal(describeSessionDirectory(payload, { home }), label);
		for (const color of [false, true]) {
			const expected = color ? `\x1b[1;38;2;219;234;254;48;2;30;64;115m ${label} \x1b[0m` : label;
			assert.equal(render(payload, { home, color }), expected);
			assert.equal(await composeStatusLine(payload, { home, color, links: false }), expected);
			assert.ok(!expected.includes("\x1b]8;"), "checkout labels must not become hyperlinks");
		}
		settle();
		assert.equal(render(payload, { home, color: false }), `${root} [⎇ main]`, "cached markers refresh after the checkout becomes clean");
		const calls = [];
		const context = gitContext(root, { run: (command, args, options) => {
			calls.push(args);
			return spawnSync(command, args, options);
		} });
		assert.equal(context.dirty, "");
		assert.equal(calls.filter((args) => args[2] === "status").length, 1);
		assert.throws(() => gitContext(root, { run: (command, args, options) =>
			args[2] === "status" ? { status: 1, stdout: "" } : spawnSync(command, args, options),
		}), /Cannot read Git status/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
