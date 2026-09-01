import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execute } from "../scripts/cli.mjs";
import {
  applyManagedTransaction,
  loadState,
} from "../scripts/managed-files.mjs";

function standaloneTestEnvironment() {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

function exampleSkillSource() {
  return `---
name: example-skill
description: >-
  A functional example skill used to verify repository distribution.
---

# Example Skill

Report whether the repository contains its managed configuration.
`;
}

function createSkillSource() {
  return `---
name: create-skill
description: >-
  Create one portable agent skill from validated noninteractive input.
---

# Create Skill

Create one skill.
`;
}

function writeExample({ repoRoot }) {
  const root = path.join(repoRoot, "skills", "example-skill");
  mkdirSync(path.join(root, "test"), { recursive: true });
  mkdirSync(path.join(root, "evals", "example-skill"), { recursive: true });
  writeFileSync(path.join(root, "SKILL.md"), exampleSkillSource());
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "example-skill",
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: { test: "node --test test/*.test.mjs" },
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, "test", "example.test.mjs"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("example", () => assert.equal(true, true));\n',
  );
  writeFileSync(
    path.join(root, "evals", "example-skill", "eval.yaml"),
    "name: example-skill\ntype: capability\n",
  );
  const catalogRoot = path.join(repoRoot, "site", "src", "content", "skills");
  if (existsSync(catalogRoot)) {
    writeFileSync(
      path.join(catalogRoot, "example-skill.md"),
      "---\ntitle: example-skill\ntagline: Example skill.\nuseWhen: Test the repository.\nrepoPath: skills/example-skill\nthumb: images/thumb-example-skill.png\ninstall: []\n---\n",
    );
  }
}

function writeCatalog(_dependency, options) {
  const root = options.outputDirectory;
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(path.join(root, "src", "pages"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: "skills-catalog",
      private: true,
      type: "module",
      scripts: { dev: "node -e \"console.log('preview')\"" },
    }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, "package-lock.json"),
    '{"name":"skills-catalog","lockfileVersion":3,"requires":true,"packages":{}}\n',
  );
  writeFileSync(
    path.join(root, "astro.config.mjs"),
    'export default { site: "https://octocat.github.io", base: "/skills/" };\n',
  );
  writeFileSync(
    path.join(root, "src", "pages", "index.astro"),
    "---\nconst skills = await getCollection(\"skills\");\n---\n<h1>Skills catalog</h1>\n",
  );
  writeFileSync(
    path.join(root, ".github", "workflows", "deploy.yml"),
    `name: Catalog
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      pages: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v4.6.0
        with:
          node-version: "24"
          cache: npm
          cache-dependency-path: package-lock.json
      - run: npm ci --ignore-scripts --no-audit --no-fund
      - run: npm run build
      - uses: actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b # v5.0.0
      - uses: actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa # v3.0.1
        with:
          path: dist
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      pages: write
      id-token: write
    steps:
      - uses: actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128 # v5.0.0
`,
  );
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "create-skills-repo-test-"));
  const snapshot = path.join(root, "snapshot");
  mkdirSync(path.join(snapshot, "scripts"), { recursive: true });
  writeFileSync(path.join(snapshot, "SKILL.md"), createSkillSource());
  writeFileSync(path.join(snapshot, "package.json"), "{\"private\":true}\n");
  writeFileSync(path.join(snapshot, "scripts", "cli.mjs"), "export {};\n");
  const dependencies = {
    resolveCreateSkill: async () => ({
      source: snapshot,
      script: path.join(snapshot, "scripts", "cli.mjs"),
    }),
    resolveCatalog: async () => ({ script: "fixture-catalog" }),
    createExample: (_dependency, options) => {
      const state = JSON.parse(
        readFileSync(path.join(options.repoRoot, ".skills-repo", "state.json"), "utf8"),
      );
      assert.equal(state.schemaVersion, 1);
      assert.ok(state.files["skills/create-skill/SKILL.md"]);
      const config = JSON.parse(
        readFileSync(path.join(options.repoRoot, "skills-repo.config.json"), "utf8"),
      );
      if (config.catalog.enabled) {
        assert.equal(
          existsSync(path.join(options.repoRoot, "site", "src", "content", "skills")),
          true,
        );
        assert.equal(
          existsSync(path.join(options.repoRoot, "site", "public", "images")),
          true,
        );
      }
      writeExample(options);
    },
    registerExisting: (_dependency, options) => {
      const state = JSON.parse(
        readFileSync(path.join(options.repoRoot, ".skills-repo", "state.json"), "utf8"),
      );
      assert.equal(state.hashVersion, 1);
      assert.ok(state.files["README.md"]);
      const catalogRoot = path.join(
        options.repoRoot,
        "site",
        "src",
        "content",
        "skills",
      );
      if (existsSync(catalogRoot)) {
        writeFileSync(
          path.join(catalogRoot, "create-skill.md"),
          "---\ntitle: create-skill\ntagline: Create skills.\nuseWhen: Author a skill.\nrepoPath: skills/create-skill\nthumb: images/thumb-create-skill.png\ninstall: []\n---\n",
        );
      }
    },
    createCatalog: writeCatalog,
  };
  return {
    root,
    snapshot,
    target: path.join(root, "generated"),
    dependencies,
  };
}

