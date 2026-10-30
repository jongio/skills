import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import test from "node:test";
import { checkOne } from "../../create-canvas-app/scripts/check-kit-freshness.mjs";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("all shipped loaders resolve to the same runtime without per-session asset copying", async () => {
  for (const relative of [
    "com.github.copilot/extensions/session-progress/extension.mjs",
    "skills/create-session-board-canvas/com.github.copilot/extensions/session-progress/extension.mjs",
  ]) {
    const url = new URL(relative, root);
    const content = await readFile(url, "utf8");
    const specifier = content.match(/import "([^"]+)";/)[1];
    assert.equal(fileURLToPath(new URL(specifier, url)), fileURLToPath(new URL("skills/create-session-board-canvas/runtime/extension.mjs", root)));
  }
  const kit = resolve(dirname(fileURLToPath(import.meta.url)), "../runtime/canvas-kit");
  assert.deepEqual((await checkOne(kit)).problems, []);
});

test("go delegates reports and pr preserves approval and verified-merge semantics", async () => {
  const go = await read("skills/go/references/session-progress.md");
  const pr = await read("skills/pr/references/session-progress.md");
  assert.match(go, /every delegate|Every delegate/i);
  assert.match(go, /verify[\s\S]*canonical tasks/i);
  assert.match(go, /restricted delegates keep their tool permissions/i);
  assert.match(pr, /verified[\s\S]*intended head/i);
  assert.match(pr, /Unavailable reporting tools use the existing text status view/);
});

test("the final skill slug is maintained by Dependabot and exposed in the catalog", async () => {
  const dependabot = await read(".github/dependabot.yml");
  const catalog = await read("site/src/content/skills/create-session-board-canvas.md");
  assert.match(dependabot, /directory: \/skills\/create-session-board-canvas\b/);
  assert.match(catalog, /repoPath: skills\/create-session-board-canvas\b/);
  assert.match(catalog, /--skill create-session-board-canvas\b/);
});
