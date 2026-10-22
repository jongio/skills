import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse as parsePath } from "node:path";
import test from "node:test";
import { bumpVersion, compareVersions, readSkillVersion, setSkillVersion, validateVersion } from "../scripts/versions.mjs";
import { runVersionCommand } from "../scripts/versioning.mjs";
import { buildRepositoryPlan } from "../scripts/registration.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "skill-versions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => {
    const absolute = join(root, file);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  const parse = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
  write("skills/example/SKILL.md", '---\nname: example\ndescription: Example skill.\nmetadata:\n  version: "1.2.3"\n---\nBody.\n');
  for (const file of ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "gemini-extension.json"]) {
    write(file, { name: "test-skills", version: "2.0.0" });
  }
  for (const file of ["marketplace.json", ".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"]) {
    write(file, {
      name: "test-skills",
      plugins: [
        { name: "test-skills", source: "./", version: "2.0.0" },
        ...(file === "marketplace.json" ? [{ name: "example", source: "./skills/example", version: "1.2.3" }] : []),
      ],
    });
  }
  return { root, write, parse };
}

test("SemVer accepts releases and prereleases but rejects coercion and leading zeroes", () => {
  for (const version of ["0.0.0", "1.2.3", "10.20.30-rc.1+build.002", "1.0.0-0"]) {
    assert.equal(validateVersion(version), version);
  }
  for (const version of ["1", "v1.0.0", "01.0.0", "1.0.0-01", "1.0.0 ", "", null, 1, "1.0.0\n"]) {
    assert.throws(() => validateVersion(version), /SemVer/);
  }
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3-rc.1+build", "patch"), "1.2.4");
  assert.throws(() => bumpVersion("1.2.3", "bad"), /Release level/);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.10"), 1);
  assert.equal(compareVersions("1.0.0+first", "1.0.0+second"), 0);
});

test("metadata version parsing is frontmatter-scoped and preserves other metadata and the body", () => {
  const source = "---\r\nname: sample\r\nmetadata:\r\n  author: Example\r\n  version: '2.3.4' # release\r\n---\r\nmetadata:\r\n  version: bogus\r\n";
  assert.equal(readSkillVersion(source), "2.3.4");
  const updated = setSkillVersion(source, "3.0.0");
  assert.equal(readSkillVersion(updated), "3.0.0");
  assert.match(updated, /  author: Example\r\n/);
  assert.ok(updated.endsWith("---\r\nmetadata:\r\n  version: bogus\r\n"));
  assert.throws(() => readSkillVersion("---\nname: sample\n---\n"), /missing/);
  assert.throws(() => readSkillVersion("---\nmetadata: {version: 1.0.0}\n---\n"), /block mapping/);
  assert.throws(() => readSkillVersion('---\nmetadata:\n  version: "1.0.0"\n  version: "2.0.0"\n---\n'), /Duplicate/);
  const indented = "---\nname: sample\nmetadata:\n    author: Example\n---\n";
  assert.equal(readSkillVersion(setSkillVersion(indented, "4.5.6")), "4.5.6");
  assert.match(setSkillVersion(indented, "4.5.6"), /^    version: "4.5.6"$/m);
});

test("skill release advances its listing and aggregate manifests, then stays idempotent", (t) => {
  const { root, parse } = fixture(t);
  assert.equal(runVersionCommand(root, ["check"]).status, "clean");
  assert.equal(runVersionCommand(root, ["bump", "example", "minor", "--dry-run"]).status, "planned");
  assert.equal(parse("plugin.json").version, "2.0.0");
  runVersionCommand(root, ["bump", "example", "minor"]);
  assert.equal(parse("marketplace.json").plugins[1].version, "1.3.0");
  for (const file of ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "gemini-extension.json"]) {
    assert.equal(parse(file).version, "2.0.1");
  }
  assert.equal(parse(".cursor-plugin/marketplace.json").plugins[0].version, "2.0.1");
  assert.equal(runVersionCommand(root, ["check"]).status, "clean");
  assert.equal(runVersionCommand(root, ["sync"]).status, "clean");
  runVersionCommand(root, ["bump", "package", "major"]);
  assert.equal(parse("plugin.json").version, "3.0.0");
  assert.equal(parse("marketplace.json").plugins[1].version, "1.3.0");
});