function createArgs(target, extra = []) {
  return [
    "create",
    target,
    "--owner-login",
    "octocat",
    "--owner-name",
    "Octo Cat",
    "--repo",
    "skills",
    ...extra,
  ];
}

test("create builds a complete managed repository and an inert GitHub plan", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));

  const result = await execute(createArgs(fx.target), fx.dependencies);

  assert.equal(result.status, "created");
  assert.deepEqual(result.skills, ["create-skill", "example-skill"]);
  assert.equal(result.catalog, true);
  assert.equal(result.githubPlan.approvalRequired, true);
  assert.equal(result.githubPlan.approved, false);
  assert.ok(result.githubPlan.commands.every((entry) => Array.isArray(entry.args)));
  for (const relative of [
    "skills-repo.config.json",
    ".skills-repo/state.json",
    "marketplace.json",
    "plugin.json",
    ".agents/plugins/marketplace.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/marketplace.json",
    "gemini-extension.json",
    "skills/create-skill/SKILL.md",
    "skills/example-skill/SKILL.md",
    "site/src/pages/index.astro",
    ".github/workflows/deploy-pages.yml",
  ]) {
    assert.equal(existsSync(path.join(fx.target, relative)), true, relative);
  }
  const marketplace = JSON.parse(
    await readFile(path.join(fx.target, "marketplace.json"), "utf8"),
  );
  assert.deepEqual(
    marketplace.plugins.slice(1).map((entry) => entry.name),
    ["create-skill", "example-skill"],
  );
  assert.equal(
    existsSync(
      path.join(
        fx.target,
        "site",
        "src",
        "content",
        "skills",
        "create-skill.md",
      ),
    ),
    true,
  );
  assert.equal(
    existsSync(
      path.join(
        fx.target,
        "site",
        "src",
        "content",
        "skills",
        "example-skill.md",
      ),
    ),
    true,
  );
  const pagesWorkflow = await readFile(
    path.join(fx.target, ".github", "workflows", "deploy-pages.yml"),
    "utf8",
  );
  assert.match(pagesWorkflow, /path: site\/dist/);
  assert.equal(
    (pagesWorkflow.match(/working-directory: site/g) ?? []).length,
    2,
  );
  assert.match(
    pagesWorkflow,
    /cache-dependency-path: site\/package-lock\.json/,
  );
  const validation = spawnSync(
    process.execPath,
    ["--test", "test/distribution-manifests.test.mjs"],
    {
      cwd: fx.target,
      encoding: "utf8",
      env: standaloneTestEnvironment(),
      shell: false,
    },
  );
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
});

test("a second identical create is idempotent", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target, ["--no-catalog"]), fx.dependencies);
  const before = await readFile(
    path.join(fx.target, ".skills-repo", "state.json"),
    "utf8",
  );

  const result = await execute(
    createArgs(fx.target, ["--no-catalog"]),
    fx.dependencies,
  );
  const after = await readFile(
    path.join(fx.target, ".skills-repo", "state.json"),
    "utf8",
  );

  assert.equal(result.status, "unchanged");
  assert.equal(result.written, 0);
  assert.equal(result.githubPlan, null);
  assert.equal(after, before);
});

