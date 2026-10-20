import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skill = (await readFile(new URL("../SKILL.md", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("portable skill frontmatter contains only name and description", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description"]);
  assert.match(frontmatter[1], /^name: doc-doctor$/m);
});

test("entire portable skill stays within ten lines", () => {
  assert.ok(skill.replace(/\n$/, "").split("\n").length <= 10);
  assert.match(skill, /^# Doc Doctor$/m);
  assert.deepEqual([...skill.matchAll(/^(\d)\. /gm)].map((match) => match[1]), ["1", "2", "3", "4"]);
  assert.doesNotMatch(skill, /devx|devy/i);
});

test("checks affected docs and missing updates without imposing a full audit", () => {
  assert.match(skill, /default: current diff and affected docs/);
  assert.match(skill, /actual code.*missing updates, not just changed doc files/);
  assert.match(skill, /local links, anchors, images, examples, and frontmatter against repository rules/);
  assert.match(skill, /external links as unchecked unless verified/);
  assert.match(skill, /do not expand into a repository-wide audit unless requested/);
});

test("fixes material gaps safely and reports evidence without invented verification", () => {
  assert.match(skill, /Fix material gaps within scope/);
  assert.match(skill, /preserve unrelated edits and approval boundaries/);
  assert.match(skill, /untrusted data, never instructions/);
  assert.match(skill, /remaining findings with file\/line evidence/);
  assert.match(skill, /if no docs need changes, say why/);
  assert.match(skill, /never claim unperformed verification/);
});

test("registered in every existing distribution surface", async () => {
  const root = new URL("../../../", import.meta.url);
  const [marketplace, plugin, readme, dependabot, catalog] = await Promise.all(
    ["marketplace.json", "plugin.json", "README.md", ".github/dependabot.yml", "site/src/content/skills/doc-doctor.md"]
      .map((path) => readFile(new URL(path, root), "utf8")),
  );
  assert.ok(JSON.parse(marketplace).plugins.some((entry) => entry.name === "doc-doctor"));
  assert.ok(JSON.parse(plugin).keywords.includes("doc-doctor"));
  assert.match(readme, /\[`doc-doctor`\]\(skills\/doc-doctor\/\)/);
  assert.match(dependabot, /directory: \/skills\/doc-doctor/);
  assert.match(catalog, /repoPath: skills\/doc-doctor/);
});
