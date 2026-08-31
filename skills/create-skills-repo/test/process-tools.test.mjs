import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  generateCatalog,
  generateExampleSkill,
  registerExistingSkill,
  resolveCatalogDependency,
  resolveCreateSkillDependency,
  resolveInputDirectory,
  runNodeScript,
} from "../scripts/process-tools.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "references", "example-skill.fixture.json");

async function writeScript(file, source) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source);
  await chmod(file, 0o755);
}

test("create-skill dependency preview and apply use one bound plan", async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), "create-skill-tool-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const source = path.join(work, "create-skill");
  const script = path.join(source, "scripts", "create-skill.mjs");
  await writeScript(script, `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const hash = "a".repeat(64);
if (args.includes("--help")) {
  console.log("fixture register --input --repo-root --dry-run --approve");
} else if (args.includes("--dry-run")) {
  console.log(JSON.stringify({ applied: false, hash, changes: [] }));
} else {
  const approved = args[args.indexOf("--approve") + 1];
  if (approved !== hash) process.exit(2);
  if (args[0] === "fixture") {
    const repoRoot = args[args.indexOf("--repo-root") + 1];
    const output = path.join(repoRoot, "skills", "example-skill");
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "SKILL.md"), "---\\nname: example-skill\\ndescription: Fixture.\\n---\\n");
  }
  console.log(JSON.stringify({ applied: true, hash }));
}
`);

  const dependency = await resolveCreateSkillDependency(root, source);
  assert.equal(dependency.source, source);
  registerExistingSkill(dependency, { name: "create-skill", repoRoot: work });
  generateExampleSkill(dependency, { fixturePath, repoRoot: work });

  assert.equal(
    existsSync(path.join(work, "skills", "example-skill", "SKILL.md")),
    true,
  );
});

test("catalog dependency validates capabilities and template availability", async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), "catalog-tool-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const script = path.join(work, "new-site.mjs");
  await writeScript(script, `
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("--repo --staging-dir --templates-dir --registry --registry-ref --json");
} else if (args.includes("--list")) {
  console.log("skills-catalog    Skills catalog");
} else {
  const output = args[args.indexOf("--staging-dir") + 1];
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const path = await import("node:path");
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "args.json"), JSON.stringify(args));
  console.log(JSON.stringify({
    mode: "staged",
    template: "skills-catalog",
    directory: output,
    replacements: { __REPO_SLUG__: "octocat/skills", __BASE_PATH__: "/skills/" }
  }));
}
`);

  const dependency = await resolveCatalogDependency(root, script, {
    template: "skills-catalog",
    registry: "octocat/templates",
    registryRef: "a".repeat(40),
  });
  const outputDirectory = path.join(work, "catalog-output");
  generateCatalog(dependency, {
    template: "skills-catalog",
    repository: "octocat/skills",
    outputDirectory,
    siteName: "Skills",
    description: "Skills catalog.",
    defaultBranch: "trunk",
    author: "Octo Cat",
    packageName: "octocat-skills",
    marketplaceId: "octocat-skills",
    registry: "octocat/templates",
    registryRef: "a".repeat(40),
    repoRoot: work,
  });
  const args = JSON.parse(
    await readFile(path.join(outputDirectory, "args.json"), "utf8"),
  );
  assert.deepEqual(args.slice(0, 5), [
    "skills-catalog",
    "--repo",
    "octocat/skills",
    "--staging-dir",
    outputDirectory,
  ]);
  assert.deepEqual(
    args.slice(args.indexOf("--registry"), args.indexOf("--registry") + 4),
    ["--registry", "octocat/templates", "--registry-ref", "a".repeat(40)],
  );
  assert.deepEqual(
    args.slice(args.indexOf("--default-branch"), args.indexOf("--default-branch") + 2),
    ["--default-branch", "trunk"],
  );
  await assert.rejects(
    resolveCatalogDependency(root, script, {
      template: "missing",
      templatesDirectory: work,
    }),
    /does not provide template missing/,
  );
});

test("catalog generation rejects malformed JSON output", async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), "catalog-tool-invalid-json-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const script = path.join(work, "new-site.mjs");
  await writeScript(script, `
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("--repo --staging-dir --templates-dir --registry --registry-ref --json");
} else if (args.includes("--list")) {
  console.log("skills-catalog    Skills catalog");
} else {
  console.log("not-json");
}
`);

  const dependency = await resolveCatalogDependency(root, script, {
    template: "skills-catalog",
    registryRef: "a".repeat(40),
  });
  assert.throws(
    () =>
      generateCatalog(dependency, {
        template: "skills-catalog",
        repository: "octocat/skills",
        outputDirectory: path.join(work, "catalog-output"),
        siteName: "Skills",
        description: "Skills catalog.",
        defaultBranch: "main",
        author: "Octo Cat",
        packageName: "octocat-skills",
        marketplaceId: "octocat-skills",
        registry: "octocat/templates",
        registryRef: "a".repeat(40),
        repoRoot: work,
      }),
    /valid JSON/,
  );
});

test("process runner and directory validation report precise failures", async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), "process-tool-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const success = path.join(work, "success.mjs");
  const failure = path.join(work, "failure.mjs");
  await writeScript(success, 'console.log("ok");\n');
  await writeScript(failure, 'console.error("bad"); process.exit(7);\n');

  assert.equal(runNodeScript(success, [], { cwd: work }).trim(), "ok");
  assert.throws(
    () => runNodeScript(failure, [], { cwd: work, label: "fixture" }),
    /fixture exited with 7: bad/,
  );
  assert.equal(await resolveInputDirectory(work, "fixture directory"), work);
  await assert.rejects(
    resolveInputDirectory(path.join(work, "missing"), "fixture directory"),
    /fixture directory is unavailable/,
  );

  const timeout = path.join(work, "timeout.mjs");
  await writeScript(timeout, "setInterval(() => {}, 1000);\n");
  assert.throws(
    () => runNodeScript(timeout, [], { cwd: work, label: "timeout fixture", timeout: 20 }),
    /timeout fixture failed/,
  );

  const silentFailure = path.join(work, "silent-failure.mjs");
  await writeScript(silentFailure, "process.exit(2);\n");
  assert.throws(
    () => runNodeScript(silentFailure, [], { cwd: work, label: "silent fixture" }),
    /silent fixture exited with 2\./,
  );
});

