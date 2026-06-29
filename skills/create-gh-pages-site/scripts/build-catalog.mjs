#!/usr/bin/env node
// build-catalog.mjs — generate gallery/templates.json from the per-template
// template.json manifests. The gallery renders from this file, and a test
// asserts it stays in sync, so the gallery never drifts from the templates.
//
//   node scripts/build-catalog.mjs

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, "..", "templates");
const OUT_FILE = resolve(__dirname, "..", "gallery", "templates.json");

/** Read every template.json under templates/ and return a sorted catalog. */
export function buildCatalog(dir = TEMPLATES_DIR) {
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "template.json")))
    .map((name) => JSON.parse(readFileSync(join(dir, name, "template.json"), "utf8")))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
}

export function serializeCatalog(catalog) {
  return JSON.stringify(catalog, null, 2) + "\n";
}

function main() {
  const catalog = buildCatalog();
  writeFileSync(OUT_FILE, serializeCatalog(catalog));
  console.log(`Wrote ${catalog.length} templates to ${OUT_FILE}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
