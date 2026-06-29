// test/digest.test.mjs — exercises scripts/digest-repo.mjs (repo signal
// collection + classification) and scripts/make-placeholder.mjs (placeholder
// SVG + IMAGES.md manifest). No deps; Node 18+.  Run:  node test/digest.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readJsonSafe,
  firstHeadingAndPara,
  extractFences,
  extractBadges,
  detectImageRole,
  classifyRepo,
  languageHistogram,
  deriveInstall,
  digestRepo,
} from "../scripts/digest-repo.mjs";

import {
  placeholderSvg,
  imagesForPreset,
  imagesManifest,
  PRESETS,
} from "../scripts/make-placeholder.mjs";

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

console.log("create-gh-pages-site digest tests");

// ---- pure helpers ----------------------------------------------------------

test("readJsonSafe parses or returns null", () => {
  assert.deepEqual(readJsonSafe('{"a":1}'), { a: 1 });
  assert.equal(readJsonSafe("{nope"), null);
});

test("firstHeadingAndPara skips badges and grabs the first real sentence", () => {
  const md = "# My Tool\n\n[![ci](https://img.shields.io/x.svg)](https://ci)\n\nDoes a useful thing.\n";
  const { title, description } = firstHeadingAndPara(md);
  assert.equal(title, "My Tool");
  assert.equal(description, "Does a useful thing.");
});

test("extractFences returns lang + code per block", () => {
  const md = "intro\n```sh\nnpm i x\n```\nmid\n```js\nimport x from 'x'\n```\n";
  const f = extractFences(md);
  assert.equal(f.length, 2);
  assert.equal(f[0].lang, "sh");
  assert.match(f[0].code, /npm i x/);
  assert.equal(f[1].lang, "js");
});

test("extractBadges finds shields/badge images, linked or bare", () => {
  const md = "[![build](https://img.shields.io/build.svg)](https://ci)\n![logo](logo.png)\n![npm](https://img.shields.io/npm/v/x.svg)";
  const b = extractBadges(md);
  // the two shields badges qualify; logo.png does not
  assert.ok(b.some((x) => x.image.includes("build.svg")));
  assert.ok(b.some((x) => x.image.includes("npm/v")));
  assert.ok(!b.some((x) => x.image === "logo.png"));
});

test("detectImageRole maps filenames to roles", () => {
  assert.equal(detectImageRole("assets/logo.svg"), "logo");
  assert.equal(detectImageRole("hero-banner.png"), "hero");
  assert.equal(detectImageRole("og-image.png"), "og");
  assert.equal(detectImageRole("docs/invoke.png"), "screenshot");
  assert.equal(detectImageRole("favicon.ico"), "icon");
  assert.equal(detectImageRole("random.png"), "other");
});

test("classifyRepo ranks CLI from a bin signal", () => {
  const { primary, ranked } = classifyRepo({ hasBin: true, readmeHasCliUsage: true });
  assert.equal(primary, "cli");
  assert.ok(ranked[0].reasons.length >= 1);
});

test("classifyRepo ranks library from entry + import example", () => {
  const { primary } = classifyRepo({ hasLibEntry: true, readmeHasImportExample: true });
  assert.equal(primary, "library");
});

test("classifyRepo ranks app from framework dep", () => {
  const { primary } = classifyRepo({ hasFrameworkDep: true, frameworkName: "astro", hasSrcDir: true });
  assert.equal(primary, "app");
});

test("classifyRepo ranks action highest when action.yml present", () => {
  const { primary } = classifyRepo({ hasActionYml: true, hasBin: true });
  assert.equal(primary, "action");
});

test("classifyRepo ranks collection for a plugin marketplace + skills/", () => {
  const { primary } = classifyRepo({ hasPluginManifest: true, hasSkillsDir: true, subProjectCount: 2 });
  assert.equal(primary, "collection");
});

test("classifyRepo falls back to 'site' with no signals", () => {
  assert.equal(classifyRepo({}).primary, "site");
});

test("languageHistogram tallies by extension, sorted desc", () => {
  const h = languageHistogram(["a.ts", "b.ts", "c.js", "d.py", "readme.md"]);
  assert.equal(h[0].language, "TypeScript");
  assert.equal(h[0].count, 2);
  assert.ok(h.find((x) => x.language === "Python"));
});

