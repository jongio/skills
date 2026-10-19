import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { clearSessionStatusline } from "../session-statusline.mjs";
import { readState, SessionTracker, writeState } from "../tracker.mjs";
import { IssueTracker, readState as readIssues, writeState as writeIssues } from "../../issue-statusline/tracker.mjs";
import { readState as readAgents, SubagentTracker, writeState as writeAgents } from "../../subagent-statusline/tracker.mjs";
import { sessionDirectory } from "../../worktree-statusline/tracker.mjs";
import { withStateLock } from "../../state-lock.mjs";

const extensions = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const moduleUrl = (...parts) => JSON.stringify(pathToFileURL(join(extensions, ...parts)).href);
async function fixture(run) {
	const home = realpathSync.native(mkdtempSync(join(tmpdir(), "concurrent-clear-")));
	const children = [];
	try { await run(home, children); } finally {
		for (const child of children) if (child.exitCode === null) child.kill();
		await Promise.all(children.map((child) => child.exitCode === null ? once(child, "exit") : null));
		rmSync(home, { recursive: true, force: true });
	}
}
function childRun(script, children) {
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
		stdio: ["ignore", "ignore", "pipe", "ipc"], timeout: 15000, windowsHide: true,
	});
	children.push(child);
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const finished = once(child, "exit").then(([code]) => assert.equal(code, 0, stderr));
	const message = () => Promise.race([
		once(child, "message").then(([value]) => value),
		finished.then(() => { throw new Error(`Child exited before synchronization: ${stderr}`); }),
	]);
	return { child, finished, message };
}
function pauseWrite(path, release) {
	return `
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		const original = fs.writeFileSync;
		fs.writeFileSync = (file, ...args) => {
			if (String(file).startsWith(${JSON.stringify(path)} + ".") && String(file).endsWith(".tmp")) {
				process.send("paused");
				while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
			return original(file, ...args);
		};
		syncBuiltinESMExports();
	`;
}
function clearChild(home, id, children, target) {
	return childRun(`
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		const original = fs.mkdirSync;
		let reported = false;
		fs.mkdirSync = (path, ...args) => {
			try { return original(path, ...args); }
			catch (error) {
				if (String(path) === ${JSON.stringify(`${target}.lock`)} && error.code === "EEXIST" && !reported) {
					reported = true;
					process.send("contended");
				}
				throw error;
			}
		};
		syncBuiltinESMExports();
		const { clearSessionStatusline } = await import(${moduleUrl("pr-statusline", "session-statusline.mjs")});
		clearSessionStatusline({ session_id: ${JSON.stringify(id)} }, { home: ${JSON.stringify(home)}, now: 2000 });
		if (!reported) process.send("cleared");
	`, children);
}

for (const component of ["pr-statusline", "issue-statusline", "subagent-statusline"]) {
	test(`${component} serializes a clear against an overlapping state-file commit`, async () => fixture(async (home, children) => {
		const id = "overlap";
		const target = join(home, component, `${id}.json`);
		const release = join(home, "release");
		if (component === "pr-statusline") {
			const tracker = new SessionTracker(id);
			tracker.add("example/widget#1");
			writeState(tracker.snapshot(), home);
		} else if (component === "issue-statusline") {
			const tracker = new IssueTracker(id);
			tracker.add("example/widget#2");
			writeIssues(tracker.snapshot(), home);
		} else {
			const tracker = new SubagentTracker(id);
			tracker.ensureAgent("old");
			writeAgents(tracker.snapshot(), home);
		}
		const writer = childRun(`
			${pauseWrite(target, release)}
			const { readState, writeState } = await import(${moduleUrl(component, "tracker.mjs")});
			writeState(readState(${JSON.stringify(id)}, ${JSON.stringify(home)}), ${JSON.stringify(home)});
		`, children);
		assert.equal(await writer.message(), "paused");
		const clearer = clearChild(home, id, children, target);
		const result = await clearer.message();
		writeFileSync(release, "");
		await Promise.all([writer.finished, clearer.finished]);
		const saved = component === "pr-statusline" ? readState(id, home)
			: component === "issue-statusline" ? readIssues(id, home) : readAgents(id, home);
		assert.equal(saved.clearedAt, 2000);
		assert.deepEqual(saved.prs ?? saved.issues ?? saved.agents, component === "subagent-statusline" ? {} : []);
		assert.equal(result, "contended", "clear must wait for the in-flight comparison and commit");
		assert.equal(existsSync(`${target}.lock`), false);
	}));
}

test("worktree replay and clear share a lock and replay returns the newer dismissal boundary", async () => fixture(async (home, children) => {
	const id = "worktree-overlap";
	const directory = join(home, "session-state", id);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "events.jsonl"), JSON.stringify({
		type: "session.start", timestamp: new Date(1000).toISOString(), data: { cwd: home },
	}) + "\n");
	const target = join(home, "worktree-statusline", `${id}.json`);
	const release = join(home, "release");
	const writer = childRun(`
		${pauseWrite(target, release)}
		const { sessionDirectory } = await import(${moduleUrl("worktree-statusline", "tracker.mjs")});
		sessionDirectory({ session_id: ${JSON.stringify(id)} }, { home: ${JSON.stringify(home)} });
	`, children);
	assert.equal(await writer.message(), "paused");
	const clearer = clearChild(home, id, children, target);
	const result = await clearer.message();
	writeFileSync(release, "");
	await Promise.all([writer.finished, clearer.finished]);
	assert.equal(result, "contended");
	const location = sessionDirectory({ session_id: id, cwd: home }, { home });
	assert.deepEqual(location.directories, []);
	assert.equal(location.cwd, null);
}));

test("a stale writer queued behind clear reloads the newer state before committing or returning", async () => fixture((home) => {
	const id = "queued";
	const tracker = new SessionTracker(id);
	tracker.add("example/widget#1");
	writeState(tracker.snapshot(), home);
	const stale = readState(id, home);
	clearSessionStatusline({ session_id: id }, { home, now: 2000 });
	assert.deepEqual(writeState(stale, home).prs, []);
	assert.equal(writeState(stale, home).clearedAt, 2000);
}));

test("state locks release after a failed action and report contention timeouts", async () => fixture((home) => {
	const file = join(home, "state.json");
	assert.throws(() => withStateLock(file, () => { throw new Error("write failed"); }), /write failed/);
	assert.equal(existsSync(`${file}.lock`), false);
	mkdirSync(`${file}.lock`);
	assert.throws(() => withStateLock(file, () => assert.fail("must not write"), { timeoutMs: 0 }), /Timed out.*state\.json\.lock/);
	rmSync(`${file}.lock`, { recursive: true });
	assert.equal(withStateLock(file, () => "released"), "released");
}));
