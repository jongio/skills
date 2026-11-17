import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFileTree,
  computeInlineWordDiff,
  normalizeCanonicalPath,
  pairSplitRows,
  parseDiffPatch,
  tokenizeCodeLine,
  unquoteGitHeaderPath,
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

test("parseDiffPatch parses all four combinations of quoted and unquoted diff --git paths", () => {
  const mixedQuotePatch = [
    'diff --git "a/old space.ts" "b/new space.ts"',
    "similarity index 100%",
    'rename from "old space.ts"',
    'rename to "new space.ts"',
    'diff --git "a/old space.ts" b/newplain.ts',
    "old mode 100644",
    "new mode 100755",
    'diff --git a/oldplain.ts "b/new space.ts"',
    "old mode 100644",
    "new mode 100755",
    'diff --git a/dir with space/file.ts b/dir with space/file.ts',
    "index 1111111..2222222 100644",
    "--- a/dir with space/file.ts",
    "+++ b/dir with space/file.ts",
    "@@ -1,1 +1,1 @@",
    "-export const a = 1;",
    "+export const a = 2;",
    'diff --git a/plain.ts "b/sub \\"quoted\\" b/file.ts"',
    "old mode 100644",
    "new mode 100755",
    "diff --git a/docs/plan b/spec.md b/docs/plan b/spec.md",
    "index 3333333..4444444 100644",
    "--- a/docs/plan b/spec.md",
    "+++ b/docs/plan b/spec.md",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ].join("\n");

  const parsed = parseDiffPatch(mixedQuotePatch);
  assert.equal(parsed.files.length, 6);

  assert.equal(parsed.files[0].oldPath, "old space.ts");
  assert.equal(parsed.files[0].newPath, "new space.ts");
  assert.equal(parsed.files[0].canonicalPath, "new space.ts");

  assert.equal(parsed.files[1].oldPath, "old space.ts");
  assert.equal(parsed.files[1].newPath, "newplain.ts");
  assert.equal(parsed.files[1].canonicalPath, "newplain.ts");

  assert.equal(parsed.files[2].oldPath, "oldplain.ts");
  assert.equal(parsed.files[2].newPath, "new space.ts");
  assert.equal(parsed.files[2].canonicalPath, "new space.ts");

  assert.equal(parsed.files[3].oldPath, "dir with space/file.ts");
  assert.equal(parsed.files[3].newPath, "dir with space/file.ts");
  assert.equal(parsed.files[3].canonicalPath, "dir with space/file.ts");

  assert.equal(parsed.files[4].oldPath, "plain.ts");
  assert.equal(parsed.files[4].newPath, 'sub "quoted" b/file.ts');
  assert.equal(parsed.files[4].canonicalPath, 'sub "quoted" b/file.ts');

  assert.equal(parsed.files[5].oldPath, "docs/plan b/spec.md");
  assert.equal(parsed.files[5].newPath, "docs/plan b/spec.md");
  assert.equal(parsed.files[5].canonicalPath, "docs/plan b/spec.md");
});

test("parseDiffPatch supports copy from / copy to headers with plain and quoted paths", () => {
  const copyPatch = [
    "diff --git a/src/template.ts b/src/copied-plain.ts",
    "similarity index 95%",
    "copy from src/template.ts",
    "copy to src/copied-plain.ts",
    "index 1111111..2222222 100644",
    "--- a/src/template.ts",
    "+++ b/src/copied-plain.ts",
    "@@ -1,2 +1,2 @@",
    " export const base = true;",
    "-export const variant = 'a';",
    "+export const variant = 'b';",
    'diff --git "a/src/space base.ts" "b/src/space copy.ts"',
    "similarity index 100%",
    'copy from "src/space base.ts"',
    'copy to "src/space copy.ts"',
  ].join("\n");

  const parsed = parseDiffPatch(copyPatch);
  assert.equal(parsed.files.length, 2);

  assert.equal(parsed.files[0].status, "copied");
  assert.equal(parsed.files[0].oldPath, "src/template.ts");
  assert.equal(parsed.files[0].newPath, "src/copied-plain.ts");
  assert.equal(parsed.files[0].canonicalPath, "src/copied-plain.ts");
  assert.equal(parsed.files[0].displayPath, "src/template.ts -> src/copied-plain.ts");

  assert.equal(parsed.files[1].status, "copied");
  assert.equal(parsed.files[1].oldPath, "src/space base.ts");
  assert.equal(parsed.files[1].newPath, "src/space copy.ts");
  assert.equal(parsed.files[1].canonicalPath, "src/space copy.ts");
  assert.equal(parsed.files[1].displayPath, "src/space base.ts -> src/space copy.ts");
});

