import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { render } from "../render.mjs";

test("one render shares checkout reads but the next render sees live changes", () => {
	const home = mkdtempSync(join(tmpdir(), "worktree-performance-"));
	try {
		const checkout = join(home, "repo");
		mkdirSync(checkout);
		const git = (...args) => {
			const result = spawnSync("git", ["-C", checkout, ...args], { encoding: "utf8", windowsHide: true });
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
		};
		git("init", "--initial-branch=main");
		const directory = join(home, "session-state", "perf");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "events.jsonl"), JSON.stringify({
			type: "session.start", data: { cwd: checkout },
		}) + "\n");
		const payload = { session_id: "perf", cwd: checkout };
		let calls = [];
		const options = { home, color: false, run: (...args) => {
			calls.push(args[1]);
			return spawnSync(...args);
		} };
		assert.equal(render(payload, options), "");
		assert.equal(calls.length, 4, "current checkout must not be read twice");
		const outside = { ...payload, cwd: home };
		writeFileSync(join(checkout, "untracked.txt"), "new\n");
		calls = [];
		assert.equal(render(outside, options), `${checkout} [⎇ main%]`);
		assert.equal(calls.filter((args) => args[2] === "status").length, 1);
		git("checkout", "-b", "feature");
		assert.equal(render(outside, options), `${checkout} [⎇ feature%]`);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("nested directories share expensive reads without merging nested repositories", () => {
	const home = mkdtempSync(join(tmpdir(), "worktree-performance-nested-"));
	try {
		const checkout = join(home, "repo");
		mkdirSync(checkout);
		const initialize = (cwd, branch) => {
			const result = spawnSync("git", ["-C", cwd, "init", `--initial-branch=${branch}`], {
				encoding: "utf8", windowsHide: true,
			});
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
		};
		initialize(checkout, "main");
		const directories = Array.from({ length: 4 }, (_, i) => join(checkout, `dir-${i}`));
		for (const directory of directories) mkdirSync(directory);
		initialize(directories[3], "nested");
		const transcriptDir = join(home, "session-state", "nested");
		mkdirSync(transcriptDir, { recursive: true });
		writeFileSync(join(transcriptDir, "events.jsonl"), [checkout, ...directories].map((cwd) =>
			JSON.stringify({ type: "session.context_changed", data: { cwd } })).join("\n") + "\n");
		const calls = [];
		const output = render({ session_id: "nested", cwd: home }, {
			home, color: false, run: (...args) => { calls.push(args[1]); return spawnSync(...args); },
		});
		assert.ok(output.includes(`${checkout} [⎇ main%]`));
		assert.ok(output.includes(`${directories[3]} [⎇ nested]`));
		assert.equal(calls.filter((args) => args[2] === "status").length, 2);
		assert.equal(calls.filter((args) => args[2] === "symbolic-ref").length, 2);
		assert.equal(calls.filter((args) => args[2] === "config").length, 2);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
