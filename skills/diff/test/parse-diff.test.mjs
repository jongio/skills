import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFileTree,
  computeInlineWordDiff,
  pairSplitRows,
  parseDiffPatch,
  tokenizeCodeLine,
} from "../runtime/parse-diff.mjs";
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
  assert.equal(parsed.totalFiles, 3);
  assert.equal(parsed.additions, 3);
  assert.equal(parsed.deletions, 1);

  const truncatedParsed = parseDiffPatch(samplePatch, { maxFiles: 2 });
  assert.equal(truncatedParsed.files.length, 2);
  assert.equal(truncatedParsed.fileCount, 2);
  assert.equal(truncatedParsed.totalFiles, 3);
  assert.equal(truncatedParsed.truncatedFiles, true);

  const emptyParsed = parseDiffPatch("");
  assert.equal(emptyParsed.fileCount, 0);
  assert.equal(emptyParsed.totalFiles, 0);

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
  assert.equal(Array.isArray(tree), true);
  assert.equal(Array.isArray(webTree), true);
  assert.equal(webTree.length, 3);
});

test("computeInlineWordDiff and tokenizeCodeLine stay linear and safe on pathological inputs", () => {
  const wd = computeInlineWordDiff("return oldCount + 1;", "return newCount + 1;");
  const webWd = computeWebWordDiff("return oldCount + 1;", "return newCount + 1;");
  assert.ok(wd.left.some((p) => p.changed && p.text === "oldCount"));
  assert.ok(wd.right.some((p) => p.changed && p.text === "newCount"));
  assert.deepEqual(wd, webWd);

  const tokens = tokenizeCodeLine("export const count = 42; // trailing comment", "js");
  const webTokens = tokenizeWebCodeLine("export const count = 42; // trailing comment", "js");
  assert.ok(tokens.some((t) => t.kind === "keyword" && t.text === "export"));
  assert.ok(tokens.some((t) => t.kind === "number" && t.text === "42"));
  assert.ok(tokens.some((t) => t.kind === "comment"));
  assert.deepEqual(tokens, webTokens);

  const hugeLine = "const a = 1; ".repeat(500);
  assert.deepEqual(tokenizeCodeLine(hugeLine, "js"), [{ kind: "plain", text: hugeLine }]);
  assert.deepEqual(tokenizeWebCodeLine(hugeLine, "js"), [{ kind: "plain", text: hugeLine }]);

  // JSON property keys vs string values and JSON-only keywords
  const jsonTokens = tokenizeWebCodeLine('  "function": "def", "enabled": true', "json");
  assert.ok(jsonTokens.some((t) => t.kind === "property" && t.text === '"function"'));
  assert.ok(jsonTokens.some((t) => t.kind === "string" && t.text === '"def"'));
  assert.ok(jsonTokens.some((t) => t.kind === "property" && t.text === '"enabled"'));
  assert.ok(jsonTokens.some((t) => t.kind === "keyword" && t.text === "true"));

  // '#' comments in py/sh/yaml require index 0 or preceding space/tab
  const pyAnchor = tokenizeWebCodeLine('url = slug#not-a-comment', "py");
  assert.equal(pyAnchor.some((t) => t.kind === "comment"), false);
  const pyComment = tokenizeWebCodeLine("value = 1 # real trailing comment", "py");
  assert.ok(pyComment.some((t) => t.kind === "comment" && t.text === "# real trailing comment"));
  const shStartComment = tokenizeWebCodeLine("# full line comment", "sh");
  assert.deepEqual(shStartComment, [{ kind: "comment", text: "# full line comment" }]);

  // Language-family keyword isolation
  const jsDef = tokenizeWebCodeLine("const def = fn + impl;", "js");
  assert.ok(jsDef.some((t) => t.kind === "keyword" && t.text === "const"));
  assert.equal(jsDef.some((t) => t.kind === "keyword" && (t.text === "def" || t.text === "fn" || t.text === "impl")), false);

  const rustLine = tokenizeWebCodeLine("pub fn parse() -> bool", "rust");
  assert.ok(rustLine.some((t) => t.kind === "keyword" && t.text === "pub"));
  assert.ok(rustLine.some((t) => t.kind === "keyword" && t.text === "fn"));

  const sqlLine = tokenizeWebCodeLine("select id from users where id = 1", "sql");
  assert.ok(sqlLine.some((t) => t.kind === "keyword" && t.text === "select"));
  assert.ok(sqlLine.some((t) => t.kind === "keyword" && t.text === "where"));
});
