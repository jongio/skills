import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFileTree,
  computeInlineWordDiff,
  pairSplitRows,
  parseDiffPatch,
  tokenizeCodeLine,
} from "../scripts/parse-diff.mjs";
import {
  buildFileTree as buildWebFileTree,
  computeInlineWordDiff as computeWebWordDiff,
  pairSplitRows as pairWebSplitRows,
  tokenizeCodeLine as tokenizeWebCodeLine,
} from "../runtime/web/diff-view-model.mjs";

test("parseDiffPatch parses added, modified, renamed, deleted, binary, and blank +/- hunks", () => {
  const samplePatch = [
    "diff --git a/src/old-name.ts b/src/new-name.ts",
    "similarity index 82%",
    "rename from src/old-name.ts",
    "rename to src/new-name.ts",
    "index 1111111..2222222 100644",
    "--- a/src/old-name.ts",
    "+++ b/src/new-name.ts",
    "@@ -1,4 +1,5 @@ export function greet()",
    " const prefix = 'hi';",
    "-return prefix;",
    "+",
    "+return `${prefix}!`;",
    " // trailing context",
    "\\ No newline at end of file",
    "diff --git a/__proto__/added.js b/__proto__/added.js",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/__proto__/added.js",
    "@@ -0,0 +1,1 @@",
    "+export const x = 42;",
    "diff --git a/assets/logo.png b/assets/logo.png",
    "new file mode 100644",
    "Binary files /dev/null and b/assets/logo.png differ",
  ].join("\n");

  const parsed = parseDiffPatch(samplePatch);
  assert.equal(parsed.files.length, 3);
  assert.equal(parsed.fileCount, 3);
  assert.equal(parsed.additions, 3);
  assert.equal(parsed.deletions, 1);

  const renamed = parsed.files[0];
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.oldPath, "src/old-name.ts");
  assert.equal(renamed.canonicalPath, "src/new-name.ts");
  assert.equal(renamed.additions, 2);
  assert.equal(renamed.deletions, 1);
  assert.equal(renamed.hunks.length, 1);

  const splitRows = pairSplitRows(renamed.hunks[0].lines);
  const webSplitRows = pairWebSplitRows(renamed.hunks[0].lines);
  assert.equal(splitRows.length, webSplitRows.length);
  assert.equal(splitRows[0].left.oldLine, 1);
  assert.equal(splitRows[0].right.newLine, 1);
  assert.equal(splitRows[1].left.type, "del");
  assert.equal(splitRows[1].right.type, "add");
  assert.equal(splitRows[2].left, null);
  assert.equal(splitRows[2].right.newLine, 3);

  const added = parsed.files[1];
  assert.equal(added.status, "added");
  assert.equal(added.canonicalPath, "__proto__/added.js");

  const binary = parsed.files[2];
  assert.equal(binary.isBinary, true);
  assert.equal(binary.hunks.length, 0);

  const tree = buildFileTree(parsed.files);
  const webTree = buildWebFileTree(parsed.files);
  assert.equal(typeof tree, "object");
  assert.equal(Array.isArray(webTree), true);
  assert.equal(webTree.length, 3);
});

test("computeInlineWordDiff and tokenizeCodeLine stay linear and safe on pathological inputs", () => {
  const wd = computeInlineWordDiff("return oldCount + 1;", "return newCount + 1;");
  const webWd = computeWebWordDiff("return oldCount + 1;", "return newCount + 1;");
  assert.equal(wd.left[1], "old");
  assert.equal(wd.right[1], "new");
  assert.ok(webWd.left.some((p) => p.changed && p.text === "oldCount"));
  assert.ok(webWd.right.some((p) => p.changed && p.text === "newCount"));

  const tokens = tokenizeCodeLine("export const count = 42; // trailing comment", "js");
  const webTokens = tokenizeWebCodeLine("export const count = 42; // trailing comment", "js");
  assert.ok(tokens.some((t) => t.kind === "kw" && t.value === "export"));
  assert.ok(tokens.some((t) => t.kind === "num" && t.value === "42"));
  assert.ok(tokens.some((t) => t.kind === "cmt"));
  assert.ok(webTokens.some((t) => t.kind === "keyword" && t.text === "export"));
  assert.ok(webTokens.some((t) => t.kind === "number" && t.text === "42"));
  assert.ok(webTokens.some((t) => t.kind === "comment"));

  const hugeLine = "const a = 1; ".repeat(500);
  assert.deepEqual(tokenizeCodeLine(hugeLine, "js"), [{ kind: "plain", value: hugeLine }]);
  assert.deepEqual(tokenizeWebCodeLine(hugeLine, "js"), [{ kind: "plain", text: hugeLine }]);
});
