// test/generator.test.mjs — exercises scripts/new-site.mjs: base-path math, repo
// detection, and stamping from a local fixture template source (sentinel
// replacement, copy/skip logic, base-path injection). The real templates live in
// the jongio/gh-pages-templates registry; these tests use --templates-dir so they
// run offline with no network. No deps; Node 18+.  Run:  node test/generator.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeBase,
  titleize,
  pkgNameOf,
  parseRepoSlug,
  computeReplacements,
  applyReplacements,
  rewriteTree,
  registryCloneUrl,
  resolveTemplatesSource,
  listTemplates,
  stampTemplate,
} from "../scripts/new-site.mjs";

const SENTINELS = [
  "__SITE_NAME__", "__SITE_URL__", "__SITE_ORIGIN__",
  "__BASE_PATH__", "__BASE_URL__", "__REPO_SLUG__", "__PKG_NAME__",
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

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}
function read(dir, rel) {
  return readFileSync(join(dir, rel), "utf8");
}

console.log("create-gh-pages-site generator tests");

// ---- pure helpers ----------------------------------------------------------

test("normalizeBase coerces to leading+trailing slash", () => {
  assert.equal(normalizeBase("repo"), "/repo/");
  assert.equal(normalizeBase("/repo"), "/repo/");
  assert.equal(normalizeBase("/repo/"), "/repo/");
  assert.equal(normalizeBase("/"), "/");
  assert.equal(normalizeBase(""), "/");
  assert.equal(normalizeBase(undefined), "/");
});

test("titleize turns a slug into a title", () => {
  assert.equal(titleize("my-cool-site"), "My Cool Site");
  assert.equal(titleize("octocat.github.io"), "Octocat");
  assert.equal(titleize("blog_posts"), "Blog Posts");
});

test("pkgNameOf produces a valid npm name", () => {
  assert.equal(pkgNameOf("My Cool Site"), "my-cool-site");
  assert.equal(pkgNameOf("Octocat.GitHub.io"), "octocat.github.io");
  assert.equal(pkgNameOf("___weird@@@"), "weird");
});

test("parseRepoSlug extracts owner/name from common remote URL forms", () => {
  assert.equal(parseRepoSlug("https://github.com/octocat/blog.git"), "octocat/blog");
  assert.equal(parseRepoSlug("https://github.com/octocat/blog"), "octocat/blog");
  assert.equal(parseRepoSlug("git@github.com:octocat/blog.git"), "octocat/blog");
  assert.equal(parseRepoSlug("ssh://git@github.com/octocat/blog.git"), "octocat/blog");
  assert.equal(parseRepoSlug("octocat/blog"), "octocat/blog");
  // GitHub Enterprise / self-hosted host: keep the trailing owner/name.
  assert.equal(parseRepoSlug("https://github.example.com/octocat/blog.git"), "octocat/blog");
  // user-site repo name survives intact (the dotted name is the repo).
  assert.equal(parseRepoSlug("git@github.com:octocat/octocat.github.io.git"), "octocat/octocat.github.io");
});

test("parseRepoSlug returns null for unusable input", () => {
  assert.equal(parseRepoSlug(""), null);
  assert.equal(parseRepoSlug(undefined), null);
  assert.equal(parseRepoSlug("just-a-name"), null);
  assert.equal(parseRepoSlug("git@github.com:"), null);
});

test("computeReplacements: project site derives /repo/ base + URLs", () => {
  const r = computeReplacements({ repo: "octocat/my-site" });
  assert.equal(r.__BASE_PATH__, "/my-site/");
  assert.equal(r.__BASE_URL__, "/my-site");
  assert.equal(r.__SITE_ORIGIN__, "https://octocat.github.io");
  assert.equal(r.__SITE_URL__, "https://octocat.github.io/my-site/");
  assert.equal(r.__REPO_SLUG__, "octocat/my-site");
  assert.equal(r.__SITE_NAME__, "My Site");
});

test("computeReplacements: user site (USER.github.io) uses root base", () => {
  const r = computeReplacements({ repo: "octocat/octocat.github.io" });
  assert.equal(r.__BASE_PATH__, "/");
  assert.equal(r.__BASE_URL__, "");
  assert.equal(r.__SITE_URL__, "https://octocat.github.io/");
});