test("custom default branch reaches generated workflows and GitHub plans", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const result = await execute(
    createArgs(fx.target, ["--no-catalog", "--default-branch", "trunk"]),
    fx.dependencies,
  );
  const workflow = await readFile(
    path.join(fx.target, ".github", "workflows", "skill-lint.yml"),
    "utf8",
  );
  assert.match(workflow, /branches: \[trunk\]/);
  assert.deepEqual(result.githubPlan.commands.at(-1).args, [
    "push",
    "--set-upstream",
    "origin",
    "trunk",
  ]);
});

test("generated Dependabot validation rejects skill-name prefix collisions", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target, ["--no-catalog"]), fx.dependencies);
  const dependabotPath = path.join(fx.target, ".github", "dependabot.yml");
  const dependabot = await readFile(dependabotPath, "utf8");
  assert.match(dependabot, /directory: \/skills\/create-skill(?:\r?\n|$)/);
  assert.equal((dependabot.match(/directory: \/skills\/create-skill/g) ?? []).length, 1);
  const mutatedDependabot = dependabot.replace(
    "directory: /skills/create-skill",
    "directory: /skills/create-skill-extra",
  );
  assert.doesNotMatch(
    mutatedDependabot,
    /^\s*directory:\s*["']?\/skills\/create-skill\/?["']?\s*(?:#.*)?$/m,
  );
  await writeFile(dependabotPath, mutatedDependabot);

  const validation = spawnSync(
    process.execPath,
    ["--test", "test/distribution-manifests.test.mjs"],
    {
      cwd: fx.target,
      encoding: "utf8",
      env: standaloneTestEnvironment(),
      shell: false,
    },
  );
  assert.notEqual(validation.status, 0, validation.stdout);
  assert.match(validation.stderr || validation.stdout, /Dependabot covers the validation tool and packaged skills/);
});

test("dry-run create on a managed target skips first-time catalog planning", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target), fx.dependencies);
  fx.dependencies.resolveCatalog = async () => {
    throw new Error("existing create must not resolve the catalog");
  };

  const result = await execute(
    ["dry-run", ...createArgs(fx.target)],
    fx.dependencies,
  );

  assert.equal(result.status, "planned");
  assert.equal(result.githubPlan, null);
});

test("upgrade on an unchanged repository writes nothing", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target, ["--no-catalog"]), fx.dependencies);

  const result = await execute(["upgrade", fx.target], fx.dependencies);

  assert.equal(result.status, "updated");
  assert.equal(result.written, 0);
  assert.deepEqual(result.changes, []);
});

test("upgrade conflict causes zero managed writes", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target, ["--no-catalog"]), fx.dependencies);
  const marketplacePath = path.join(fx.target, "marketplace.json");
  const statePath = path.join(fx.target, ".skills-repo", "state.json");
  const marketplaceBefore = await readFile(marketplacePath, "utf8");
  const stateBefore = await readFile(statePath, "utf8");
  await writeFile(path.join(fx.target, "README.md"), "\nUser content\n", {
    flag: "a",
  });

  const result = await execute(["upgrade", fx.target], fx.dependencies);

  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts, [
    { path: "README.md", reason: "modified-managed-file" },
  ]);
  assert.equal(await readFile(marketplacePath, "utf8"), marketplaceBefore);
  assert.equal(await readFile(statePath, "utf8"), stateBefore);
});

test("sync and upgrade preserve unmanaged files", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target, ["--no-catalog"]), fx.dependencies);
  const custom = path.join(fx.target, "notes.txt");
  await writeFile(custom, "keep me\n");

  await execute(["sync", fx.target], fx.dependencies);
  await execute(["upgrade", fx.target], fx.dependencies);

  assert.equal(await readFile(custom, "utf8"), "keep me\n");
});

test("catalog opt-out never resolves or creates a catalog", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  let catalogResolutionCount = 0;
  fx.dependencies.resolveCatalog = async () => {
    catalogResolutionCount += 1;
    throw new Error("catalog must not resolve");
  };

  const result = await execute(
    createArgs(fx.target, ["--no-catalog"]),
    fx.dependencies,
  );

  assert.equal(result.catalog, false);
  assert.equal(catalogResolutionCount, 0);
  assert.equal(existsSync(path.join(fx.target, "site")), false);
});

test("missing catalog capability stops before target writes", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  fx.dependencies.resolveCatalog = async () => {
    const error = new Error(
      "create-gh-pages-site is unavailable.\nInstall create-gh-pages-site with: npx skills add jongio/skills --skill create-gh-pages-site -g --agent github-copilot",
    );
    error.exitCode = 3;
    throw error;
  };

  await assert.rejects(
    execute(createArgs(fx.target), fx.dependencies),
    /npx skills add jongio\/skills --skill create-gh-pages-site/,
  );
  assert.equal(existsSync(fx.target), false);
});

