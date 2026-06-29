// test/workflow.test.mjs — validates every template's GitHub Pages deploy
// workflow: correct permissions, concurrency, the official (non-deprecated)
// Pages actions, and per-framework build/deploy steps. No deps; Node 18+.
// Run:  node test/workflow.test.mjs

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const wf = (p) => join(ROOT, p, ".github", "workflows", "deploy.yml");

// path -> framework-specific actions that MUST appear
const TARGETS = {
  "templates/static-html": ["actions/configure-pages@", "actions/upload-pages-artifact@"],
  "templates/astro": ["withastro/action@"],
  "templates/react-vite": ["actions/setup-node@", "actions/configure-pages@", "actions/upload-pages-artifact@"],
  "templates/eleventy": ["actions/setup-node@", "actions/configure-pages@", "actions/upload-pages-artifact@"],
  "templates/jekyll": ["actions/configure-pages@", "actions/jekyll-build-pages@", "actions/upload-pages-artifact@"],
  "gallery": ["actions/configure-pages@", "actions/upload-pages-artifact@"],
};

const UNIVERSAL_REQUIRED = [
  "permissions:",
  "pages: write",
  "id-token: write",
  "concurrency:",
  "group: pages",
  "actions/deploy-pages@",
  "name: github-pages",
];

// Deprecated / discouraged patterns that must NOT appear.
const FORBIDDEN = [
  "peaceiris/actions-gh-pages",      // third-party; we use the first-party flow
  "actions/upload-artifact@",        // wrong artifact action for Pages
  "actions/deploy-pages@v3",         // pre-cutover, unsupported
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

console.log("create-gh-pages-site workflow tests");

for (const [path, requiredActions] of Object.entries(TARGETS)) {
  const file = wf(path);

  test(`${path}: deploy.yml exists`, () => {
    assert.ok(existsSync(file), `missing ${file}`);
  });

  const yaml = existsSync(file) ? readFileSync(file, "utf8") : "";

  test(`${path}: no tab characters (YAML)`, () => {
    assert.ok(!yaml.includes("\t"), "workflow contains a tab character");
  });

  test(`${path}: has on: and jobs: keys`, () => {
    assert.match(yaml, /^on:/m);
    assert.match(yaml, /^jobs:/m);
  });

  test(`${path}: declares the required Pages permissions + concurrency`, () => {
    for (const needle of UNIVERSAL_REQUIRED) {
      assert.ok(yaml.includes(needle), `expected "${needle}"`);
    }
  });

  test(`${path}: uses the framework's required actions`, () => {
    for (const needle of requiredActions) {
      assert.ok(yaml.includes(needle), `expected action "${needle}"`);
    }
  });

  test(`${path}: avoids deprecated/discouraged actions`, () => {
    for (const bad of FORBIDDEN) {
      assert.ok(!yaml.includes(bad), `should not contain "${bad}"`);
    }
  });
}

console.log(`\n${passed} checks passed`);