test("deriveInstall suggests commands per ecosystem", () => {
  assert.ok(deriveInstall({ hasBin: true, pkgName: "tool", binName: "tool" }).some((c) => c.includes("npx tool")));
  assert.ok(deriveInstall({ hasCargoBin: true, crateName: "rtool" }).some((c) => c.includes("cargo install rtool")));
  assert.ok(deriveInstall({ hasPluginManifest: true }, "o/r").some((c) => c.includes("copilot plugin install o/r")));
  assert.ok(deriveInstall({ hasSkillMd: true }, "o/r").some((c) => c.includes("npx skills add o/r")));
});

// ---- digestRepo end-to-end on synthesized repos ----------------------------

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "ghp-digest-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

test("digestRepo classifies a CLI repo and derives install + usage", () => {
  const dir = makeRepo({
    "package.json": JSON.stringify({ name: "mytool", description: "A handy CLI", bin: { mytool: "cli.js" } }),
    "README.md": "# mytool\n\nA handy CLI.\n\n```sh\nnpx mytool --help\n```\n",
    "cli.js": "#!/usr/bin/env node\nconsole.log('hi')\n",
  });
  try {
    const d = digestRepo(dir);
    assert.equal(d.type.primary, "cli");
    assert.equal(d.name, "mytool");
    assert.equal(d.description, "A handy CLI");
    assert.ok(d.install.some((c) => c.includes("mytool")));
    assert.ok(d.usageExamples.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digestRepo classifies a collection repo and lists sub-projects", () => {
  const dir = makeRepo({
    "plugin.json": JSON.stringify({ name: "things", skills: "skills/" }),
    "marketplace.json": JSON.stringify({ name: "things" }),
    "README.md": "# things\n\nA collection of skills.\n",
    ".git/config": '[remote "origin"]\n\turl = https://github.com/octocat/things.git\n',
    "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: >-\n  The alpha skill does alpha work for you.\n---\n# alpha\n",
    "skills/beta/package.json": JSON.stringify({ name: "beta", description: "Beta skill." }),
  });
  try {
    const d = digestRepo(dir);
    assert.equal(d.type.primary, "collection");
    assert.equal(d.repoSlug, "octocat/things");
    assert.equal(d.subProjects.length, 2);
    const alpha = d.subProjects.find((s) => s.name === "alpha");
    assert.match(alpha.description, /alpha work/);
    assert.ok(d.install.some((c) => c.includes("copilot plugin install")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("digestRepo detects existing images with roles", () => {
  const dir = makeRepo({
    "README.md": "# x\n\ndesc\n",
    "assets/logo.svg": "<svg/>",
    "docs/screenshot-demo.png": "x",
  });
  try {
    const d = digestRepo(dir);
    assert.ok(d.images.some((i) => i.role === "logo"));
    assert.ok(d.images.some((i) => i.role === "screenshot"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- make-placeholder helpers ----------------------------------------------

test("placeholderSvg embeds the label and dimensions, escapes markup", () => {
  const svg = placeholderSvg({ label: "He<ro>", width: 800, height: 400 });
  assert.match(svg, /width="800"/);
  assert.match(svg, /height="400"/);
  assert.match(svg, /800×400/);
  assert.match(svg, /He&lt;ro&gt;/);
  assert.ok(!svg.includes("He<ro>"));
});

test("imagesForPreset always includes the common set plus type images", () => {
  const collection = imagesForPreset("collection");
  assert.ok(collection.some((i) => i.file === "logo.svg"));
  assert.ok(collection.some((i) => i.file === "og.svg"));
  assert.ok(collection.some((i) => i.file === "hero.svg"));
  // unknown preset still yields the common set
  assert.ok(imagesForPreset("nope").some((i) => i.file === "favicon.svg"));
});

test("every preset is a non-empty array of well-formed specs", () => {
  for (const [name, list] of Object.entries(PRESETS)) {
    assert.ok(Array.isArray(list) && list.length >= 1, `${name} empty`);
    for (const s of list) {
      assert.ok(s.file && s.label && s.width > 0 && s.height > 0 && s.purpose, `${name}/${s.file} malformed`);
    }
  }
});

test("imagesManifest renders a Markdown table with one row per image", () => {
  const md = imagesManifest(imagesForPreset("cli"), { dir: "public/images", repo: "o/r" });
  assert.match(md, /# Images to supply/);
  assert.match(md, /public\/images/);
  assert.match(md, /o\/r/);
  const rows = md.split("\n").filter((l) => /^\| `/.test(l));
  assert.equal(rows.length, imagesForPreset("cli").length);
});

console.log(`\n${passed} checks passed`);