test("catalog symlinks stop creation before target writes", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const external = path.join(fx.root, "external-catalog-content");
  mkdirSync(external, { recursive: true });
  writeFileSync(path.join(external, "escaped.txt"), "outside\n");
  fx.dependencies.createCatalog = (_dependency, options) => {
    mkdirSync(options.outputDirectory, { recursive: true });
    symlinkSync(external, path.join(options.outputDirectory, "linked"), "junction");
  };

  await assert.rejects(
    execute(createArgs(fx.target), fx.dependencies),
    /Catalog output contains a symlink/,
  );
  assert.equal(existsSync(fx.target), false);
});

test("dry-run create performs no filesystem writes", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  let composed = false;
  fx.dependencies.createExample = () => {
    composed = true;
  };
  fx.dependencies.createCatalog = () => {
    composed = true;
  };

  const result = await execute(
    ["dry-run", ...createArgs(fx.target)],
    fx.dependencies,
  );

  assert.equal(result.status, "planned");
  assert.equal(existsSync(fx.target), false);
  assert.equal(composed, false);
});

test("dry-run create rejects an existing unmanaged target without writes", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  mkdirSync(fx.target);
  const unmanaged = path.join(fx.target, "keep.txt");
  writeFileSync(unmanaged, "keep\n");

  await assert.rejects(
    execute(["dry-run", ...createArgs(fx.target)], fx.dependencies),
    /Cannot read skills-repo.config.json/,
  );
  assert.equal(await readFile(unmanaged, "utf8"), "keep\n");
});

test("failed managed transaction rolls every file back", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target, ["--no-catalog"]), fx.dependencies);
  const state = await loadState(fx.target);
  const readmePath = path.join(fx.target, "README.md");
  const pluginPath = path.join(fx.target, "plugin.json");
  const beforeReadme = await readFile(readmePath, "utf8");
  const beforePlugin = await readFile(pluginPath, "utf8");
  const desired = new Map([
    ["README.md", `${beforeReadme}\nchange\n`],
    ["plugin.json", `${beforePlugin}\n`],
  ]);
  const limitedState = {
    ...state,
    files: {
      "README.md": state.files["README.md"],
      "plugin.json": state.files["plugin.json"],
    },
  };

  await assert.rejects(
    applyManagedTransaction(
      fx.target,
      desired,
      limitedState,
      1,
      { failAfter: 1 },
    ),
    /Injected transaction failure/,
  );
  assert.equal(await readFile(readmePath, "utf8"), beforeReadme);
  assert.equal(await readFile(pluginPath, "utf8"), beforePlugin);
});

test("managed transaction rejects an editor change made after classification", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target, ["--no-catalog"]), fx.dependencies);
  const state = await loadState(fx.target);
  const readmePath = path.join(fx.target, "README.md");
  const beforeReadme = await readFile(readmePath, "utf8");
  const desired = new Map([["README.md", `${beforeReadme}\ngenerator change\n`]]);
  const limitedState = {
    ...state,
    files: { "README.md": state.files["README.md"] },
  };

  await assert.rejects(
    applyManagedTransaction(
      fx.target,
      desired,
      limitedState,
      1,
      {
        beforeWrite: async () => {
          await writeFile(readmePath, `${beforeReadme}\neditor change\n`);
        },
      },
    ),
    /changed during transaction/,
  );
  assert.equal(
    await readFile(readmePath, "utf8"),
    `${beforeReadme}\neditor change\n`,
  );
});

test("managed transaction preserves edits made after a file is published", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target, ["--no-catalog"]), fx.dependencies);
  const state = await loadState(fx.target);
  const readmePath = path.join(fx.target, "README.md");
  const pluginPath = path.join(fx.target, "plugin.json");
  const beforeReadme = await readFile(readmePath, "utf8");
  const beforePlugin = await readFile(pluginPath, "utf8");
  const editorContent = `${beforeReadme}\neditor change after publish\n`;
  const desired = new Map([
    ["README.md", `${beforeReadme}\ngenerator change\n`],
    ["plugin.json", `${beforePlugin}\n`],
  ]);
  const limitedState = {
    ...state,
    files: {
      "README.md": state.files["README.md"],
      "plugin.json": state.files["plugin.json"],
    },
  };

  await assert.rejects(
    applyManagedTransaction(
      fx.target,
      desired,
      limitedState,
      1,
      {
        beforeWrite: async (_relativePath, applied) => {
          if (applied === 1) await writeFile(readmePath, editorContent);
        },
      },
    ),
    /Rollback preserved external edits to: README\.md/,
  );
  assert.equal(await readFile(readmePath, "utf8"), editorContent);
  assert.equal(await readFile(pluginPath, "utf8"), beforePlugin);
});

