import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { composeStatusLine, discoverRenderers, readSessionName, setSessionName } from "../compose.mjs";

async function fixture(run) {
	const home = mkdtempSync(join(tmpdir(), "compositor-isolation-"));
	try { await run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}
function renderer(home, name, source) {
	const directory = join(home, "extensions", name);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "render.mjs");
	writeFileSync(path, source);
	return path;
}
const plain = { color: false, links: false, nerdFont: false };

test("renderer discovery respects disabled extensions and ignores incomplete installations", async () => fixture(async (home) => {
	assert.deepEqual(discoverRenderers(home), []);
	renderer(home, "pr-statusline", 'export const render = () => "PR";');
	renderer(home, "disabled", 'throw new Error("must not load disabled extension");');
	mkdirSync(join(home, "extensions", "incomplete"));
	writeFileSync(join(home, "statusline-config.json"), JSON.stringify({ enabled: ["pr-statusline"] }));
	assert.deepEqual(discoverRenderers(home).map((entry) => entry.name), ["pr-statusline"]);
	assert.equal(await composeStatusLine({}, { home, ...plain }), "PR");
}));

test("broken imports and renderers do not discard healthy sibling output", async () => fixture(async (home) => {
	renderer(home, "pr-statusline", 'export const render = () => "PR";');
	renderer(home, "broken-import", "this is not valid JavaScript");
	renderer(home, "broken-render", 'export const render = () => { throw new Error("unavailable"); };');
	renderer(home, "issue-statusline", 'export const render = () => "Issue";');
	renderer(home, "unsupported", "export const metadata = {};");
	assert.equal(await composeStatusLine({}, { home, ...plain }), "PR · Issue");
}));

test("a failed structured checkout provider retains PRs on the unlabeled fallback row", async () => fixture(async (home) => {
	const module = renderer(home, "worktree-statusline", `
		export const renderEntries = () => { throw new Error("Git unavailable"); };
		export { composeGroups } from ${JSON.stringify(new URL("../grouping.mjs", import.meta.url).href)};
	`);
	renderer(home, "pr-statusline", 'export const renderEntries = () => [{ url: "https://github.com/example/widget/pull/1", text: "PR" }];');
	assert.equal(await composeStatusLine({}, { home, ...plain }), "PR");
	assert.equal(await composeStatusLine({}, {
		home, ...plain, selfPath: module, selfRender: () => "must not replace structured provider",
	}), "PR");
}));

test("legacy self-render hooks preserve sibling composition without re-entering their renderer", async () => fixture(async (home) => {
	const selfPath = renderer(home, "pr-statusline", 'export const render = () => { throw new Error("must use self render"); };');
	renderer(home, "issue-statusline", 'export const render = () => "Issue";');
	let calls = 0;
	assert.equal(await composeStatusLine({}, {
		home, ...plain, selfPath, selfRender: () => { calls++; return "Self"; },
	}), "Self · Issue");
	assert.equal(calls, 1);
}));

test("all distributable composers share the same session name implementation", () => {
	const source = readFileSync(new URL("../compose.mjs", import.meta.url), "utf8");
	for (const id of ["pr", "issue", "subagent"]) {
		assert.equal(readFileSync(new URL(`../../${id}-statusline/compose.mjs`, import.meta.url), "utf8"), source);
	}
});

