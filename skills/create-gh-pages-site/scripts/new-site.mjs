#!/usr/bin/env node
// new-site.mjs — scaffold a GitHub Pages site from a template.
//
//   node scripts/new-site.mjs <template> --repo <owner/name> [options]
//
// It copies the chosen template, then injects the correct base path everywhere
// the framework needs it (config, workflow env, links) so the site works at a
// project URL (https://USER.github.io/REPO/) or a user URL (https://USER.github.io/).
//
// Templates are fetched from the jongio/gh-pages-templates registry at an
// immutable commit. That registry is the single source of truth. Pass --templates-dir
// to scaffold from a local copy offline.
//
// Options:
//   --repo <owner/name>   Target GitHub repo. Drives the base path and URLs.
//                         Defaults to the current repo's "origin" remote.
//   --base </path/>       Override the base path (e.g. "/my-repo/" or "/").
//   --dir <path>          Output directory (default: ./<repo-name or template>).
//   --site-name <title>   Human title (default: derived from the repo name).
//   --description <text>  Site description (default: catalog description).
//   --author <name>       Author display name (default: repository owner).
//   --package-name <id>   Package identifier (default: repository name).
//   --marketplace-id <id> Marketplace identifier (default: owner-repository).
//   --default-branch <id>  Repository default branch (default: main).
//   --registry <owner/repo>  Use a different template registry repo.
//   --registry-ref <sha>     Full 40-character commit SHA for the registry.
//   --templates-dir <path>   Use a local templates/ folder instead (offline; no fetch).
//   --staging-dir <path>     Validate into a new directory without applying to a target.
//   --force               Write into a non-empty directory.
//   --list                List available templates and exit.
//   --help                Show this help.
//
// If neither --repo nor --base is given, the generator assumes the current repo
// (read from the "origin" remote) so a site is scaffolded for the repo you're in.

import { existsSync, readdirSync, readFileSync, writeFileSync, lstatSync, cpSync, mkdirSync, rmSync, mkdtempSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve, dirname, basename, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  assertNoSymlinks,
  normalizePinnedLegacyWorkflows,
  resolveInside,
  validateStagedTree,
  validateTemplateSentinels,
} from "./template-security.mjs";
import {
  DEFAULT_REGISTRY,
  DEFAULT_REGISTRY_REF,
  resolveTemplatesSource,
} from "./template-registry.mjs";
import { runNewSiteCli } from "./new-site-cli.mjs";

export {
  assertFullCommitSha,
  assertNoSymlinks,
  assertRegistryTreeHasNoSymlinks,
  normalizePinnedLegacyWorkflows,
  resolveInside,
  validateStagedTree,
  validateTemplateSentinels,
  validateWorkflowFile,
} from "./template-security.mjs";
export {
  DEFAULT_REGISTRY,
  DEFAULT_REGISTRY_REF,
  registryCloneUrl,
  resolveTemplatesSource,
  verifyRegistryCommit,
} from "./template-registry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, "..", "templates");

// The registry is the single source of truth for templates. The skill no longer
// bundles its own copy; the generator fetches from here unless --templates-dir
// (or a local templates/ next to the script) provides an offline source.
// Files/dirs never copied into a stamped site.
const SKIP_ENTRIES = new Set(["node_modules", "dist", "_site", ".git", ".cache", ".jekyll-cache", "template.json"]);

// Sentinels replaced during stamping. Replacement is a single pass over a
// combined regex so an injected value (e.g. a --site-name that happens to
// contain "__BASE_PATH__") is never re-scanned and substituted again.
const SENTINELS = [
  "__SITE_NAME__",
  "__SITE_DESCRIPTION__",
  "__SITE_URL__",
  "__SITE_ORIGIN__",
  "__BASE_PATH__",
  "__BASE_URL__",
  "__REPO_SLUG__",
  "__REPO_OWNER__",
  "__REPO_NAME__",
  "__AUTHOR_NAME__",
  "__PKG_NAME__",
  "__MARKETPLACE_ID__",
  "__DEFAULT_BRANCH__",
];
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

function safeTemplateText(value, label) {
  const text = String(value);
  if (!/^[\p{L}\p{N} .,'()/_+!?-]+$/u.test(text)) {
    throw new Error(`${label} contains characters that are unsafe for template substitution.`);
  }
  return text;
}

function safeRepoComponent(value, label) {
  const component = String(value);
  if (!/^[A-Za-z0-9_.-]+$/.test(component) || component === "." || component === "..") {
    throw new Error(`${label} is not a valid GitHub repository component.`);
  }

  return component;
}

function safeDefaultBranch(value) {
  const branch = String(value || "main").trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(branch)) {
    throw new Error("--default-branch must be a lowercase GitHub branch identifier.");
  }
  return branch;
}

