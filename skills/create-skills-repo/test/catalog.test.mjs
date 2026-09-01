import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { composeCatalog } from "../scripts/catalog.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function catalogWorkflow() {
  return `name: Catalog
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@${SHA}
        with:
          cache-dependency-path: package-lock.json
      - run: npm ci --ignore-scripts
      - run: npm run build
      - uses: actions/upload-pages-artifact@${SHA}
        with:
          path: dist
`;
}

async function writeCatalog(root, options = {}) {
  const files = new Map([
    ["package.json", "{}\n"],
    ["package-lock.json", "{}\n"],
    ["astro.config.mjs", "export default {};\n"],
    ["src/pages/index.astro", "<h1>Catalog</h1>\n"],
    [".github/workflows/deploy.yml", options.workflow ?? catalogWorkflow()],
  ]);
  for (const omitted of options.omit ?? []) files.delete(omitted);
  for (const [relativePath, content] of files) {
    const absolute = path.join(root, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

async function fixture(t, name) {
  const root = await mkdtemp(path.join(tmpdir(), `catalog-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = path.join(root, "catalog");
  const repository = path.join(root, "repository");
  await mkdir(catalog, { recursive: true });
  await mkdir(repository, { recursive: true });
  return { catalog, repository };
}

test("catalog composition patches paths, working directories, and timeouts", async (t) => {
  const fx = await fixture(t, "valid");
  await writeCatalog(fx.catalog);

  const output = await composeCatalog(fx.catalog, fx.repository);

  assert.ok(output.includes("site/package.json"));
  assert.ok(output.includes(".github/workflows/deploy-pages.yml"));
  const workflow = await readFile(
    path.join(fx.repository, ".github", "workflows", "deploy-pages.yml"),
    "utf8",
  );
  assert.match(workflow, /cache-dependency-path: site\/package-lock\.json/);
  assert.match(workflow, /path: site\/dist/);
  assert.equal((workflow.match(/working-directory: site/g) ?? []).length, 2);
  assert.match(workflow, /runs-on: ubuntu-latest\n    timeout-minutes: 15/);
});

test("catalog composition rejects malformed workflow contracts", async (t) => {
  const upload = `      - uses: actions/upload-pages-artifact@${SHA}`;
  const setup = `      - uses: actions/setup-node@${SHA}`;
  const cases = [
    ["missing-upload", (value) => value.replace(`${upload}\n        with:\n          path: dist\n`, ""), /one pinned upload-pages-artifact/],
    ["duplicate-upload", (value) => value.replace(upload, `${upload}\n${upload}`), /one pinned upload-pages-artifact/],
    ["missing-upload-with", (value) => value.replace("\n        with:\n          path: dist\n", "\n"), /configure upload-pages-artifact inputs/],
    ["duplicate-upload-path", (value) => value.replace("          path: dist", "          path: dist\n          path: dist"), /one standalone with\.path/],
    ["invalid-upload-path", (value) => value.replace("          path: dist", "          path: public"), /one standalone with\.path/],
    ["missing-setup-node", (value) => value.replace(`${setup}\n        with:\n          cache-dependency-path: package-lock.json\n`, ""), /one pinned setup-node/],
    ["duplicate-setup-node", (value) => value.replace(setup, `${setup}\n${setup}`), /one pinned setup-node/],
    ["missing-cache-path", (value) => value.replace("          cache-dependency-path: package-lock.json\n", ""), /one package-lock cache path/],
    ["duplicate-cache-path", (value) => value.replace("          cache-dependency-path: package-lock.json", "          cache-dependency-path: package-lock.json\n          cache-dependency-path: package-lock.json"), /one package-lock cache path/],
    ["missing-build", (value) => value.replace("      - run: npm run build\n", ""), /one npm install and one npm build/],
    ["prefixed-install", (value) => value.replace("npm ci --ignore-scripts", "npm ci --ignore-scripts --prefix app"), /working-directory/],
    ["nonroot-working-directory", (value) => value.replace("      - run: npm ci --ignore-scripts", "      - run: npm ci --ignore-scripts\n        working-directory: app"), /non-root npm working-directory/],
    ["missing-jobs-map", (value) => value.replace("jobs:", "tasks:"), /no jobs mapping/],
    ["missing-jobs", (value) => value.replace("  build:", "  'build':"), /no jobs/],
    ["missing-runs-on", (value) => value.replace("    runs-on: ubuntu-latest\n", ""), /has no runs-on/],
  ];

  for (const [name, mutate, expected] of cases) {
    await t.test(name, async (subtest) => {
      const fx = await fixture(subtest, name);
      await writeCatalog(fx.catalog, { workflow: mutate(catalogWorkflow()) });
      await assert.rejects(
        composeCatalog(fx.catalog, fx.repository),
        expected,
      );
    });
  }
});

test("catalog composition rejects unexpected files, omissions, and collisions", async (t) => {
  await t.test("unexpected workflow", async (subtest) => {
    const fx = await fixture(subtest, "unexpected-workflow");
    await writeCatalog(fx.catalog);
    await mkdir(path.join(fx.catalog, ".github", "workflows"), { recursive: true });
    await writeFile(
      path.join(fx.catalog, ".github", "workflows", "other.yml"),
      catalogWorkflow(),
    );
    await assert.rejects(
      composeCatalog(fx.catalog, fx.repository),
      /Unexpected catalog workflow/,
    );
  });

  await t.test("missing required output", async (subtest) => {
    const fx = await fixture(subtest, "missing-required");
    await writeCatalog(fx.catalog, { omit: ["astro.config.mjs"] });
    await assert.rejects(
      composeCatalog(fx.catalog, fx.repository),
      /did not produce site\/astro\.config\.mjs/,
    );
  });

  await t.test("destination collision", async (subtest) => {
    const fx = await fixture(subtest, "collision");
    await writeCatalog(fx.catalog);
    await mkdir(path.join(fx.repository, "site"), { recursive: true });
    await writeFile(path.join(fx.repository, "site", "package.json"), "owned\n");
    await assert.rejects(
      composeCatalog(fx.catalog, fx.repository),
      /Catalog destination already exists: site\/package\.json/,
    );
  });
});
