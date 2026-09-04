// test/generator.test.mjs — exercises scripts/new-site.mjs: base-path math, repo
// detection, and stamping from a local fixture template source (sentinel
// replacement, copy/skip logic, base-path injection). The real templates live in
// the jongio/gh-pages-templates registry; these tests use --templates-dir so they
// run offline with no network. No deps; Node 18+.  Run:  node test/generator.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname, parse } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  normalizeBase,
  titleize,
  pkgNameOf,
  parseRepoSlug,
  computeReplacements,
  applyReplacements,
  rewriteTree,
  assertFullCommitSha,
  resolveInside,
  assertNoSymlinks,
  assertSafeDestination,
  normalizePinnedLegacyWorkflows,
  DEFAULT_REGISTRY_REF,
  validateWorkflowFile,
  validateStagedTree,
  registryCloneUrl,
  verifyRegistryCommit,
  assertRegistryTreeHasNoSymlinks,
  resolveTemplatesSource,
  listTemplates,
  stampTemplate,
} from "../scripts/new-site.mjs";

const SENTINELS = [
  "__SITE_NAME__", "__SITE_DESCRIPTION__", "__SITE_URL__", "__SITE_ORIGIN__",
  "__BASE_PATH__", "__BASE_URL__", "__REPO_SLUG__", "__REPO_OWNER__",
  "__REPO_NAME__", "__AUTHOR_NAME__", "__PKG_NAME__", "__MARKETPLACE_ID__",
  "__DEFAULT_BRANCH__",
];
const ACTION_SHA = "0123456789abcdef0123456789abcdef01234567";
const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function safeWorkflow(overrides = {}) {
  const trigger = overrides.trigger || "push:\n    branches: [main]\n  workflow_dispatch:";
  const permissions = overrides.permissions || "contents: read";
  const jobPermissions = overrides.jobPermissions ?? "    permissions:\n      contents: read\n      pages: write\n      id-token: write\n";
  const checkoutRef = overrides.checkoutRef || ACTION_SHA;
  const credentials = overrides.credentials ?? "          persist-credentials: false\n";
  const extra = overrides.extra || "";
  const timeout = overrides.timeout ?? "    timeout-minutes: 10\n";
  return `name: github-pages
on:
  ${trigger}
permissions:
  ${permissions}
jobs:
  deploy:
${jobPermissions}
    runs-on: ubuntu-latest
${timeout}    steps:
      - uses: actions/checkout@${checkoutRef}
        with:
${credentials}${extra}`;
}

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

test("computeReplacements: skills-catalog metadata uses explicit values", () => {
  const r = computeReplacements({
    repo: "octocat/skill-hub",
    siteName: "Skill Hub",
    description: "Curated skills.",
    author: "Octo Cat",
    packageName: "@octocat/skill-hub",
    marketplaceId: "octocat-marketplace",
    defaultBranch: "trunk",
  });
  assert.equal(r.__SITE_DESCRIPTION__, "Curated skills.");
  assert.equal(r.__AUTHOR_NAME__, "Octo Cat");
  assert.equal(r.__REPO_OWNER__, "octocat");
  assert.equal(r.__REPO_NAME__, "skill-hub");
  assert.equal(r.__PKG_NAME__, "octocat-skill-hub");
  assert.equal(r.__MARKETPLACE_ID__, "octocat-marketplace");
  assert.equal(r.__DEFAULT_BRANCH__, "trunk");
});

test("computeReplacements: rejects unsafe default branches", () => {
  assert.throws(
    () => computeReplacements({ repo: "octocat/skill-hub", defaultBranch: "feature/test" }),
    /--default-branch/,
  );
});

test("computeReplacements: requires repo or base", () => {
  assert.throws(() => computeReplacements({}), /--repo .* or --base/);
});

test("computeReplacements: rejects malformed repo", () => {
  assert.throws(() => computeReplacements({ repo: "not-a-slug" }), /owner\/name/);
  assert.throws(() => computeReplacements({ repo: "octocat/<script>" }), /valid GitHub repository component/);
});

