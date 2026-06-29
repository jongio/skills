#!/usr/bin/env node
// new-site.mjs — scaffold a GitHub Pages site from a template.
//
//   node scripts/new-site.mjs <template> --repo <owner/name> [options]
//
// It copies the chosen template, then injects the correct base path everywhere
// the framework needs it (config, workflow env, links) so the site works at a
// project URL (https://USER.github.io/REPO/) or a user URL (https://USER.github.io/).
//
// Options:
//   --repo <owner/name>   Target GitHub repo. Drives the base path and URLs.
//                         Defaults to the current repo's "origin" remote.
//   --base </path/>       Override the base path (e.g. "/my-repo/" or "/").
//   --dir <path>          Output directory (default: ./<repo-name or template>).
//   --site-name <title>   Human title (default: derived from the repo name).
//   --registry <owner/repo>  Fetch the template from a remote registry repo
//                            instead of the bundled copies (needs git + network).
//   --force               Write into a non-empty directory.
//   --list                List available templates and exit.
//   --help                Show this help.
//
// If neither --repo nor --base is given, the generator assumes the current repo
// (read from the "origin" remote) so a site is scaffolded for the repo you're in.

import { existsSync, readdirSync, readFileSync, writeFileSync, lstatSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, "..", "templates");

// Files/dirs never copied into a stamped site.
const SKIP_ENTRIES = new Set(["node_modules", "dist", "_site", ".git", ".cache", ".jekyll-cache", "template.json"]);

