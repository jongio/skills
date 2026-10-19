import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { composeStatusLine, discoverRenderers } from "../compose.mjs";

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