test("computeReplacements: rejects context-breaking metadata and base paths", () => {
  assert.throws(
    () => computeReplacements({ repo: "octocat/demo", siteName: '"><script>alert(1)</script>' }),
    /unsafe for template substitution/,
  );
  assert.throws(
    () => computeReplacements({ repo: "octocat/demo", description: "unsafe\nvalue" }),
    /unsafe for template substitution/,
  );
  assert.throws(
    () => computeReplacements({ base: "/../escape/" }),
    /traversal segments/,
  );
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

test("registryCloneUrl accepts only canonical GitHub repository slugs", () => {
  assert.equal(registryCloneUrl("octocat/templates"), "https://github.com/octocat/templates.git");
  for (const registry of [
    "https://example.com/x.git",
    "http://127.0.0.1/x.git",
    "ssh://example.com/x.git",
    "git://example.com/x.git",
    "file:///tmp/x",
    "git@example.com:x.git",
    "../local-registry",
  ]) {
    assert.throws(() => registryCloneUrl(registry), /owner\/repository slug/);
  }
});

test("registry revisions must be full immutable commit SHAs", () => {
  assert.equal(assertFullCommitSha(ACTION_SHA), ACTION_SHA);
  assert.throws(() => assertFullCommitSha("main"), /Branches and tags are not allowed/);
  assert.throws(() => assertFullCommitSha("abc123"), /40-character commit SHA/);
});

test("default registry pin includes the reviewed Spectator release", () => {
  assert.equal(
    DEFAULT_REGISTRY_REF,
    "9fa4690e2724da271129f4fff308cc5c5a00a2f5",
  );
});

test("resolveInside rejects template path traversal", () => {
  const root = join(tmpdir(), "registry", "templates");
  assert.equal(resolveInside(root, "skills-catalog"), join(root, "skills-catalog"));
  assert.throws(() => resolveInside(root, "../outside", "Template path"), /resolves outside/);
});

test("site publication rejects filesystem roots", () => {
  assert.throws(
    () => assertSafeDestination(parse(TEST_DIR).root),
    /filesystem root/,
  );
});

test("rewriteTree rewrites text, preserves binary, and rejects symlinks", () => {
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

    if (linked) {
      assert.throws(() => rewriteTree(d, { __SITE_NAME__: "Hello" }), /symbolic link/);
      rmSync(join(d, "link.txt"), { force: true });
    }
    rewriteTree(d, { __SITE_NAME__: "Hello" });

    assert.equal(readFileSync(join(d, "page.html"), "utf8"), "<title>Hello</title>");
    assert.deepEqual(readFileSync(join(d, "logo.bin")), bin, "binary file was modified");
    assert.equal(readFileSync(secret, "utf8"), "__SITE_NAME__");
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
    `<title>__SITE_NAME__</title><meta name="description" content="__SITE_DESCRIPTION__"><base href="__BASE_PATH__"><a href="https://github.com/__REPO_SLUG__">__REPO_OWNER__/__REPO_NAME__</a> __SITE_URL__ __AUTHOR_NAME__ __PKG_NAME__ __MARKETPLACE_ID__`,
  );
  writeFileSync(join(d, "_config.yml"), `baseurl: "__BASE_URL__"`);
  writeFileSync(join(d, ".github", "workflows", "deploy.yml"), safeWorkflow());
  writeFileSync(join(d, "node_modules", "junk.js"), "__SITE_NAME__ should never be copied");
  writeFileSync(join(d, "spec.md"), "Registry development specification");
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

test("listTemplates discovers the skills-catalog template", () => {
  const fx = mkdtempSync(join(tmpdir(), "ghp-catalog-"));
  try {
    mkTemplate(fx, "skills-catalog", { order: 1 });
    assert.deepEqual(listTemplates(fx), ["skills-catalog"]);
  } finally {
    rmSync(fx, { recursive: true, force: true });
  }
});

const fixtures = mkdtempSync(join(tmpdir(), "ghp-fixtures-"));
mkTemplate(fixtures, "mini");
mkTemplate(fixtures, "skills-catalog", { order: 1 });
const work = mkdtempSync(join(tmpdir(), "ghp-gen-"));
try {
  test("resolveTemplatesSource: explicit --templates-dir wins (no network)", () => {
    assert.equal(resolveTemplatesSource({ templatesDir: fixtures }), fixtures);
  });
  test("resolveTemplatesSource: a missing --templates-dir throws (no network)", () => {
    assert.throws(() => resolveTemplatesSource({ templatesDir: join(work, "nope") }), /does not exist/);
  });

  test("registry checkout verifies the requested commit without network", () => {
    const registry = join(work, "local-registry");
    mkdirSync(join(registry, "templates"), { recursive: true });
    mkTemplate(join(registry, "templates"), "skills-catalog");
    execFileSync("git", ["init", "--quiet"], { cwd: registry });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: registry });
    execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: registry });
    execFileSync("git", ["config", "user.name", "Generator Tests"], { cwd: registry });
    execFileSync("git", ["add", "."], { cwd: registry });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: registry });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: registry }).toString().trim();

    assert.equal(verifyRegistryCommit(registry, commit), commit);
    assert.throws(() => verifyRegistryCommit(registry, ACTION_SHA), /commit mismatch/);
    assert.throws(
      () => resolveTemplatesSource({ registry, registryRef: commit }),
      /owner\/repository slug/,
    );
  });

  test("registry inspection rejects Git symlink entries deterministically", () => {
    const registry = join(work, "symlink-registry");
    mkdirSync(registry, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: registry });
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: registry });
    execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: registry });
    execFileSync("git", ["config", "user.name", "Generator Tests"], { cwd: registry });
    writeFileSync(join(registry, "safe.txt"), "safe");
    execFileSync("git", ["add", "safe.txt"], { cwd: registry });
    execFileSync("git", ["commit", "--quiet", "-m", "safe"], { cwd: registry });
    assert.doesNotThrow(() => assertRegistryTreeHasNoSymlinks(registry));

    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: registry,
      input: "outside",
    }).toString().trim();
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `120000,${blob},evil-link`], { cwd: registry });
    execFileSync("git", ["commit", "--quiet", "-m", "symlink"], { cwd: registry });
    assert.throws(() => assertRegistryTreeHasNoSymlinks(registry), /symbolic link: evil-link/);
  });

  test("external registry rejects an unpinned branch before fetch", () => {
    assert.throws(
      () => resolveTemplatesSource({ registry: join(work, "unused"), registryRef: "main" }),
      /Branches and tags are not allowed/,
    );
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

  test("stamp: excludes registry-only and dependency files", () => {
    assert.ok(!existsSync(join(dir, "template.json")));
    assert.ok(!existsSync(join(dir, "node_modules")));
    assert.ok(!existsSync(join(dir, "spec.md")));
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

  test("staging contract writes project-site output without applying to a target", () => {
    const stage = join(work, "project-stage");
    const result = stampTemplate({
      template: "skills-catalog",
      stagingDir: stage,
      repo: "octocat/skills",
      templatesDir: fixtures,
    });
    assert.equal(result.staged, true);
    assert.equal(result.dir, stage);
    assert.match(read(stage, "index.html"), /href="\/skills\/"/);
    assert.throws(
      () => stampTemplate({
        template: "skills-catalog",
        stagingDir: stage,
        repo: "octocat/skills",
        templatesDir: fixtures,
      }),
      /already exists/,
    );
  });

  test("staging contract preserves the user-site root base", () => {
    const stage = join(work, "user-stage");
    const result = stampTemplate({
      template: "skills-catalog",
      stagingDir: stage,
      repo: "octocat/octocat.github.io",
      templatesDir: fixtures,
    });
    assert.equal(result.replacements.__BASE_PATH__, "/");
    assert.match(read(stage, "_config.yml"), /baseurl:\s*""/);
  });

  test("stamp rejects template traversal before reading outside the registry", () => {
    assert.throws(
      () => stampTemplate({
        template: "../outside",
        dir: join(work, "traversal"),
        repo: "octocat/demo",
        templatesDir: fixtures,
      }),
      /resolves outside/,
    );
  });

  test("stamp rejects symbolic links in template content", () => {
    const template = mkTemplate(fixtures, "linked");
    const external = join(work, "external");
    mkdirSync(external, { recursive: true });
    symlinkSync(external, join(template, "linked-dir"), "junction");
    assert.throws(
      () => stampTemplate({
        template: "linked",
        dir: join(work, "linked-output"),
        repo: "octocat/demo",
        templatesDir: fixtures,
      }),
      /symbolic link/,
    );
  });

  test("staging rejects unresolved source sentinels without rejecting user text", () => {
    const template = mkTemplate(fixtures, "unresolved");
    writeFileSync(join(template, "unknown.txt"), "__UNKNOWN_SENTINEL__");
    assert.throws(
      () => stampTemplate({
        template: "unresolved",
        stagingDir: join(work, "unresolved-stage"),
        repo: "octocat/demo",
        templatesDir: fixtures,
      }),
      /Unresolved template sentinel __UNKNOWN_SENTINEL__/,
    );
    const stage = join(work, "sentinel-text-stage");
    stampTemplate({
      template: "mini",
      stagingDir: stage,
      repo: "octocat/demo",
      siteName: "__BASE_PATH__",
      templatesDir: fixtures,
    });
    assert.match(read(stage, "index.html"), /<title>__BASE_PATH__<\/title>/);
  });

  test("workflow validation rejects every unsafe workflow class", () => {
    const cases = [
      ["unsafe permissions", safeWorkflow({ permissions: "contents: write\n  pages: write\n  id-token: write" }), /permission contents: write/],
      ["top-level deployment permissions", safeWorkflow().replace("permissions:\n  contents: read", "permissions:\n  contents: read\n  pages: write\n  id-token: write"), /top-level permissions/],
      ["missing job timeout", safeWorkflow({ timeout: "" }), /timeout-minutes/],
      ["excessive job timeout", safeWorkflow({ timeout: "    timeout-minutes: 361\n" }), /between 1 and 360/],
      ["non-SHA action", safeWorkflow({ checkoutRef: "v4" }), /not pinned/],
      ["unapproved action", safeWorkflow({ extra: `      - uses: attacker/exfiltrate@${ACTION_SHA}\n` }), /not allowed/],
      ["persisted credentials", safeWorkflow({ credentials: "" }), /persist-credentials/],
      ["commented persisted credentials", safeWorkflow({ credentials: "          # persist-credentials: false\n" }), /persist-credentials/],
      ["lifecycle install", safeWorkflow({ extra: "      - run: npm ci\n" }), /disable scripts/],
      ["explicit lifecycle scripts", safeWorkflow({ extra: "      - run: npm ci --ignore-scripts=false\n" }), /disable scripts/],
      ["detached lifecycle flag", safeWorkflow({ extra: "      - run: npm ci && echo --ignore-scripts\n" }), /standalone/],
      ["prefixed lifecycle install", safeWorkflow({ extra: "      - run: npm --prefix app ci\n" }), /standalone/],
      ["unsafe trigger", safeWorkflow({ trigger: "pull_request_target:" }), /allowed triggers/],
      ["context interpolation", safeWorkflow({ extra: "      - run: echo ${{ github.event.issue.title }}\n" }), /context interpolation/],
      ["plain multiline context interpolation", safeWorkflow({ extra: "      - run:\n          echo ${{ github.event.issue.title }}\n" }), /context interpolation/],
      ["comment-like context interpolation", safeWorkflow({ extra: "      - run: echo tag #x ${{ github.event.issue.title }}\n" }), /context interpolation/],
      ["block scalar context interpolation", safeWorkflow({ extra: "      - run: |-\n          echo ${{ github.ref }}\n" }), /context interpolation/],
      ["folded run block", safeWorkflow({ extra: "      - run: >-\n          npm ci --ignore-scripts\n" }), /folded run blocks/],
      ["quoted mapping key", `${safeWorkflow()}\n\"permissions\": write-all\n`, /quoted or explicit mapping keys/],
      ["flow-style step", safeWorkflow({ extra: `      - { uses: octocat/action@${ACTION_SHA} }\n` }), /flow-style mappings/],
      ["flow-style jobs", `${safeWorkflow()}\nevil: { permissions: write-all }\n`, /flow-style mappings/],
      ["YAML tag", `${safeWorkflow()}\nevil: !unsafe value\n`, /YAML tags/],
    ];
    for (const [name, workflow, expected] of cases) {
      const file = join(work, `${name.replace(/\s+/g, "-")}.yml`);
      writeFileSync(file, workflow);
      assert.throws(() => validateWorkflowFile(file), expected, name);
    }
  });

  test("workflow validation permits safe npm non-execution flags", () => {
    const file = join(work, "safe-install-flags.yml");
    writeFileSync(
      file,
      safeWorkflow({
        extra: "      - run: npm ci --ignore-scripts --no-audit --no-fund\n",
      }),
    );
    assert.doesNotThrow(() => validateWorkflowFile(file));
  });

  test("job-only permissions cannot replace safe workflow-wide defaults", () => {
    const file = join(work, "job-only-permissions.yml");
    const workflow = safeWorkflow()
      .replace("permissions:\n  contents: read\n", "");
    writeFileSync(file, workflow);
    assert.throws(() => validateWorkflowFile(file), /top-level permissions/);
  });

  test("configure-pages requires effective Pages access", () => {
    const file = join(work, "configure-pages-without-pages-access.yml");
    const workflow = safeWorkflow({
      jobPermissions: "    permissions:\n      contents: read\n",
      extra: `      - uses: actions/configure-pages@${ACTION_SHA}\n`,
    });
    writeFileSync(file, workflow);
    assert.throws(() => validateWorkflowFile(file), /effective pages read or write access/);
  });

  test("configure-pages accepts job-scoped Pages read access", () => {
    const file = join(work, "configure-pages-job-pages-access.yml");
    const workflow = safeWorkflow({
      jobPermissions: "    permissions:\n      contents: read\n      pages: read\n",
      extra: `      - uses: actions/configure-pages@${ACTION_SHA}\n`,
    });
    writeFileSync(file, workflow);
    assert.doesNotThrow(() => validateWorkflowFile(file));
  });

  test("pinned default compatibility normalizes legacy template workflows", () => {
    const root = join(work, "legacy-default");
    const workflows = join(root, ".github", "workflows");
    mkdirSync(workflows, { recursive: true });
    const file = join(workflows, "deploy.yml");
    writeFileSync(file, `name: pages
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Setup
        uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install
        run: npm install
      - name: Deploy
        uses: actions/deploy-pages@v4
`);
    normalizePinnedLegacyWorkflows(root);
    assert.doesNotThrow(() => validateWorkflowFile(file));
    const normalized = readFileSync(file, "utf8");
    assert.match(normalized, /actions\/checkout@[0-9a-f]{40}/);
    assert.match(normalized, /persist-credentials: false/);
    assert.equal((normalized.match(/^\s+with:\s*$/gm) || []).length, 2);
    assert.match(normalized, /fetch-depth: 0/);
    assert.match(normalized, /npm install --ignore-scripts/);
    assert.match(normalized, /node-version: 24/);
  });

  test("checkout credentials must be disabled in each checkout step", () => {
    const file = join(work, "two-checkouts.yml");
    const workflow = safeWorkflow({
      credentials: "",
      extra: `      - uses: actions/checkout@${ACTION_SHA}
        with:
          persist-credentials: false
`,
    });
    writeFileSync(file, workflow);
    assert.throws(() => validateWorkflowFile(file), /persist-credentials/);
  });

  test("checkout credential validation ignores comments and nested scalar content", () => {
    const file = join(work, "fake-checkout-credentials.yml");
    const workflow = safeWorkflow({
      credentials: `          note: |
            persist-credentials: false
          # persist-credentials: false
`,
    });
    writeFileSync(file, workflow);
    assert.throws(() => validateWorkflowFile(file), /persist-credentials/);
  });

  test("workflow parsing handles trailing spaces and commented block headers", () => {
    const trailing = join(work, "trailing-action.yml");
    writeFileSync(trailing, safeWorkflow({ checkoutRef: "v4 " }));
    assert.throws(() => validateWorkflowFile(trailing), /not pinned/);

    const block = join(work, "commented-block.yml");
    writeFileSync(block, safeWorkflow({
      extra: "      - run: | # install\n          npm ci\n",
    }));
    assert.throws(() => validateWorkflowFile(block), /standalone/);
  });

  test("unsafe workflow rejection happens before target apply", () => {
    const unsafeTemplate = mkTemplate(fixtures, "unsafe");
    writeFileSync(
      join(unsafeTemplate, ".github", "workflows", "deploy.yml"),
      safeWorkflow({ checkoutRef: "main" }),
    );
    const target = join(work, "protected-target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep.txt"), "unchanged");
    assert.throws(
      () => stampTemplate({
        template: "unsafe",
        dir: target,
        repo: "octocat/demo",
        templatesDir: fixtures,
        force: true,
      }),
      /not pinned/,
    );
    assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "unchanged");
    assert.equal(existsSync(join(target, "index.html")), false);
  });

  test("failed staging removes partial output", () => {
    const stage = join(work, "failed-stage");
    assert.throws(
      () => stampTemplate({
        template: "unsafe",
        stagingDir: stage,
        repo: "octocat/demo",
        templatesDir: fixtures,
      }),
      /not pinned/,
    );
    assert.equal(existsSync(stage), false);
  });

  test("CLI staging emits a machine-readable composition result", () => {
    const stage = join(work, "cli-stage");
    const output = execFileSync(process.execPath, [
      join("scripts", "new-site.mjs"),
      "skills-catalog",
      "--repo", "octocat/skills",
      "--templates-dir", fixtures,
      "--staging-dir", stage,
      "--json",
    ], { cwd: join(TEST_DIR, "..") }).toString();
    const result = JSON.parse(output);
    assert.equal(result.mode, "staged");
    assert.equal(result.directory, stage);
    assert.equal(result.template, "skills-catalog");
    assert.equal(result.replacements.__BASE_PATH__, "/skills/");
  });

  test("CLI apply reports the configured default branch", () => {
    const outputDirectory = join(work, "cli-apply-branch");
    const result = spawnSync(process.execPath, [
      join("scripts", "new-site.mjs"),
      "skills-catalog",
      "--repo", "octocat/skills",
      "--templates-dir", fixtures,
      "--dir", outputDirectory,
      "--default-branch", "trunk",
    ], {
      cwd: join(TEST_DIR, ".."),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /repo's trunk branch/);
  });

  test("CLI rejects options whose values are missing", () => {
    const result = spawnSync(process.execPath, [
      join("scripts", "new-site.mjs"),
      "skills-catalog",
      "--base", "/",
      "--dir",
      "--force",
    ], {
      cwd: join(TEST_DIR, ".."),
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Option --dir requires a value/);
  });

  test("unknown template throws with the list of valid names", () => {
    assert.throws(() => stampTemplate({ template: "nope", dir: join(work, "x"), repo: "o/r", templatesDir: fixtures }), /Unknown template/);
  });

  test("invalid template manifests fail before target mutation", () => {
    const template = mkTemplate(fixtures, "invalid-manifest");
    writeFileSync(join(template, "template.json"), "null");
    const target = join(work, "invalid-manifest-target");
    assert.throws(
      () => stampTemplate({
        template: "invalid-manifest",
        dir: target,
        repo: "octocat/demo",
        templatesDir: fixtures,
      }),
      /expected an object/,
    );
    assert.equal(existsSync(target), false);
  });
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(fixtures, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed`);
