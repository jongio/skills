import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function walk(current) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "vally-results") continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else files.push(absolute);
  }

  return files;
}

function assertRunBlocksUseEnvironment(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!match) continue;
    let script = match[2];
    if (/^[>|][-+]?$/.test(script)) {
      const indentation = match[1].length;
      for (index += 1; index < lines.length; index += 1) {
        const lineIndentation = lines[index].match(/^\s*/)[0].length;
        if (lines[index].trim() && lineIndentation <= indentation) {
          index -= 1;
          break;
        }
        script += `\n${lines[index]}`;
      }
    }
    assert.doesNotMatch(script, /\$\{\{/);
  }
}

function assertRunnerJobsHaveTimeouts(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^    runs-on:\s*\S+/.test(lines[index])) continue;
    let start = index;
    while (start > 0 && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[start])) start -= 1;
    let end = index + 1;
    while (
      end < lines.length &&
      !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end]) &&
      !(/^\S/.test(lines[end]) && lines[end].trim())
    ) {
      end += 1;
    }
    assert.match(lines.slice(start, end).join("\n"), /^    timeout-minutes:\s*\d+/m);
  }
}

test("generated workflow templates satisfy the security baseline", async () => {
  const workflowRoot = path.join(
    root,
    "templates",
    "repository",
    ".github",
    "workflows",
  );
  for (const file of await walk(workflowRoot)) {
    const source = (await readFile(file, "utf8")).replace(/\r\n?/g, "\n");
    assert.doesNotMatch(source, /pull_request_target\s*:/);
    assert.match(source, /permissions:\n/);
    assertRunnerJobsHaveTimeouts(source);
    for (const match of source.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)) {
      assert.match(match[1], /^[a-f0-9]{40}$/);
    }
    if (source.includes("actions/checkout@")) {
      assert.match(source, /persist-credentials:\s*false/);
    }
    assertRunBlocksUseEnvironment(source);
    for (const line of source.split(/\r?\n/)) {
      if (/\bnpm (?:ci|install)\b/.test(line)) {
        assert.match(line, /--ignore-scripts/);
      }
    }
  }
});

test("skill lint reruns when any workflow changes", async () => {
  const source = await readFile(
    path.join(root, "templates", "repository", ".github", "workflows", "skill-lint.yml"),
    "utf8",
  );
  assert.equal(
    [...source.matchAll(/- "\.github\/workflows\/\*\*"/g)].length,
    2,
    "push and pull request filters must both cover all workflows",
  );
});

test("workflow scan rejects expressions in single-line run steps", () => {
  assert.throws(
    () => assertRunBlocksUseEnvironment(
      'jobs:\n  test:\n    steps:\n      - run: echo "${{ github.event.issue.title }}"\n',
    ),
  );
});

test("GitHub plan module cannot execute processes", async () => {
  const source = await readFile(path.join(root, "scripts", "github-plan.mjs"), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawn|execFile|execSync/);
  assert.doesNotMatch(source, /\bgh\b.*(?:spawn|exec)/);
});

test("skill tree contains no forbidden Unicode dash punctuation", async () => {
  for (const file of await walk(root)) {
    if (
      file.endsWith("thumbnail.png") ||
      file.endsWith("package-lock.json")
    ) {
      continue;
    }
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /[\u2013\u2014]/,
      path.relative(root, file),
    );
  }
});

test("canonical create-skill snapshot absence has one explicit failure mode", async () => {
  const source = path.join(
    root,
    "templates",
    "repository",
    "skills",
    "create-skill",
  );
  const present = await readdir(source).then(
    () => true,
    (error) => {
      assert.equal(error.code, "ENOENT");
      return false;
    },
  );
  if (!present) {
    const readme = await readFile(path.join(root, "README.md"), "utf8");
    assert.match(
      readme,
      /snapshot is populated from the\s+standalone skill by the repository coordinator/,
    );
  }
});