test("custom names persist per session and clear independently of siblings and configuration", async () => fixture(async (home) => {
	const payload = { session_id: "named-session" };
	renderer(home, "pr-statusline", 'export const render = () => "PR";');
	const configPath = join(home, "statusline-config.json");
	writeFileSync(configPath, JSON.stringify({ enabled: ["pr-statusline"] }));
	const config = readFileSync(configPath, "utf8");
	assert.equal(readSessionName(payload.session_id, { home }), "");
	assert.equal(setSessionName(payload.session_id, "  API   migration  ", { home }), "API migration");
	assert.equal(readSessionName(payload.session_id, { home }), "API migration");
	assert.equal(await composeStatusLine(payload, { home, ...plain }), "API migration · PR");
	assert.equal(await composeStatusLine({ session_id: "other-session" }, { home, ...plain }), "PR");
	setSessionName("other-session", "Other work", { home });
	assert.equal(await composeStatusLine(payload, { home, ...plain }), "API migration · PR");
	assert.equal(setSessionName(payload.session_id, "New name", { home }), "New name");
	assert.equal(await composeStatusLine(payload, { home, ...plain }), "New name · PR");
	assert.equal(setSessionName(payload.session_id, null, { home }), "");
	assert.equal(await composeStatusLine(payload, { home, ...plain }), "PR");
	assert.equal(readSessionName("other-session", { home }), "Other work");
	assert.equal(readFileSync(configPath, "utf8"), config);
	assert.equal(setSessionName(payload.session_id, null, { home }), "");
}));

test("custom names render alone or once before multirow output, with or without color", async () => fixture(async (home) => {
	const payload = { session_id: "name-only" };
	const name = "API \u00e9quipe \uF415";
	setSessionName(payload.session_id, name, { home });
	assert.equal(await composeStatusLine(payload, { home, ...plain }), name);
	const colored = await composeStatusLine(payload, { home, ...plain, color: true });
	assert.match(colored, /^\x1b\[/);
	assert.ok(colored.includes(name));
	assert.ok(colored.endsWith("\x1b[0m"));
	renderer(home, "pr-statusline", 'export const render = () => "Checkout one\\nCheckout two";');
	assert.equal(await composeStatusLine(payload, { home, ...plain }), `${name} · Checkout one Checkout two`);
	assert.equal(await composeStatusLine(payload, { home, ...plain, color: true }), `${colored} Checkout one\nCheckout two`);
	assert.equal(await composeStatusLine({}, { home, ...plain }), "Checkout one Checkout two");
}));

test("custom names preserve structured checkout rows and do not repeat on each row", async () => fixture(async (home) => {
	const payload = { session_id: "grouped-name" };
	setSessionName(payload.session_id, "API work", { home });
	renderer(home, "worktree-statusline", `
		export const renderEntries = () => [
			{ kind: "checkout", key: "one", text: "Checkout one" },
			{ kind: "checkout", key: "two", text: "Checkout two" },
		];
		export { composeGroups } from ${JSON.stringify(new URL("../grouping.mjs", import.meta.url).href)};
	`);
	assert.equal(await composeStatusLine(payload, { home, ...plain }), "API work · Checkout one\nCheckout two");
}));

test("session names reject invalid writes and never render terminal controls or malformed state", async () => fixture(async (home) => {
	const payload = { session_id: "safe-name" };
	for (const id of [undefined, "", ".", "..", "..\\escape", "../escape", "C:\\escape", {}, 123]) {
		assert.throws(() => setSessionName(id, "Bad path", { home }), /valid session ID/);
		assert.throws(() => setSessionName(id, null, { home }), /valid session ID/);
		assert.equal(readSessionName(id, { home }), "");
	}
	for (const name of ["", " \n\t ", "\x1b[31m\x1b[0m", 42, {}, undefined]) {
		assert.throws(() => setSessionName(payload.session_id, name, { home }), /non-empty session name/);
	}
	const unsafe = "\x1b[31mAPI\x1b[0m\nmigration\t\x1b]8;;https://example.com\x07link\x1b]8;;\x07\x00";
	assert.equal(setSessionName(payload.session_id, unsafe, { home }), "API migration link");
	assert.equal(await composeStatusLine(payload, { home, ...plain }), "API migration link");
	const statePath = join(home, "session-statusline", `${payload.session_id}.json`);
	for (const raw of ["{", "null", "42", "[]", '{"name":42}']) {
		writeFileSync(statePath, raw);
		assert.equal(await composeStatusLine(payload, { home, ...plain }), "");
	}
	writeFileSync(statePath, JSON.stringify({ name: unsafe }));
	assert.equal(await composeStatusLine(payload, { home, ...plain }), "API migration link");
}));
