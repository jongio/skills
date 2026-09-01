import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
const parse = async (...parts) => JSON.parse(await read(...parts));
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function skillNames() {
  return (await readdir(path.join(root, "skills"), { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(path.join(root, "skills", entry.name, "SKILL.md")),
    )
    .map((entry) => entry.name)
    .sort();
}

async function walk(current) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
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

test("all cross-agent manifests share one identity", async () => {
  const config = await parse("skills-repo.config.json");
  const manifests = await Promise.all([
    parse("plugin.json"),
    parse("marketplace.json"),
    parse(".agents", "plugins", "marketplace.json"),
    parse(".codex-plugin", "plugin.json"),
    parse(".claude-plugin", "plugin.json"),
    parse(".claude-plugin", "marketplace.json"),
    parse(".cursor-plugin", "marketplace.json"),
    parse("gemini-extension.json"),
  ]);
  for (const manifest of manifests) {
    assert.equal(manifest.name, config.package.name);
  }
  assert.equal(
    manifests[0].repository,
    `${config.owner.url}/${config.repository.name}`,
  );
});

test("Copilot marketplace registers every canonical skill", async () => {
  const marketplace = await parse("marketplace.json");
  const aggregate = marketplace.name;
  const registered = marketplace.plugins
    .filter((entry) => entry.name !== aggregate)
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(registered, await skillNames());
  for (const entry of marketplace.plugins) {
    assert.match(entry.source, /^\.\/(?:skills\/[a-z0-9-]+)?$/);
    const resolved = path.resolve(root, entry.source);
    assert.equal(path.relative(root, resolved).startsWith(".."), false);
  }
});

test("Dependabot covers the validation tool and packaged skills", async () => {
  const dependabot = await read(".github", "dependabot.yml");
  const config = await parse("skills-repo.config.json");
  assert.match(dependabot, /directory: \/.github\/tools\/vally/);
  if (config.catalog.enabled) {
    assert.match(dependabot, /directory: \/site/);
  }
  for (const name of await skillNames()) {
    if (existsSync(path.join(root, "skills", name, "package.json"))) {
      assert.match(
        dependabot,
        new RegExp(`^\\s*directory:\\s*["']?/skills/${escapeRegex(name)}/?["']?\\s*(?:#.*)?$`, "m"),
      );
    }
  }
});

test("workflows enforce the security baseline", async () => {
  const files = (await walk(root)).filter((file) =>
    file.replaceAll("\\", "/").includes("/.github/workflows/") &&
    /\.ya?ml$/.test(file)
  );
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /pull_request_target\s*:/);
    assert.match(source, /^permissions:\s*$/m);
    assertRunnerJobsHaveTimeouts(source);
    for (const match of source.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)) {
      assert.match(match[1], /^[a-f0-9]{40}$/);
    }
    if (/actions\/checkout@/.test(source)) {
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

test("repository text contains no Unicode dash punctuation", async () => {
  for (const relative of [
    "README.md",
    "plugin.json",
    "marketplace.json",
    ".github/workflows/skill-lint.yml",
    ".github/workflows/skill-eval.yml",
  ]) {
    assert.doesNotMatch(await read(...relative.split("/")), /[\u2013\u2014]/);
  }
});