test("managed transaction never reclaims a lock based on stale observations", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target, ["--no-catalog"]), fx.dependencies);
  const state = await loadState(fx.target);
  const readmePath = path.join(fx.target, "README.md");
  const beforeReadme = await readFile(readmePath, "utf8");
  await writeFile(`${fx.target}.create-skills-repo.lock`, "999999999\n");

  await assert.rejects(
    applyManagedTransaction(
      fx.target,
      new Map([["README.md", `${beforeReadme}\nrecovered\n`]]),
      {
        ...state,
        files: { "README.md": state.files["README.md"] },
      },
      1,
    ),
    /Remove the lock only after confirming that operation has stopped/,
  );
  assert.equal(await readFile(readmePath, "utf8"), beforeReadme);
});

test("check detects newly added skills until sync runs", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target, ["--no-catalog"]), fx.dependencies);
  const customRoot = path.join(fx.target, "skills", "custom-skill");
  mkdirSync(customRoot, { recursive: true });
  writeFileSync(
    path.join(customRoot, "SKILL.md"),
    "---\nname: custom-skill\ndescription: A custom skill using __BASE_PATH__.\n---\n",
  );

  const drift = await execute(["check", fx.target], fx.dependencies);
  const synced = await execute(["sync", fx.target], fx.dependencies);
  const clean = await execute(["check", fx.target], fx.dependencies);

  assert.equal(drift.status, "drift");
  assert.equal(synced.status, "updated");
  assert.ok(synced.written > 0);
  assert.equal(clean.status, "clean");
  assert.match(readFileSync(path.join(fx.target, "marketplace.json"), "utf8"), /custom-skill/);
});

test("check and sync reject tampered non-derived managed files", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target, ["--no-catalog"]), fx.dependencies);
  const workflow = path.join(
    fx.target,
    ".github",
    "workflows",
    "skill-lint.yml",
  );
  await writeFile(workflow, "\npermissions:\n  contents: write\n", { flag: "a" });
  const stateBefore = await readFile(
    path.join(fx.target, ".skills-repo", "state.json"),
    "utf8",
  );

  const checked = await execute(["check", fx.target], fx.dependencies);
  const synced = await execute(["sync", fx.target], fx.dependencies);

  assert.equal(checked.status, "drift");
  assert.deepEqual(checked.drift, [
    {
      path: ".github/workflows/skill-lint.yml",
      reason: "modified-managed-file",
    },
  ]);
  assert.equal(synced.status, "conflict");
  assert.equal(
    await readFile(path.join(fx.target, ".skills-repo", "state.json"), "utf8"),
    stateBefore,
  );
});

test("upgrade blocks retired managed files instead of forgetting them", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target, ["--no-catalog"]), fx.dependencies);
  const statePath = path.join(fx.target, ".skills-repo", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const retired = "retired.txt";
  await writeFile(path.join(fx.target, retired), "retired\n");
  state.files[retired] = {
    sha256: "8b86d3b824a855c1b156ba78756ca36a80a6f1b1290204878987a662e0951324",
    normalization: "lf",
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const result = await execute(["upgrade", fx.target], fx.dependencies);

  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts, [
    { path: retired, reason: "retired-managed-file" },
  ]);
});

test("state directory links are rejected before updates", async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await execute(createArgs(fx.target, ["--no-catalog"]), fx.dependencies);
  const stateDirectory = path.join(fx.target, ".skills-repo");
  const external = path.join(fx.root, "external-state");
  renameSync(stateDirectory, external);
  try {
    symlinkSync(external, stateDirectory, "junction");
  } catch (error) {
    if (error.code === "EPERM") return;
    throw error;
  }

  await assert.rejects(
    execute(["sync", fx.target], fx.dependencies),
    /Managed path parent is a symlink/,
  );
});
