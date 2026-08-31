import assert from "node:assert/strict";
import test from "node:test";
import {
  SKILL_NAME_PATTERN,
  VALLY_PACKAGE,
  VALLY_VERSION,
  createSkillManifest,
  renderPackageLock,
  renderSkillFiles,
  titleizeSkillName,
  validateSkillName,
} from "../scripts/render.mjs";
import { minimalVallyLock } from "./helpers.mjs";

const manifest = createSkillManifest({
  name: "release-notes-helper",
  summary: "Create accurate release notes from repository changes",
  useFor: "release notes, changelog draft",
  doNotUseFor: "publishing releases without approval",
  author: "Example Author",
});

test("skill names and manifests are strict", () => {
  assert.ok(SKILL_NAME_PATTERN.test("a1-b2"));
  assert.equal(validateSkillName("release-notes-helper"), "release-notes-helper");
  assert.equal(titleizeSkillName("release-notes-helper"), "Release Notes Helper");
  for (const value of ["A", "-bad", "bad-", "bad--name", "node_modules", "a".repeat(65)]) {
    assert.throws(() => validateSkillName(value));
  }
  assert.equal(VALLY_PACKAGE, "@microsoft/vally-cli");
  assert.equal(VALLY_VERSION, "0.14.0");
  assert.match(manifest.description, /USE FOR:/);
  assert.match(manifest.description, /DO NOT USE FOR:/);
  assert.throws(() => createSkillManifest({ name: "ok", summary: "short" }), /Summary/);
  assert.throws(
    () =>
      createSkillManifest({
        name: "ok",
        summary: "A valid summary with forbidden punctuation \u2014 here",
        useFor: "a valid use phrase",
        doNotUseFor: "another valid phrase",
      }),
    /forbidden/,
  );
  assert.throws(
    () =>
      createSkillManifest({
        name: "ok",
        summary: "A valid summary for invalid type testing",
        useFor: "a valid use phrase",
        doNotUseFor: "another valid phrase",
        type: "unknown",
      }),
    /Skill type/,
  );
  assert.throws(
    () =>
      createSkillManifest({
        name: "ok",
        summary: "A valid summary for invalid command testing",
        useFor: "a valid use phrase",
        doNotUseFor: "another valid phrase",
        commands: ["Bad Command"],
      }),
    /Commands/,
  );
});

test("package lock is adapted from the repository Vally lock", () => {
  const lock = JSON.parse(renderPackageLock(manifest.name, minimalVallyLock()));
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[""].devDependencies[VALLY_PACKAGE], VALLY_VERSION);
  const wrong = minimalVallyLock();
  wrong.packages[`node_modules/${VALLY_PACKAGE}`].version = "0.13.0";
  assert.throws(() => renderPackageLock(manifest.name, wrong), /must pin/);
  assert.throws(() => renderPackageLock(manifest.name, {}), /lockfileVersion 3/);
});

test("renderer creates the complete portable skill shape", () => {
  const files = renderSkillFiles(manifest, { lockfile: minimalVallyLock() });
  for (const path of [
    "SKILL.md",
    "README.md",
    "LICENSE",
    "package.json",
    "package-lock.json",
    ".vally.yaml",
    "test/skill.test.mjs",
    `evals/${manifest.name}/eval.yaml`,
    "thumbnail.png",
  ]) {
    assert.ok(files.has(path), path);
  }
  const skill = files.get("SKILL.md");
  const keys = [...skill.matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys.slice(0, 2), ["name", "description"]);
  assert.ok(Buffer.isBuffer(files.get("thumbnail.png")));
  assert.equal(renderSkillFiles(manifest).has("package-lock.json"), false);
  const withRepository = renderSkillFiles(manifest, { repository: "octocat/skills" });
  assert.match(withRepository.get("README.md"), /npx skills add octocat\/skills/);
  assert.doesNotMatch(withRepository.get("README.md"), /OWNER\/REPOSITORY/);
});