test("computeReplacements: --base overrides repo-derived base", () => {
  const r = computeReplacements({ repo: "octocat/my-site", base: "/custom/" });
  assert.equal(r.__BASE_PATH__, "/custom/");
  assert.equal(r.__BASE_URL__, "/custom");
});

test("computeReplacements: --base alone (no repo) works for local/user sites", () => {
  const r = computeReplacements({ base: "/", dir: "site" });
  assert.equal(r.__BASE_PATH__, "/");
});

test("computeReplacements: --site-name wins over derived title", () => {
  const r = computeReplacements({ repo: "octocat/my-site", siteName: "Hello" });
  assert.equal(r.__SITE_NAME__, "Hello");
});

test("computeReplacements: requires repo or base", () => {
  assert.throws(() => computeReplacements({}), /--repo .* or --base/);
});

test("computeReplacements: rejects malformed repo", () => {
  assert.throws(() => computeReplacements({ repo: "not-a-slug" }), /owner\/name/);
});

test("applyReplacements swaps every sentinel", () => {
  const out = applyReplacements("__SITE_NAME__ at __BASE_PATH__", {
    __SITE_NAME__: "X", __BASE_PATH__: "/y/",
  });
  assert.equal(out, "X at /y/");
});

test("applyReplacements does not re-scan an injected value (single pass)", () => {
  // A site name that literally contains another sentinel must survive intact.
  const out = applyReplacements("__SITE_NAME__", {
    __SITE_NAME__: "__BASE_PATH__", __BASE_PATH__: "/x/",
  });
  assert.equal(out, "__BASE_PATH__");
});

test("registryCloneUrl builds a github URL or passes a full URL through", () => {
  assert.equal(registryCloneUrl("octocat/templates"), "https://github.com/octocat/templates.git");
  assert.equal(registryCloneUrl("https://example.com/x.git"), "https://example.com/x.git");
});

