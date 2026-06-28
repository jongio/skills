// test/catalog.test.mjs — keeps the gallery catalog in sync with the template
// manifests and validates each manifest's shape. No deps; Node 18+.
// Run:  node test/catalog.test.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCatalog, serializeCatalog } from "../scripts/build-catalog.mjs";
import { listTemplates } from "../scripts/new-site.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATES_DIR = join(ROOT, "templates");
const CATALOG_FILE = join(ROOT, "gallery", "templates.json");

const TIERS = new Set(["static", "ssg", "spa", "data", "native"]);
const REQUIRED_FIELDS = [
  "name", "title", "tagline", "description", "framework",
  "tier", "language", "needsBuild", "output", "basePathMechanism",
  "deploy", "tags", "order",
];

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("create-gh-pages-site catalog tests");

const folders = readdirSync(TEMPLATES_DIR).filter((n) =>
  existsSync(join(TEMPLATES_DIR, n, "template.json")),
);
const catalog = buildCatalog();

test("every template folder has a manifest", () => {
  assert.equal(catalog.length, folders.length);
  assert.ok(catalog.length >= 5, "expected at least 5 templates");
});

test("gallery/templates.json is in sync with the manifests", () => {
  assert.ok(existsSync(CATALOG_FILE), "gallery/templates.json missing — run scripts/build-catalog.mjs");
  const onDisk = readFileSync(CATALOG_FILE, "utf8");
  assert.equal(
    onDisk,
    serializeCatalog(catalog),
    "gallery/templates.json is stale — run `node scripts/build-catalog.mjs`",
  );
});

test("listTemplates() matches the manifest names", () => {
  assert.deepEqual(
    [...listTemplates()].sort(),
    catalog.map((t) => t.name).sort(),
  );
});

for (const t of catalog) {
  test(`${t.name}: manifest has all required fields`, () => {
    for (const f of REQUIRED_FIELDS) {
      assert.ok(t[f] !== undefined && t[f] !== "", `missing field "${f}"`);
    }
  });

  test(`${t.name}: manifest.name matches its folder`, () => {
    assert.ok(existsSync(join(TEMPLATES_DIR, t.name, "template.json")), `no folder for ${t.name}`);
  });

  test(`${t.name}: tier is valid and types are correct`, () => {
    assert.ok(TIERS.has(t.tier), `bad tier "${t.tier}"`);
    assert.equal(typeof t.needsBuild, "boolean");
    assert.equal(typeof t.order, "number");
    assert.ok(Array.isArray(t.tags) && t.tags.length > 0, "tags must be a non-empty array");
  });
}

console.log(`\n${passed} checks passed`);