test("unquoteGitHeaderPath preserves astral emoji code points and parseDiffPatch handles mnemonicPrefix and noprefix headers", () => {
  assert.equal(
    unquoteGitHeaderPath('"b/docs/launch 🚀.md"'),
    "b/docs/launch 🚀.md",
  );
  assert.equal(
    unquoteGitHeaderPath('"a/notes/party 🎉\\tcheck.md"'),
    "a/notes/party 🎉\tcheck.md",
  );

  const emojiUntrackedPatch = [
    'diff --git "a/docs/launch 🚀.md" "b/docs/launch 🚀.md"',
    "new file mode 100644",
    "--- /dev/null",
    '+++ "b/docs/launch 🚀.md"',
    "@@ -0,0 +1,1 @@",
    "+Ship it 🚀",
  ].join("\n");
  const emojiParsed = parseDiffPatch(emojiUntrackedPatch);
  assert.equal(emojiParsed.files.length, 1);
  assert.equal(emojiParsed.files[0].canonicalPath, "docs/launch 🚀.md");
  assert.equal(emojiParsed.files[0].canonicalPath.includes("\uFFFD"), false);

  const prefixVariantsPatch = [
    "diff --git i/src/worktree.ts w/src/worktree.ts",
    "index 1111111..2222222 100644",
    "--- i/src/worktree.ts",
    "+++ w/src/worktree.ts",
    "@@ -1,1 +1,1 @@",
    "-export const v = 1;",
    "+export const v = 2;",
    "diff --git c/assets/logo.png i/assets/logo.png",
    "index 1111111..3333333 100644",
    "Binary files c/assets/logo.png and i/assets/logo.png differ",
    'diff --git "o/docs/guide v1.md" "w/docs/guide v1.md"',
    "old mode 100644",
    "new mode 100755",
    "diff --git a/c/main.c b/c/main.c",
    "index 4444444..5555555 100644",
    "--- a/c/main.c",
    "+++ b/c/main.c",
    "@@ -1,1 +1,1 @@",
    "-int main() { return 0; }",
    "+int main() { return 1; }",
    "diff --git c/noprefix.c c/noprefix.c",
    "index 6666666..7777777 100644",
    "--- c/noprefix.c",
    "+++ c/noprefix.c",
    "@@ -1,1 +1,1 @@",
    "-int x = 1;",
    "+int x = 2;",
  ].join("\n");

  const parsedVariants = parseDiffPatch(prefixVariantsPatch);
  assert.deepEqual(
    parsedVariants.files.map((f) => f.canonicalPath),
    [
      "src/worktree.ts",
      "assets/logo.png",
      "docs/guide v1.md",
      "c/main.c",
      "c/noprefix.c",
    ],
  );
});

test("parseDiffPatch and normalizeCanonicalPath preserve trailing whitespace and literal backslashes in valid POSIX paths", () => {
  assert.equal(unquoteGitHeaderPath("src/trailing.ts "), "src/trailing.ts ");
  assert.equal(normalizeCanonicalPath("src/trailing.ts "), "src/trailing.ts ");
  assert.equal(
    normalizeCanonicalPath("src/literal\\name.ts"),
    "src/literal\\name.ts",
  );
  assert.equal(normalizeCanonicalPath("src\\..\\escape.ts"), "");
  assert.equal(normalizeCanonicalPath("src\\.git\\config"), "");
  assert.equal(normalizeCanonicalPath("src\\CON.txt"), "");
  assert.equal(normalizeCanonicalPath("\\\\server\\share\\file.ts"), "");

  const edgePathPatch = [
    "diff --git a/src/trailing.ts  b/src/trailing.ts ",
    "index 1111111..2222222 100644",
    "--- a/src/trailing.ts \t2026-01-01 00:00:00 +0000",
    "+++ b/src/trailing.ts \t2026-01-01 00:00:00 +0000",
    "@@ -1,1 +1,1 @@",
    "-export const t = 1;",
    "+export const t = 2;",
    "diff --git a/src/mode-trailing.sh  b/src/mode-trailing.sh ",
    "old mode 100644",
    "new mode 100755",
    "diff --git a/src/old trailing.ts  b/src/new trailing.ts ",
    "similarity index 100%",
    "rename from src/old trailing.ts ",
    "rename to src/new trailing.ts ",
    'diff --git "a/src/literal\\\\name.ts" "b/src/literal\\\\name.ts"',
    "index 3333333..4444444 100644",
    '--- "a/src/literal\\\\name.ts"',
    '+++ "b/src/literal\\\\name.ts"',
    "@@ -1,1 +1,1 @@",
    "-export const bs = 1;",
    "+export const bs = 2;",
  ].join("\n");

  const parsed = parseDiffPatch(edgePathPatch);
  assert.equal(parsed.files.length, 4);
  assert.equal(parsed.files[0].canonicalPath, "src/trailing.ts ");
  assert.equal(parsed.files[1].canonicalPath, "src/mode-trailing.sh ");
  assert.equal(parsed.files[2].canonicalPath, "src/new trailing.ts ");
  assert.equal(
    parsed.files[2].displayPath,
    "src/old trailing.ts  -> src/new trailing.ts ",
  );
  assert.equal(parsed.files[3].canonicalPath, "src/literal\\name.ts");
});


