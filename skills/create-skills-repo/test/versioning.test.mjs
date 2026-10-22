import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execute } from "../scripts/cli.mjs";
import { createConfig, validateConfig } from "../scripts/config.mjs";
import { runVersionCommand } from "../../create-skill/scripts/versioning.mjs";
import { setSkillVersion } from "../../create-skill/scripts/versions.mjs";

test("configuration accepts SemVer releases and rejects invalid versions", () => {
  const config = createConfig({ ownerLogin: "octocat", repositoryName: "skills", packageVersion: "2.3.4-rc.1+build" });
  assert.equal(config.package.version, "2.3.4-rc.1+build");
  for (const version of ["1", "01.2.3", 1, "1.0.0-01"]) {
    assert.throws(() => validateConfig({ ...config, package: { ...config.package, version } }), /SemVer/);
  }
});

test("generated releases remain clean through sync and upgrade without resetting authored versions", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "generated-versions-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "skills");
  const result = await execute(["create", root, "--owner-login", "octocat", "--no-catalog", "--package-version", "3.2.1"]);
  assert.equal(result.status, "created");
  assert.equal(runVersionCommand(root, ["check"]).status, "clean");
  runVersionCommand(root, ["bump", "example-skill", "minor"]);
  const parse = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
  assert.equal((await parse("skills-repo.config.json")).package.version, "3.2.2");
  assert.equal((await execute(["check", root])).status, "clean");
  assert.equal((await execute(["sync", root])).status, "updated");
  assert.equal((await execute(["upgrade", root])).status, "updated");
  assert.equal((await parse("marketplace.json")).plugins.find((entry) => entry.name === "example-skill").version, "1.1.0");
  assert.equal((await parse("plugin.json")).version, "3.2.2");
  assert.equal(runVersionCommand(root, ["check"]).status, "clean");
  assert.equal((await execute(["check", root])).status, "clean");
  const newerSource = path.join(parent, "newer-create-skill");
  await cp(path.join(root, "skills", "create-skill"), newerSource, { recursive: true });
  const newSkillFile = path.join(newerSource, "SKILL.md");
  await writeFile(newSkillFile, setSkillVersion(await readFile(newSkillFile, "utf8"), "9.0.0"));
  assert.equal((await execute(["upgrade", root, "--create-skill-source", newerSource])).status, "updated");
  assert.equal((await parse("marketplace.json")).plugins.find((entry) => entry.name === "create-skill").version, "9.0.0");
  assert.equal((await parse("plugin.json")).version, "3.2.3");
  assert.equal(runVersionCommand(root, ["check"]).status, "clean");
  const repeatedUpgrade = await execute(["upgrade", root, "--create-skill-source", newerSource]);
  assert.equal(repeatedUpgrade.written, 0);
  const lock = `${root}.create-skills-repo.lock`;
  await writeFile(lock, "another-operation\n");
  try {
    assert.throws(() => runVersionCommand(root, ["bump", "package", "minor"]), /Another create-skills-repo operation/);
    assert.equal((await parse("plugin.json")).version, "3.2.3");
  } finally {
    await rm(lock);
  }
  runVersionCommand(root, ["bump", "create-skill", "major"]);
  await assert.rejects(execute(["upgrade", root]), /would downgrade/);
  assert.equal((await execute(["check", root])).status, "clean");
  const toolingPath = path.join(root, ".github", "tools", "vally", "package.json");
  const toolingSource = await readFile(toolingPath, "utf8");
  const tooling = JSON.parse(toolingSource);
  tooling.devDependencies["@microsoft/vally-cli"] = "99.0.0";
  const stateSource = await readFile(path.join(root, ".skills-repo", "state.json"), "utf8");
  await writeFile(toolingPath, JSON.stringify(tooling, null, 2) + "\n");
  assert.equal(runVersionCommand(root, ["check"]).status, "clean", "dependency-only edits do not change release parity");
  assert.equal(await readFile(path.join(root, ".skills-repo", "state.json"), "utf8"), stateSource);
  assert.throws(() => runVersionCommand(root, ["sync"]), /Managed file conflict/);
  assert.throws(() => runVersionCommand(root, ["bump", "package", "minor"]), /Managed file conflict/);
  await writeFile(toolingPath, toolingSource);
  const manifest = await readFile(path.join(root, "plugin.json"), "utf8");
  await writeFile(path.join(root, "plugin.json"), manifest.replace("3.2.4", "9.0.0"));
  assert.equal(runVersionCommand(root, ["check"]).status, "drift");
  assert.throws(() => runVersionCommand(root, ["bump", "package", "minor"]), /Managed file conflict/);
  assert.equal((await parse("skills-repo.config.json")).package.version, "3.2.4");
});