test("dependency probes fail closed for missing or incompatible tools", async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), "dependency-probe-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const regularFile = path.join(work, "file.txt");
  await writeFile(regularFile, "not a directory\n");

  await assert.rejects(
    resolveInputDirectory(regularFile, "fixture directory"),
    /not a directory/,
  );
  await assert.rejects(
    resolveCreateSkillDependency(root, path.join(work, "missing")),
    /create-skill snapshot is unavailable/,
  );

  const missingCli = path.join(work, "missing-cli");
  await mkdir(missingCli);
  await assert.rejects(
    resolveCreateSkillDependency(root, missingCli),
    /create-skill CLI is unavailable/,
  );

  for (const [name, source, expected] of [
    ["failing-help", "process.exit(3);\n", /create-skill exited with 3/],
    ["incomplete-help", 'console.log("fixture register");\n', /does not support --input/],
  ]) {
    const skill = path.join(work, name);
    await writeScript(path.join(skill, "scripts", "create-skill.mjs"), source);
    await assert.rejects(resolveCreateSkillDependency(root, skill), expected);
  }

  await assert.rejects(
    resolveCatalogDependency(root, path.join(work, "missing-catalog.mjs")),
    /create-gh-pages-site CLI is unavailable/,
  );
  const catalog = path.join(work, "catalog.mjs");
  await writeScript(catalog, 'console.log("--repo --staging-dir --templates-dir");\n');
  await assert.rejects(
    resolveCatalogDependency(root, catalog, { template: "skills-catalog" }),
    /does not support --json/,
  );
});

test("dependent tool outputs are schema-checked before mutation", async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), "tool-output-validation-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  const fixture = path.join(work, "fixture.json");

  await writeFile(fixture, "{ not json");
  assert.throws(
    () => generateExampleSkill({ script: "unused" }, { fixturePath: fixture, repoRoot: work }),
    /Invalid example skill fixture/,
  );
  await writeFile(fixture, JSON.stringify({ schemaVersion: 1, name: "wrong" }));
  assert.throws(
    () => generateExampleSkill({ script: "unused" }, { fixturePath: fixture, repoRoot: work }),
    /fixture schema/,
  );

  const validFixture = {
    schemaVersion: 1,
    name: "example-skill",
    description: "Example.",
    routing: { useFor: [], doNotUseFor: [] },
  };
  await writeFile(fixture, JSON.stringify(validFixture));

  for (const [name, output, invoke, expected] of [
    [
      "fixture-invalid-json",
      "not-json",
      (script) => generateExampleSkill(
        { script },
        { fixturePath: fixture, repoRoot: work },
      ),
      /invalid preview JSON/,
    ],
    [
      "fixture-invalid-hash",
      '{"hash":"short"}',
      (script) => generateExampleSkill(
        { script },
        { fixturePath: fixture, repoRoot: work },
      ),
      /valid plan hash/,
    ],
    [
      "registration-invalid-json",
      "not-json",
      (script) => registerExistingSkill(
        { script },
        { name: "create-skill", repoRoot: work },
      ),
      /invalid registration preview JSON/,
    ],
    [
      "registration-invalid-hash",
      '{"hash":"short"}',
      (script) => registerExistingSkill(
        { script },
        { name: "create-skill", repoRoot: work },
      ),
      /valid plan hash/,
    ],
  ]) {
    const script = path.join(work, `${name}.mjs`);
    await writeScript(script, `console.log(${JSON.stringify(output)});\n`);
    assert.throws(() => invoke(script), expected);
  }
});

test("catalog composition handoff validates every bound result field", async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), "catalog-result-validation-"));
  t.after(() => rm(work, { recursive: true, force: true }));

  const baseOptions = {
    template: "skills-catalog",
    repository: "octocat/skills",
    siteName: "Skills",
    description: "Skills catalog.",
    defaultBranch: "main",
    author: "Octo Cat",
    packageName: "octocat-skills",
    marketplaceId: "octocat-skills",
    repoRoot: work,
  };
  const cases = [
    ["mode", { mode: "applied" }],
    ["template", { template: "other" }],
    ["directory", { directory: path.join(work, "other") }],
    ["repository", { replacements: { __REPO_SLUG__: "attacker/repo", __BASE_PATH__: "/skills/" } }],
    ["base", { replacements: { __REPO_SLUG__: "octocat/skills", __BASE_PATH__: "/" } }],
  ];

  for (const [name, override] of cases) {
    await t.test(name, async (subtest) => {
      const outputDirectory = path.join(work, `output-${name}`);
      const result = {
        mode: "staged",
        template: "skills-catalog",
        directory: outputDirectory,
        replacements: {
          __REPO_SLUG__: "octocat/skills",
          __BASE_PATH__: "/skills/",
        },
        ...override,
      };
      const script = path.join(work, `${name}.mjs`);
      await writeScript(
        script,
        `console.log(${JSON.stringify(JSON.stringify(result))});\n`,
      );
      subtest.after(() => rm(outputDirectory, { recursive: true, force: true }));
      assert.throws(
        () => generateCatalog(
          { script },
          { ...baseOptions, outputDirectory },
        ),
        /invalid composition result/,
      );
    });
  }
});