function validateBasePath(basePath) {
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(basePath) || basePath.split("/").includes("..")) {
    throw new Error("--base contains characters or traversal segments that are unsafe for template substitution.");
  }
  return basePath;
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
 * @param {{
 *   repo?: string,
 *   base?: string,
 *   siteName?: string,
 *   description?: string,
 *   author?: string,
 *   packageName?: string,
 *   marketplaceId?: string,
 *   dir?: string
 * }} opts
 */
export function computeReplacements({
  repo,
  base,
  siteName,
  description,
  author,
  packageName,
  marketplaceId,
  defaultBranch,
  dir,
} = {}) {
  let owner = "USERNAME";
  let repoName = dir ? basename(dir) : "my-site";

  if (repo) {
    const m = String(repo).trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
    const parts = m.split("/").filter(Boolean);
    if (parts.length !== 2) throw new Error(`--repo must be "owner/name", got "${repo}"`);
    owner = safeRepoComponent(parts[0], "Repository owner");
    repoName = safeRepoComponent(parts[1], "Repository name");
  }

  const isUserSite = repoName.toLowerCase() === `${owner.toLowerCase()}.github.io`;

  let basePath;
  if (base != null && base !== "") basePath = validateBasePath(normalizeBase(base));
  else if (repo) basePath = isUserSite ? "/" : `/${repoName}/`;
  else throw new Error("No target repo found. Run inside a git repo with an 'origin' remote, or pass --repo <owner/name> or --base </path/>.");

  const baseUrl = basePath === "/" ? "" : basePath.replace(/\/$/, ""); // "/repo" or ""
  const siteOrigin = `https://${owner.toLowerCase()}.github.io`;
  const siteUrl = basePath === "/" ? `${siteOrigin}/` : `${siteOrigin}${basePath}`;
  const title = safeTemplateText(siteName || titleize(repoName), "--site-name");
  const safeDescription = description
    ? safeTemplateText(description, "--description")
    : `${title} is a searchable catalog of reusable agent skills from ${owner}/${repoName}.`;
  const safeAuthor = safeTemplateText(author || owner, "--author");
  const packageId = pkgNameOf(packageName || repoName);
  const marketplace = pkgNameOf(marketplaceId || `${owner}-${repoName}`);

  return {
    __SITE_NAME__: title,
    __SITE_DESCRIPTION__: safeDescription,
    __SITE_URL__: siteUrl,
    __SITE_ORIGIN__: siteOrigin,
    __BASE_PATH__: basePath,
    __BASE_URL__: baseUrl,
    __REPO_SLUG__: `${owner}/${repoName}`,
    __REPO_OWNER__: owner,
    __REPO_NAME__: repoName,
    __AUTHOR_NAME__: safeAuthor,
    __PKG_NAME__: packageId,
    __MARKETPLACE_ID__: marketplace,
    __DEFAULT_BRANCH__: safeDefaultBranch(defaultBranch),
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

/** List template names in a templates root (folders with a template.json). */
export function listTemplates(dir = TEMPLATES_DIR) {
  if (!existsSync(dir)) return [];
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) {
    throw new Error(`Templates root ${dir} must be a real directory, not a symbolic link.`);
  }
  return readdirSync(dir)
    .filter((name) => {
      const templateDir = join(dir, name);
      const manifest = join(templateDir, "template.json");
      if (!existsSync(manifest)) return false;
      return !lstatSync(templateDir).isSymbolicLink() && lstatSync(templateDir).isDirectory() && !lstatSync(manifest).isSymbolicLink();
    })
    .sort((a, b) => {
      const oa = readManifest(join(dir, a)).order ?? 99;
      const ob = readManifest(join(dir, b)).order ?? 99;
      return oa - ob || a.localeCompare(b);
    });
}

export function readManifest(templateDir) {
  const file = join(templateDir, "template.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid template manifest ${file}: ${error.message}`);
  }
  const requiredStrings = ["name", "title", "tagline"];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Invalid template manifest ${file}: expected an object.`);
  }
  for (const field of requiredStrings) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
      throw new Error(`Invalid template manifest ${file}: ${field} must be a non-empty string.`);
    }
  }
  if (manifest.name !== basename(templateDir)) {
    throw new Error(`Invalid template manifest ${file}: name must match its directory.`);
  }
  if (typeof manifest.needsBuild !== "boolean") {
    throw new Error(`Invalid template manifest ${file}: needsBuild must be a boolean.`);
  }
  if (manifest.language != null && typeof manifest.language !== "string") {
    throw new Error(`Invalid template manifest ${file}: language must be a string when present.`);
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Filesystem operations
// ---------------------------------------------------------------------------

function copyTemplate(srcDir, destDir) {
  assertNoSymlinks(srcDir);
  cpSync(srcDir, destDir, {
    recursive: true,
    force: true,
    filter: (src) => !SKIP_ENTRIES.has(basename(src)),
  });
}

function publishStage(stage, destDir, force) {
  const parent = dirname(destDir);
  mkdirSync(parent, { recursive: true });
  const publish = mkdtempSync(join(parent, `.${basename(destDir)}.publish-`));
  const backup = join(parent, `.${basename(destDir)}.backup-${randomUUID()}`);
  const hadDestination = existsSync(destDir);
  let backedUp = false;
  try {
    if (hadDestination && force) {
      cpSync(destDir, publish, { recursive: true, force: true });
    }

    cpSync(stage, publish, { recursive: true, force: true });
    if (hadDestination) {
      renameSync(destDir, backup);
      backedUp = true;
    }
    renameSync(publish, destDir);
    if (backedUp) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(publish, { recursive: true, force: true });
    if (backedUp && !existsSync(destDir)) renameSync(backup, destDir);
    throw error;
  }
}

export function assertSafeDestination(destination) {
  const resolved = resolve(destination);
  if (resolved === parse(resolved).root) {
    throw new Error(`Refusing to publish a site to filesystem root ${resolved}.`);
  }
  return resolved;
}

/** Rewrite sentinels in every regular text file under dir. */
export function rewriteTree(dir, replacements) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) throw new Error(`Template contains a symbolic link: ${full}`);
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

/**
 * Stamp a template into a target directory.
 * Use stagingDir to stop after validation without modifying a destination.
 * @returns {{ dir: string, replacements: object, manifest: object, staged: boolean }}
 */
export function stampTemplate({
  template,
  dir,
  stagingDir,
  repo,
  base,
  siteName,
  description,
  author,
  packageName,
  marketplaceId,
  defaultBranch,
  registry,
  registryRef,
  templatesDir,
  force = false,
} = {}) {
  if (stagingDir && dir) throw new Error("--staging-dir cannot be combined with --dir.");
  if (stagingDir && force) throw new Error("--staging-dir cannot be combined with --force.");

  const templatesRoot = resolveTemplatesSource({ registry, registryRef, templatesDir });
  const srcDir = resolveInside(templatesRoot, template, "Template path");

  if (!existsSync(join(srcDir, "template.json"))) {
    const avail = listTemplates(templatesRoot).join(", ") || "(none)";
    if (template === "skills-catalog") {
      throw new Error(`Template "skills-catalog" is not present at the selected registry revision. Pass a pinned registry revision that contains it, or use --templates-dir. Available: ${avail}`);
    }
    throw new Error(`Unknown template "${template}". Available: ${avail}`);
  }

  assertNoSymlinks(srcDir);
  const manifest = readManifest(srcDir);
  const replacements = computeReplacements({
    repo,
    base,
    siteName,
    description,
    author,
    packageName,
    marketplaceId,
    defaultBranch,
    dir: dir || stagingDir,
  });
  const destDir = stagingDir
    ? null
    : assertSafeDestination(dir || replacements.__PKG_NAME__);

  if (destDir && existsSync(destDir) && readdirSync(destDir).length > 0 && !force) {
    throw new Error(`Target ${destDir} is not empty. Use --force to write into it.`);
  }

  const stage = stagingDir ? resolve(stagingDir) : mkdtempSync(join(tmpdir(), "ghp-stage-"));
  if (stagingDir && existsSync(stage)) {
    throw new Error(`Staging directory ${stage} already exists. Choose a new path so no staged file can be overwritten.`);
  }
  if (stagingDir) {
    mkdirSync(dirname(stage), { recursive: true });
    mkdirSync(stage);
  }

  let succeeded = false;
  try {
    copyTemplate(srcDir, stage);
    const usesLegacyDefault = !templatesDir
      && !registry
      && (!registryRef || registryRef.toLowerCase() === DEFAULT_REGISTRY_REF);
    if (usesLegacyDefault) normalizePinnedLegacyWorkflows(stage);
    validateTemplateSentinels(stage, SENTINELS);
    rewriteTree(stage, replacements);
    validateStagedTree(stage);
    if (stagingDir) {
      succeeded = true;
      return { dir: stage, replacements, manifest, staged: true };
    }

    publishStage(stage, destDir, force);
    succeeded = true;
    return { dir: destDir, replacements, manifest, staged: false };
  } finally {
    if (!stagingDir || !succeeded) rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runNewSiteCli(process.argv.slice(2), {
    DEFAULT_REGISTRY,
    DEFAULT_REGISTRY_REF,
    detectCurrentRepo,
    listTemplates,
    readManifest,
    resolveTemplatesSource,
    stampTemplate,
  });
}
