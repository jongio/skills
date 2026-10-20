import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertValidPng } from "../../create-skill/scripts/png.mjs";
import { discoverThumbnailMappings } from "../../../site/scripts/sync-thumbnails.mjs";

const skillDir = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(skillDir, "..", "..");
const read = async (...parts) => (await readFile(path.join(root, ...parts), "utf8")).replace(/\r\n/g, "\n");
const json = async (...parts) => JSON.parse(await read(...parts));

test("new skill is registered across the existing distribution surfaces", async () => {
  const [readme, marketplace, plugin, catalog, dependabot, workflow, images] = await Promise.all([
    read("README.md"), json("marketplace.json"), json("plugin.json"),
    read("site", "src", "content", "skills", "backlog-groom.md"),
    read(".github", "dependabot.yml"), read(".github", "workflows", "skill-eval.yml"),
    read("site", "public", "images", "IMAGES.md"),
  ]);
  const entries = marketplace.plugins.filter(({ name }) => name === "backlog-groom");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "./skills/backlog-groom");
  assert.ok(plugin.keywords.includes("backlog-groom"));
  assert.match(readme.split(/^## Skills$/m)[1]?.split(/^## /m)[0] ?? "",
    /\[`backlog-groom`\]\(skills\/backlog-groom\/\)/);
  assert.match(catalog, /^repoPath: skills\/backlog-groom$/m);
  assert.match(catalog, /--skill backlog-groom/);
  assert.match(dependabot, /directory: \/skills\/backlog-groom\n    cooldown:\n      default-days: 7/);
  assert.equal((await read("skills", "backlog-groom", ".npmrc")).trim(), "min-release-age=7");
  assert.match(workflow, /skills\/\*\/evals\/\*\/eval\.yaml/);
  assert.match(images, /`thumb-backlog-groom\.png`/);
});

test("tracked Azure thumbnail has valid PNG bytes, catalog mapping, and exact provenance", async () => {
  const bytes = await readFile(path.join(skillDir, "thumbnail.png"));
  assertValidPng(bytes);
  const mapping = discoverThumbnailMappings({ repoRoot: root }).find(({ entryId }) => entryId === "backlog-groom");
  assert.ok(mapping);
  assert.equal(mapping.source, path.join(skillDir, "thumbnail.png"));
  assert.equal(mapping.thumb, "images/thumb-backlog-groom.png");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const section = (await read("docs", "thumbnail-prompts.md"))
    .split(`## backlog-groom (${digest.slice(0, 12)})`)[1]?.split("\n## ")[0];
  assert.ok(section?.includes(`SHA-256: ${digest}`));
  assert.match(section, /^Provider: azure-openai$/m);
  assert.match(section, /^model: gpt-image-2$/m);
  assert.match(section, /^Prompt: ".+"$/m);
});

test("development tooling matches the locked repository toolchain", async () => {
  const [pkg, lock, tool] = await Promise.all([
    json("skills", "backlog-groom", "package.json"),
    json("skills", "backlog-groom", "package-lock.json"),
    json(".github", "tools", "vally", "package.json"),
  ]);
  const name = "@microsoft/vally-cli";
  assert.match(tool.devDependencies[name], /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.devDependencies[name], tool.devDependencies[name]);
  assert.equal(lock.packages[""].devDependencies[name], pkg.devDependencies[name]);
  assert.equal(lock.packages[`node_modules/${name}`].version, pkg.devDependencies[name]);
  assert.equal(pkg.scripts.test, "node --test test/*.test.mjs");
  assert.match(pkg.scripts["eval:lint"], /--strict$/);
});
