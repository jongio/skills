import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  assertFullCommitSha,
  assertRegistryTreeHasNoSymlinks,
  resolveInside,
} from "./template-security.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LOCAL_TEMPLATES_DIR = resolve(SCRIPT_DIR, "..", "templates");

export const DEFAULT_REGISTRY = "jongio/gh-pages-templates";
export const DEFAULT_REGISTRY_REF = "9fa4690e2724da271129f4fff308cc5c5a00a2f5";

const registryClones = new Map();
let exitHookInstalled = false;
const GIT_TIMEOUT_MS = 60_000;
const GITHUB_REPOSITORY_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const clone of registryClones.values()) clone.cleanup();
  });
}

export function registryCloneUrl(registry) {
  if (
    typeof registry !== "string" ||
    !GITHUB_REPOSITORY_RE.test(registry) ||
    registry.endsWith("/.") ||
    registry.endsWith("/..")
  ) {
    throw new Error(
      "Template registry must be a canonical GitHub owner/repository slug. Use --templates-dir for a local checkout.",
    );
  }
  return `https://github.com/${registry}.git`;
}

export function verifyRegistryCommit(root, expectedRef) {
  const expected = assertFullCommitSha(expectedRef);
  let actual;
  try {
    actual = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    }).toString().trim().toLowerCase();
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString().trim() : error.message;
    throw new Error(`Failed to verify registry commit: ${detail}`);
  }
  if (actual !== expected) throw new Error(`Registry commit mismatch: expected ${expected}, checked out ${actual}.`);
  return actual;
}

function cloneRegistry(registry, registryRef) {
  const ref = assertFullCommitSha(registryRef);
  const key = `${registry}@${ref}`;
  if (registryClones.has(key)) return registryClones.get(key);
  const root = mkdtempSync(join(tmpdir(), "ghp-registry-"));
  const url = registryCloneUrl(registry);
  const entry = {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  registryClones.set(key, entry);
  installExitHook();
  try {
    execFileSync("git", ["init", "--quiet", root], {
      stdio: "pipe",
      timeout: GIT_TIMEOUT_MS,
    });
    execFileSync("git", ["remote", "add", "origin", url], {
      cwd: root,
      stdio: "pipe",
      timeout: GIT_TIMEOUT_MS,
    });
    execFileSync("git", ["fetch", "--quiet", "--depth", "1", "origin", ref], {
      cwd: root,
      stdio: "pipe",
      timeout: GIT_TIMEOUT_MS,
    });
    execFileSync("git", ["checkout", "--quiet", "--detach", ref], {
      cwd: root,
      stdio: "pipe",
      timeout: GIT_TIMEOUT_MS,
    });
    verifyRegistryCommit(root, ref);
    assertRegistryTreeHasNoSymlinks(root);
  } catch (error) {
    registryClones.delete(key);
    entry.cleanup();
    const detail = error.stderr ? error.stderr.toString().trim() : error.message;
    throw new Error(`Failed to fetch registry ${registry} at ${ref}: ${detail}\nPass --templates-dir <path> to scaffold from a local copy offline.`);
  }
  return entry;
}

function assertTemplatesRoot(root) {
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
    throw new Error(`Templates root ${root} must be a real directory, not a symbolic link.`);
  }
  return root;
}

export function resolveTemplatesSource({ registry, registryRef, templatesDir } = {}) {
  if (templatesDir) {
    const root = resolve(templatesDir);
    if (!existsSync(root)) throw new Error(`--templates-dir ${root} does not exist.`);
    return assertTemplatesRoot(root);
  }
  if (registry) {
    const root = resolveInside(cloneRegistry(registry, registryRef).root, "templates", "Templates root");
    return assertTemplatesRoot(root);
  }
  if (existsSync(LOCAL_TEMPLATES_DIR)) return assertTemplatesRoot(LOCAL_TEMPLATES_DIR);
  const root = resolveInside(
    cloneRegistry(DEFAULT_REGISTRY, registryRef || DEFAULT_REGISTRY_REF).root,
    "templates",
    "Templates root",
  );
  return assertTemplatesRoot(root);
}
