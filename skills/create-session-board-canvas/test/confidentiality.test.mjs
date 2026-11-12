import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SKILL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(SKILL_ROOT, "..", "..");

// One-way SHA-256 digests of forbidden internal repository slugs, internal DB
// filenames, and private implementation filenames that must never appear in
// public skill files, documentation, tests, or evaluation specs.
const FORBIDDEN_TOKEN_HASHES = new Set([
  "6dd1fb7d5530b07088fb099b49566158d6b6cb1c9e25baaf48cf00a78de71bb4",
  "10953873c34d8954a8edc81884307d5cbf13432cfc1deb92e8edeec1a83a261d",
  "f12103427f4293e2d8e6c8fffb4ba78ccf144afbfbbef932aafa70698f037c29",
  "4559a80d72d2434b75048ce8279dacab8a18bc731f199e7b26eb688294b46034",
  "637f0ce92c3470bfa60f42d36d73a1118493acbd23ef4286f5de9207ce4d9174",
  "cc2cbcfb1c10c115e9089a37a5334383194ea9db96e960ecead85f74a34c46cf",
  "d4f34e256ce5a3f8f16f2496eab92a8e2633f2f0426ff58feae18a411c4db265",
  "4d8a56d8562dc9f4ef58587b92e44292cdf43ebe87f7f0c1843411fe1d4faf49",
  "7922957124e5be28ce7c0be7e6383f04beb2f6aa321a8ccc68fbcec2069ce3dd",
  "4b6b0bc8fed8e02bbd15a8cface31970a3085267c5c053d5c29e90f1c0629aab",
  "3622a2597c601c7165dcf89f175a124ffee5586d46a93007389a886fceb6a1e6",
]);

const EXCLUDED_DIRS = new Set(["node_modules", "vally-results", "canvas-kit"]);
const BINARY_EXTENSIONS = new Set([".png", ".ico", ".woff2"]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function findForbiddenTokens(content, blockedHashes = FORBIDDEN_TOKEN_HASHES) {
  const lower = String(content).toLowerCase();
  const candidates = new Set();
  for (const match of lower.matchAll(/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+/g)) {
    const cleaned = match[0].replace(/^[./-]+|[./-]+$/g, "");
    candidates.add(cleaned);
    const segments = cleaned.split("/").map((s) => s.replace(/^[.-]+|[.-]+$/g, "")).filter(Boolean);
    for (let i = 0; i < segments.length; i += 1) {
      candidates.add(segments[i]);
      if (i + 1 < segments.length) {
        candidates.add(`${segments[i]}/${segments[i + 1]}`);
      }
    }
  }
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9_.-]*[a-z0-9]/g)) {
    candidates.add(match[0]);
  }
  const hits = [];
  for (const token of candidates) {
    if (blockedHashes.has(sha256(token))) hits.push(token);
  }
  return hits;
}

async function listInspectableFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...(await listInspectableFiles(join(dir, entry.name))));
    } else if (entry.isFile() && !BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(join(dir, entry.name));
    }
  }
  return out.sort();
}

test("token scanner detects hashed forbidden slugs and filenames without false negatives", () => {
  const syntheticBlocked = new Set([
    sha256("acme-private/secret-core"),
    sha256("internal-vault.db"),
  ]);
  assert.deepEqual(findForbiddenTokens("Public docs for @github/copilot-sdk and $COPILOT_HOME.", syntheticBlocked), []);
  assert.deepEqual(
    findForbiddenTokens("See https://github.com/Acme-Private/Secret-Core/blob/main/src/main.rs and internal-vault.db.", syntheticBlocked).sort(),
    ["acme-private/secret-core", "internal-vault.db"],
  );
});

test("all authored skill, runtime, test, eval, and catalog files contain zero private-repo or internal DB tokens", async () => {
  const files = await listInspectableFiles(SKILL_ROOT);
  files.push(join(REPO_ROOT, "site", "src", "content", "skills", "create-session-board-canvas.md"));

  const violations = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const hits = findForbiddenTokens(content);
    if (hits.length > 0) {
      violations.push(`${relative(REPO_ROOT, file)}: matched ${hits.length} forbidden token(s)`);
    }
  }
  assert.deepEqual(violations, []);
});
