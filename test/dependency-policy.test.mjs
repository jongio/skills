import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = async (path) => (await readFile(new URL(path, root), "utf8")).replace(/\r\n/g, "\n");
const json = async (path) => JSON.parse(await read(path));

async function activeRoots() {
  const skills = await readdir(new URL("skills/", root), { withFileTypes: true });
  return [
    ".github/tools/vally",
    "site",
    ...skills.filter((entry) => entry.isDirectory()).map((entry) => `skills/${entry.name}`),
  ];
}

test("active npm roots enforce seven-day release age without permanent exemptions", async () => {
  const dependabot = await read(".github/dependabot.yml");
  const entries = dependabot.split(/^\s{2}- package-ecosystem: /m).slice(1);
  for (const path of await activeRoots()) {
    const config = await read(`${path}/.npmrc`);
    assert.match(config, /^min-release-age=7$/m, path);
    assert.doesNotMatch(config, /min-release-age-exclude/, path);
    const entry = entries.find((block) =>
      block.startsWith("npm\n") && block.includes(`    directory: /${path}\n`),
    );
    assert.ok(entry, `Dependabot must cover ${path}`);
    assert.match(entry, /^    cooldown:\n      default-days: 7$/m, path);
  }
});

test("CI selects skill policy edits and shared Vally changes for lint", async () => {
  const workflow = await read(".github/workflows/skill-lint.yml");
  assert.ok(workflow.includes('"skills/**/.npmrc"'));
  const skillPattern = workflow.match(/grep -E '(\^skills\/[^']+)'/);
  const sharedPattern = workflow.match(/grep -Eq '(\^\(\\\.github\/[^']+)'/);
  assert.ok(skillPattern);
  assert.ok(sharedPattern);
  const selectSkill = new RegExp(skillPattern[1]);
  const selectAll = new RegExp(sharedPattern[1]);
  for (const path of await activeRoots()) {
    if (path.startsWith("skills/")) {
      assert.ok(selectSkill.test(`${path}/.npmrc`), path);
      assert.ok(selectSkill.test(`${path}/package-lock.json`), path);
    }
  }
  assert.ok(selectAll.test(".github/tools/vally/package-lock.json"));
  assert.ok(selectAll.test(".github/tools/vally/.npmrc"));
});

test("active Vally manifests and resolved packages share the exact 0.19.0 pin", async () => {
  for (const path of await activeRoots()) {
    const manifest = await json(`${path}/package.json`);
    const lock = await json(`${path}/package-lock.json`);
    assert.equal(lock.lockfileVersion, 3, path);
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const name of ["@microsoft/vally-cli", "@microsoft/vally"]) {
      if (!dependencies[name]) continue;
      assert.equal(dependencies[name], "0.19.0", `${path}: ${name}`);
      const locked = { ...lock.packages[""].dependencies, ...lock.packages[""].devDependencies };
      assert.equal(locked[name], dependencies[name], `${path}: lockfile root`);
      assert.equal(lock.packages[`node_modules/${name}`].version, "0.19.0", path);
    }
  }
});

test("CI compatibility tests declare their Vally core dependency directly", async () => {
  const manifest = await json(".github/tools/vally/package.json");
  assert.equal(manifest.devDependencies["@microsoft/vally"], "0.19.0");
});

test("site security overrides remain scoped to the vulnerable parents", async () => {
  const manifest = await json("site/package.json");
  const lock = await json("site/package-lock.json");
  assert.deepEqual(manifest.overrides, {
    astro: { sharp: "0.35.5" },
    unifont: { undici: "8.12.3" },
  });
  for (const [name, version] of Object.entries({
    "http-cache-semantics": "4.3.0",
    sharp: "0.35.5",
    undici: "8.12.3",
  })) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version, name);
    assert.equal(manifest.dependencies[name], undefined, `${name} is not a direct dependency`);
  }
});