test("rewriteTree rewrites text, preserves binary, and never follows symlinks", () => {
  const d = mkdtempSync(join(tmpdir(), "ghp-rt-"));
  const ext = mkdtempSync(join(tmpdir(), "ghp-ext-"));
  try {
    writeFileSync(join(d, "page.html"), "<title>__SITE_NAME__</title>");
    // NUL byte + the bytes of "__SITE_NAME__": must be left byte-identical.
    const bin = Buffer.from([0x00, 0x5f, 0x5f, 0x53, 0x49, 0x54, 0x45, 0x5f, 0x4e, 0x41, 0x4d, 0x45, 0x5f, 0x5f]);
    writeFileSync(join(d, "logo.bin"), bin);

    const secret = join(ext, "secret.txt");
    writeFileSync(secret, "__SITE_NAME__");
    let linked = false;
    try {
      symlinkSync(secret, join(d, "link.txt"));
      linked = true;
    } catch {
      // symlink creation can require privileges (Windows non-admin); skip that leg.
    }

    rewriteTree(d, { __SITE_NAME__: "Hello" });

    assert.equal(readFileSync(join(d, "page.html"), "utf8"), "<title>Hello</title>");
    assert.deepEqual(readFileSync(join(d, "logo.bin")), bin, "binary file was modified");
    if (linked) {
      assert.equal(readFileSync(secret, "utf8"), "__SITE_NAME__", "symlink target was rewritten through the link");
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
  }
});

// ---- a local fixture template source (offline; no network) -----------------
// The real templates live in the jongio/gh-pages-templates registry and are
// fetched at runtime. We build a tiny fixture and stamp it via --templates-dir so
// the generator's copy/skip/inject logic is covered without a clone.

function mkTemplate(root, name, manifestExtra = {}) {
  const d = join(root, name);
  mkdirSync(join(d, ".github", "workflows"), { recursive: true });
  mkdirSync(join(d, "node_modules"), { recursive: true });
  writeFileSync(join(d, "template.json"), JSON.stringify({
    name, title: titleize(name), tagline: "A fixture template", needsBuild: false, ...manifestExtra,
  }));
  writeFileSync(
    join(d, "index.html"),
    `<title>__SITE_NAME__</title><base href="__BASE_PATH__"><a href="https://github.com/__REPO_SLUG__">src</a> __SITE_URL__`,
  );
  writeFileSync(join(d, "_config.yml"), `baseurl: "__BASE_URL__"`);
  writeFileSync(join(d, ".github", "workflows", "deploy.yml"), "name: github-pages\non: push\njobs: {}\n");
  writeFileSync(join(d, "node_modules", "junk.js"), "__SITE_NAME__ should never be copied");
  return d;
}

test("listTemplates lists template folders in manifest order", () => {
  const fx = mkdtempSync(join(tmpdir(), "ghp-fx-"));
  try {
    mkTemplate(fx, "b-tmpl", { order: 2 });
    mkTemplate(fx, "a-tmpl", { order: 1 });
    assert.deepEqual(listTemplates(fx), ["a-tmpl", "b-tmpl"]);
  } finally {
    rmSync(fx, { recursive: true, force: true });
  }
});

const fixtures = mkdtempSync(join(tmpdir(), "ghp-fixtures-"));
mkTemplate(fixtures, "mini");
const work = mkdtempSync(join(tmpdir(), "ghp-gen-"));
try {
  test("resolveTemplatesSource: explicit --templates-dir wins (no network)", () => {
    assert.equal(resolveTemplatesSource({ templatesDir: fixtures }), fixtures);
  });
  test("resolveTemplatesSource: a missing --templates-dir throws (no network)", () => {
    assert.throws(() => resolveTemplatesSource({ templatesDir: join(work, "nope") }), /does not exist/);
  });

  const dest = join(work, "mini-site");
  const { dir, replacements, manifest } = stampTemplate({
    template: "mini", dir: dest, repo: "octocat/demo-site", templatesDir: fixtures,
  });

  test("stamp: leaves no sentinel behind", () => {
    for (const file of walk(dir)) {
      const buf = readFileSync(file);
      if (buf.includes(0)) continue;
      const text = buf.toString("utf8");
      for (const s of SENTINELS) assert.ok(!text.includes(s), `${relative(dir, file)} still contains ${s}`);
    }
  });

  test("stamp: injects the project base path, repo slug, and URLs", () => {
    assert.equal(replacements.__BASE_PATH__, "/demo-site/");
    assert.equal(manifest.name, "mini");
    const html = read(dir, "index.html");
    assert.match(html, /href="\/demo-site\/"/);
    assert.match(html, /github\.com\/octocat\/demo-site/);
    assert.match(html, /https:\/\/octocat\.github\.io\/demo-site\//);
  });

  test("stamp: does not copy template.json or node_modules into the site", () => {
    assert.ok(!existsSync(join(dir, "template.json")));
    assert.ok(!existsSync(join(dir, "node_modules")));
  });

  test("stamp: ships the deploy workflow", () => {
    assert.ok(existsSync(join(dir, ".github", "workflows", "deploy.yml")));
  });

  // user-site variant: base must collapse to "/" and __BASE_URL__ to ""
  test("user site: base path is / and __BASE_URL__ collapses to empty", () => {
    const ud = join(work, "user-site");
    const { replacements: r } = stampTemplate({
      template: "mini", dir: ud, repo: "octocat/octocat.github.io", templatesDir: fixtures,
    });
    assert.equal(r.__BASE_PATH__, "/");
    assert.match(read(ud, "_config.yml"), /baseurl:\s*""/);
  });

  // safety: refuse to overwrite a non-empty dir unless --force
  test("stamp refuses a non-empty dir without force", () => {
    const d = join(work, "occupied");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "keep.txt"), "x");
    assert.throws(() => stampTemplate({ template: "mini", dir: d, repo: "octocat/demo", templatesDir: fixtures }), /not empty/);
  });
  test("stamp into a non-empty dir succeeds with force", () => {
    const d = join(work, "occupied2");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "keep.txt"), "x");
    stampTemplate({ template: "mini", dir: d, repo: "octocat/demo", templatesDir: fixtures, force: true });
    assert.ok(existsSync(join(d, "index.html")));
  });

  test("unknown template throws with the list of valid names", () => {
    assert.throws(() => stampTemplate({ template: "nope", dir: join(work, "x"), repo: "o/r", templatesDir: fixtures }), /Unknown template/);
  });
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(fixtures, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed`);
