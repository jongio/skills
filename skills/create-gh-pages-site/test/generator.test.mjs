// test/generator.test.mjs — exercises scripts/new-site.mjs: base-path math and
// stamping every template (sentinel replacement, structure, per-framework base
// wiring). No deps; Node 18+.  Run:  node test/generator.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeBase,
  titleize,
  pkgNameOf,
  computeReplacements,
  applyReplacements,
  rewriteTree,
  registryCloneUrl,
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

test("listTemplates returns the five bundled templates in order", () => {
  const names = listTemplates();
  assert.deepEqual(names, ["static-html", "astro", "react-vite", "eleventy", "jekyll"]);
});

// ---- stamping every template ----------------------------------------------

const work = mkdtempSync(join(tmpdir(), "ghp-gen-"));
try {
  for (const template of listTemplates()) {
    const dest = join(work, template);
    const { dir, replacements, manifest } = stampTemplate({
      template,
      dir: dest,
      repo: "octocat/demo-site",
    });

    test(`${template}: stamps without leaving any sentinel`, () => {
      for (const file of walk(dir)) {
        const buf = readFileSync(file);
        // skip binaries (none expected, but be safe)
        if (buf.includes(0)) continue;
        const text = buf.toString("utf8");
        for (const s of SENTINELS) {
          assert.ok(!text.includes(s), `${relative(dir, file)} still contains ${s}`);
        }
      }
    });

    test(`${template}: does not copy template.json into the site`, () => {
      assert.ok(!existsSync(join(dir, "template.json")));
    });

    test(`${template}: ships a Pages deploy workflow`, () => {
      assert.ok(existsSync(join(dir, ".github", "workflows", "deploy.yml")));
    });

    test(`${template}: base path resolves to /demo-site/`, () => {
      assert.equal(replacements.__BASE_PATH__, "/demo-site/");
      assert.equal(manifest.name, template);
    });
  }

  // per-framework base wiring
  test("static-html: injects the repo slug into the source link", () => {
    assert.match(read(join(work, "static-html"), "index.html"), /octocat\/demo-site/);
  });
  test("astro: astro.config has site origin + /demo-site/ base", () => {
    const cfg = read(join(work, "astro"), "astro.config.mjs");
    assert.match(cfg, /site:\s*"https:\/\/octocat\.github\.io"/);
    assert.match(cfg, /base:\s*"\/demo-site\/"/);
  });
  test("react-vite: vite.config base + 404 fallback script present", () => {
    assert.match(read(join(work, "react-vite"), "vite.config.js"), /base:\s*"\/demo-site\/"/);
    assert.ok(existsSync(join(work, "react-vite", "copy-404.mjs")));
  });
  test("eleventy: workflow passes PATH_PREFIX=/demo-site/", () => {
    assert.match(read(join(work, "eleventy"), ".github/workflows/deploy.yml"), /PATH_PREFIX:\s*\/demo-site\//);
  });
  test("jekyll: _config baseurl has no trailing slash", () => {
    assert.match(read(join(work, "jekyll"), "_config.yml"), /baseurl:\s*"\/demo-site"/);
  });

  // user-site variant: base must collapse to "/" and jekyll baseurl to ""
  test("user site: jekyll baseurl is empty, base path is /", () => {
    const dest = join(work, "user-jekyll");
    const { replacements } = stampTemplate({ template: "jekyll", dir: dest, repo: "octocat/octocat.github.io" });
    assert.equal(replacements.__BASE_PATH__, "/");
    assert.match(read(dest, "_config.yml"), /baseurl:\s*""/);
  });

  // safety: refuse to overwrite a non-empty dir unless --force
  test("stamp refuses a non-empty dir without force", () => {
    const dest = join(work, "occupied");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "keep.txt"), "x");
    assert.throws(() => stampTemplate({ template: "static-html", dir: dest, repo: "octocat/demo" }), /not empty/);
  });
  test("stamp into a non-empty dir succeeds with force", () => {
    const dest = join(work, "occupied2");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "keep.txt"), "x");
    stampTemplate({ template: "static-html", dir: dest, repo: "octocat/demo", force: true });
    assert.ok(existsSync(join(dest, "index.html")));
  });

  test("unknown template throws with the list of valid names", () => {
    assert.throws(() => stampTemplate({ template: "nope", dir: join(work, "x"), repo: "o/r" }), /Unknown template/);
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed`);
