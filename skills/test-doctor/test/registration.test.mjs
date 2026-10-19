import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertValidPng } from "../../create-skill/scripts/png.mjs";
import { discoverThumbnailMappings } from "../../../site/scripts/sync-thumbnails.mjs";

const skillDir = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(skillDir, "..", "..");
const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
const json = async (...parts) => JSON.parse(await read(...parts));

test("test-doctor is registered in every applicable distribution surface", async () => {
  const [readme, marketplace, plugin, catalog, dependabot, workflow, images] = await Promise.all([
    read("README.md"),
    json("marketplace.json"),
    json("plugin.json"),
    read("site", "src", "content", "skills", "test-doctor.md"),
    read(".github", "dependabot.yml"),
    read(".github", "workflows", "skill-eval.yml"),
    read("site", "public", "images", "IMAGES.md"),
  ]);
  assert.match(readme, /\|\s*\[`test-doctor`\]\(skills\/test-doctor\/\)/);
  const entries = marketplace.plugins.filter(({ name }) => name === "test-doctor");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "./skills/test-doctor");
  assert.ok(plugin.keywords.includes("test-doctor"));
  assert.match(catalog, /^repoPath: skills\/test-doctor$/m);
  assert.match(catalog, /--skill test-doctor/);
  assert.match(dependabot, /directory: ["']?\/skills\/test-doctor["']?\s*$/m);
  assert.match(dependabot.replace(/\r\n/g, "\n"),
    /directory: \/skills\/test-doctor\n    cooldown:\n      default-days: 7\n/);
  assert.equal((await read("skills", "test-doctor", ".npmrc")).trim(), "min-release-age=7");
  assert.match(workflow, /skills\/\*\/evals\/\*\/eval\.yaml/);
  assert.match(images, /`thumb-test-doctor\.png`/);
});

test("thumbnail has a valid source, catalog mapping, and documented provenance", async () => {
  const bytes = await readFile(path.join(skillDir, "thumbnail.png"));
  assertValidPng(bytes);
  const mapping = discoverThumbnailMappings({ repoRoot: root })
    .find(({ entryId }) => entryId === "test-doctor");
  assert.ok(mapping);
  assert.equal(mapping.source, path.join(skillDir, "thumbnail.png"));
  assert.equal(mapping.thumb, "images/thumb-test-doctor.png");
  const provenance = await read("docs", "thumbnail-prompts.md");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const section = provenance.split(`## test-doctor (${digest.slice(0, 12)})`)[1]?.split("\n## ")[0];
  assert.ok(section, "current thumbnail must have its own provenance record");
  assert.ok(section.includes(`SHA-256: ${digest}`));
});

test("development tooling uses the repository's exact locked Vally version", async () => {
  const [pkg, lock, tool] = await Promise.all([
    json("skills", "test-doctor", "package.json"),
    json("skills", "test-doctor", "package-lock.json"),
    json(".github", "tools", "vally", "package.json"),
  ]);
  const name = "@microsoft/vally-cli";
  const version = tool.devDependencies[name];
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.devDependencies[name], version);
  assert.equal(lock.packages[""].devDependencies[name], version);
  assert.equal(lock.packages[`node_modules/${name}`].version, version);
  assert.equal(pkg.scripts.test, "node --test test/*.test.mjs");
  assert.match(pkg.scripts["eval:lint"], /--strict$/);
});