// Sentinels replaced during stamping. Replacement is a single pass over a
// combined regex so an injected value (e.g. a --site-name that happens to
// contain "__BASE_PATH__") is never re-scanned and substituted again.
const SENTINELS = ["__SITE_NAME__", "__SITE_URL__", "__SITE_ORIGIN__", "__BASE_PATH__", "__BASE_URL__", "__REPO_SLUG__", "__PKG_NAME__"];
const SENTINEL_RE = new RegExp(SENTINELS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Normalize a base path to a leading+trailing-slash form ("/", "/repo/"). */
export function normalizeBase(input) {
  if (!input || input === "/") return "/";
  let b = String(input).trim();
  if (!b.startsWith("/")) b = "/" + b;
  if (!b.endsWith("/")) b = b + "/";
  return b.replace(/\/{2,}/g, "/");
}

/** Title-case a repo/dir slug: "my-cool-site" -> "My Cool Site". */
export function titleize(slug) {
  return String(slug)
    .replace(/\.github\.io$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "My Site";
}

/** Sanitize a string into a valid npm package name. */
export function pkgNameOf(slug) {
  return (
    String(slug)
      .toLowerCase()
      .replace(/[^a-z0-9-_.]/g, "-")
      .replace(/^[-_.]+/, "")
      .replace(/[-_.]+$/, "") || "my-site"
  );
}

/**
 * Parse an "owner/name" slug from a git remote URL. Handles the common GitHub
 * forms (https, ssh scp-like, ssh:// and a bare owner/name), returns null if it
 * can't find a clean owner/name pair.
 */
export function parseRepoSlug(remoteUrl) {
  if (!remoteUrl) return null;
  let s = String(remoteUrl).trim();
  if (!s) return null;
  s = s
    .replace(/^git\+/i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/^ssh:\/\//i, "")
    .replace(/^git:\/\//i, "")
    .replace(/^[^@/]+@/, "") // strip "git@" style userinfo
    .replace(/^github\.com[:/]/i, "")
    .replace(/[:/]+$/, "")
    .replace(/\.git$/i, "");
  const parts = s.split(/[/:]/).filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, name] = parts.slice(-2);
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

/**
 * Detect the current repo's "owner/name" from its "origin" remote (falling back
 * to any remote). Returns null when not in a git repo or no usable remote.
 */
export function detectCurrentRepo(cwd = process.cwd()) {
  const tryGit = (args) => {
    try {
      return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "";
    }
  };
  let url = tryGit(["remote", "get-url", "origin"]);
  if (!url) {
    const remotes = tryGit(["remote"]).split(/\r?\n/).filter(Boolean);
    if (remotes.length) url = tryGit(["remote", "get-url", remotes[0]]);
  }
  return parseRepoSlug(url);
}

/**
 * Compute every sentinel replacement from the user's inputs.
 * @param {{repo?: string, base?: string, siteName?: string, dir?: string}} opts
 */
export function computeReplacements({ repo, base, siteName, dir } = {}) {
  let owner = "USERNAME";
  let repoName = dir ? basename(dir) : "my-site";

  if (repo) {
    const m = String(repo).trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
    const parts = m.split("/").filter(Boolean);
    if (parts.length !== 2) throw new Error(`--repo must be "owner/name", got "${repo}"`);
    [owner, repoName] = parts;
  }

  const isUserSite = repoName.toLowerCase() === `${owner.toLowerCase()}.github.io`;

  let basePath;
  if (base != null && base !== "") basePath = normalizeBase(base);
  else if (repo) basePath = isUserSite ? "/" : `/${repoName}/`;
  else throw new Error("No target repo found. Run inside a git repo with an 'origin' remote, or pass --repo <owner/name> or --base </path/>.");

  const baseUrl = basePath === "/" ? "" : basePath.replace(/\/$/, ""); // "/repo" or ""
  const siteOrigin = `https://${owner.toLowerCase()}.github.io`;
  const siteUrl = basePath === "/" ? `${siteOrigin}/` : `${siteOrigin}${basePath}`;
  const title = siteName || titleize(repoName);

  return {
    __SITE_NAME__: title,
    __SITE_URL__: siteUrl,
    __SITE_ORIGIN__: siteOrigin,
    __BASE_PATH__: basePath,
    __BASE_URL__: baseUrl,
    __REPO_SLUG__: `${owner}/${repoName}`,
    __PKG_NAME__: pkgNameOf(repoName),
  };
}

/** True if the buffer looks like binary (has a NUL in the first 8 KB). */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Replace every sentinel in a single pass (injected values are never re-scanned). */
export function applyReplacements(text, replacements) {
  return text.replace(SENTINEL_RE, (m) => (m in replacements ? replacements[m] : m));
}

/** List bundled template names (folders with a template.json). */
export function listTemplates(dir = TEMPLATES_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "template.json")))
    .sort((a, b) => {
      const oa = readManifest(join(dir, a)).order ?? 99;
      const ob = readManifest(join(dir, b)).order ?? 99;
      return oa - ob || a.localeCompare(b);
    });
}

export function readManifest(templateDir) {
  return JSON.parse(readFileSync(join(templateDir, "template.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// Filesystem operations
// ---------------------------------------------------------------------------

function copyTemplate(srcDir, destDir) {
  cpSync(srcDir, destDir, {
    recursive: true,
    filter: (src) => !SKIP_ENTRIES.has(basename(src)),
  });
}

/** Rewrite sentinels in every regular text file under dir. Symlinks and other
 *  non-regular files are skipped (never followed) so a template — especially one
 *  fetched from a remote registry — can't escape the destination or loop. */
export function rewriteTree(dir, replacements) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      rewriteTree(full, replacements);
    } else if (st.isFile()) {
      const buf = readFileSync(full);
      if (looksBinary(buf)) continue;
      const text = buf.toString("utf8");
      const next = applyReplacements(text, replacements);
      if (next !== text) writeFileSync(full, next);
    }
  }
}

/** Build the clone URL for a registry "owner/repo" (or pass a full URL through). */
export function registryCloneUrl(registry) {
  return /^https?:\/\//.test(registry) ? registry : `https://github.com/${registry}.git`;
}

/** Fetch a template subdir from a remote registry into a temp dir; returns its path. */
function fetchFromRegistry(registry, template) {
  const tmp = join(tmpdir(), `ghp-registry-${Date.now()}`);
  const url = registryCloneUrl(registry);
  try {
    execFileSync("git", ["clone", "--depth", "1", url, tmp], { stdio: "pipe" });
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    const detail = err.stderr ? err.stderr.toString().trim() : err.message;
    throw new Error(`Failed to clone registry ${registry}: ${detail}`);
  }
  const sub = join(tmp, "templates", template);
  if (!existsSync(sub)) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`Template "${template}" not found in registry ${registry} (expected templates/${template}).`);
  }
  return { dir: sub, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

/**
 * Stamp a template into a target directory.
 * @returns {{ dir: string, replacements: object, manifest: object }}
 */
export function stampTemplate({ template, dir, repo, base, siteName, registry, force = false } = {}) {
  let srcDir = join(TEMPLATES_DIR, template);
  let cleanup = null;

  if (registry) {
    const fetched = fetchFromRegistry(registry, template);
    srcDir = fetched.dir;
    cleanup = fetched.cleanup;
  }

  if (!existsSync(join(srcDir, "template.json"))) {
    if (cleanup) cleanup();
    const avail = listTemplates().join(", ") || "(none)";
    throw new Error(`Unknown template "${template}". Available: ${avail}`);
  }

  const manifest = readManifest(srcDir);
  const replacements = computeReplacements({ repo, base, siteName, dir });
  const destDir = resolve(dir || replacements.__PKG_NAME__);

  if (existsSync(destDir) && readdirSync(destDir).length > 0 && !force) {
    if (cleanup) cleanup();
    throw new Error(`Target ${destDir} is not empty. Use --force to write into it.`);
  }
  mkdirSync(destDir, { recursive: true });

  try {
    copyTemplate(srcDir, destDir);
    rewriteTree(destDir, replacements);
  } finally {
    if (cleanup) cleanup();
  }

  return { dir: destDir, replacements, manifest };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--list") args.list = true;
    else if (a === "--force") args.force = true;
    else if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

const HELP = `
create-gh-pages-site — scaffold a GitHub Pages site from a template.

Usage:
  node scripts/new-site.mjs <template> --repo <owner/name> [options]

Templates: ${listTemplates().join(", ") || "(none found)"}

Options:
  --repo <owner/name>      Target GitHub repo (drives base path + URLs)
                           Defaults to the current repo's "origin" remote
  --base </path/>          Override base path (e.g. "/my-repo/" or "/")
  --dir <path>             Output directory (default: ./<repo-name>)
  --site-name <title>      Human title (default: from repo name)
  --registry <owner/repo>  Fetch template from a remote registry (git + network)
  --force                  Write into a non-empty directory
  --list                   List templates and exit
  --help                   Show this help

If neither --repo nor --base is given, the current repo is assumed (read from
the "origin" remote), so a site is scaffolded for the repo you're in.

Examples:
  node scripts/new-site.mjs astro                               # current repo
  node scripts/new-site.mjs astro --repo octocat/my-astro-site
  node scripts/new-site.mjs react-vite --repo octocat/dashboard --site-name "Dashboard"
  node scripts/new-site.mjs static-html --base / --dir ./site   # user site / local
`;

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.list) {
    for (const name of listTemplates()) {
      const m = readManifest(join(TEMPLATES_DIR, name));
      console.log(`  ${name.padEnd(14)} ${m.tagline}`);
    }
    return;
  }

  const template = args._[0];
  if (!template) {
    console.error("Error: missing <template>.\n" + HELP);
    process.exit(1);
  }

  // Assume the current repo when neither --repo nor --base is provided, so a
  // site is scaffolded for the repo you're in.
  let repo = args.repo;
  if (!repo && !args.base) {
    const detected = detectCurrentRepo();
    if (detected) {
      repo = detected;
      console.log(`Using current repo from origin remote: ${repo}`);
    }
  }

  try {
    const { dir, replacements, manifest } = stampTemplate({
      template,
      dir: args.dir,
      repo,
      base: args.base,
      siteName: args["site-name"],
      registry: args.registry,
      force: args.force,
    });

    console.log(`\n✓ Created ${manifest.title} site in ${dir}`);
    console.log(`  base path: ${replacements.__BASE_PATH__}`);
    console.log(`  site URL:  ${replacements.__SITE_URL__}\n`);
    console.log("Next steps:");
    let step = 1;
    if (manifest.needsBuild) {
      if (manifest.language === "Ruby") {
        console.log(`  ${step++}. cd ${dir} && bundle install   # local preview only — CI builds it for you`);
      } else {
        console.log(`  ${step++}. cd ${dir} && npm install && npm run build`);
      }
    }
    console.log(`  ${step++}. Commit and push to the repo's main branch.`);
    console.log(`  ${step++}. Settings → Pages → Source → "GitHub Actions".`);
    console.log(`  ${step++}. The deploy workflow publishes on push; the URL appears in the Actions run.`);
    if (repo) {
      console.log(`  ${step++}. Set the repo "Website" link to the Pages URL:`);
      console.log(`       gh repo edit ${replacements.__REPO_SLUG__} --homepage ${replacements.__SITE_URL__}`);
    }
    console.log();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