test("metadata updates preserve literal replacement tokens in frontmatter", () => {
  const source = "---\nname: sample\ndescription: Keep literal $& $$ $` $' text.\n---\nBody.\n";
  const expected = "---\nname: sample\ndescription: Keep literal $& $$ $` $' text.\nmetadata:\n  version: \"1.0.0\"\n---\nBody.\n";
  assert.equal(setSkillVersion(source, "1.0.0"), expected);
  assert.equal(setSkillVersion(expected, "2.0.0"), expected.replace('"1.0.0"', '"2.0.0"'));
});

test("legacy migration preserves published skill versions instead of resetting to 1.0.0", (t) => {
  const { root, write, parse } = fixture(t);
  write("skills/example/SKILL.md", "---\nname: example\ndescription: Example.\n---\n");
  assert.throws(() => runVersionCommand(root, ["check"]), /missing metadata.version/);
  runVersionCommand(root, ["sync"]);
  assert.equal(readSkillVersion(readFileSync(join(root, "skills/example/SKILL.md"), "utf8")), "1.2.3");
  assert.equal(parse("marketplace.json").plugins[1].version, "1.2.3");
});

test("drift is reported without writes and sync repairs only derived versions", (t) => {
  const { root, write, parse } = fixture(t);
  write(".codex-plugin/plugin.json", { name: "test-skills", version: "0.1.0", description: "Preserve me" });
  assert.equal(runVersionCommand(root, ["check"]).status, "drift");
  assert.equal(parse(".codex-plugin/plugin.json").version, "0.1.0");
  runVersionCommand(root, ["sync"]);
  assert.deepEqual(parse(".codex-plugin/plugin.json"), { name: "test-skills", version: "2.0.0", description: "Preserve me" });
});

test("invalid requests and malformed sources fail before any writes", (t) => {
  const { root, write, parse } = fixture(t);
  for (const args of [["bump", "../outside", "patch"], ["bump", "example", "bad"], ["sync", "extra"], ["wat"]]) {
    assert.throws(() => runVersionCommand(root, args));
    assert.equal(parse("plugin.json").version, "2.0.0");
  }
  const marketplace = parse("marketplace.json");
  marketplace.plugins.push(marketplace.plugins[1]);
  write("marketplace.json", marketplace);
  assert.throws(() => runVersionCommand(root, ["bump", "example", "patch"]), /Duplicate/);
  assert.equal(parse("plugin.json").version, "2.0.0");
});

test("standalone extension release also advances its aggregate", (t) => {
  const { root, write, parse } = fixture(t);
  write("extensions/plugin.json", { name: "statuslines", version: "1.2.0" });
  const marketplace = parse("marketplace.json");
  marketplace.plugins.push({ name: "statuslines", source: "./extensions", version: "1.2.0" });
  write("marketplace.json", marketplace);
  runVersionCommand(root, ["bump", "statuslines", "minor"]);
  assert.equal(parse("extensions/plugin.json").version, "1.3.0");
  assert.equal(parse("marketplace.json").plugins.at(-1).version, "1.3.0");
  assert.equal(parse("plugin.json").version, "2.0.1");
  assert.equal(runVersionCommand(root, ["check"]).status, "clean");
});

test("managed version planning rejects escaping state paths before reading them", (t) => {
  const { root, write } = fixture(t);
  write("skills-repo.config.json", {});
  const escapes = ["../outside", root];
  if (process.platform === "win32") {
    escapes.push(`${parsePath(root).root[0].toUpperCase() === "Z" ? "Y" : "Z"}:\\outside`);
  }
  for (const outside of escapes) {
    write(".skills-repo/state.json", {
      schemaVersion: 1,
      hashVersion: 1,
      files: { [outside]: { normalization: "lf", sha256: "0".repeat(64) } },
    });
    assert.throws(() => buildRepositoryPlan(root, new Map()), /Unsafe plan destination/);
  }
});

test("linked manifest directories are rejected without modifying their target", (t) => {
  const { root, parse } = fixture(t);
  const external = mkdtempSync(join(tmpdir(), "version-link-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  const source = '{"name":"test-skills","version":"7.0.0"}\n';
  writeFileSync(join(external, "plugin.json"), source);
  rmSync(join(root, ".codex-plugin"), { recursive: true });
  symlinkSync(external, join(root, ".codex-plugin"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => runVersionCommand(root, ["bump", "package", "patch"]), /symbolic link/);
  assert.equal(readFileSync(join(external, "plugin.json"), "utf8"), source);
  assert.equal(parse("plugin.json").version, "2.0.0");
});
