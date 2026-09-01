import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SKILL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CANONICAL_ROOT = path.resolve(SKILL_ROOT, "..", "create-skill");
const SNAPSHOT_ROOT = path.join(
  SKILL_ROOT,
  "templates",
  "repository",
  "skills",
  "create-skill",
);
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "vally-results"]);

async function listFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

test("bundled create-skill snapshot matches the canonical published skill", async () => {
  const [canonicalFiles, snapshotFiles] = await Promise.all([
    listFiles(CANONICAL_ROOT),
    listFiles(SNAPSHOT_ROOT),
  ]);
  assert.deepEqual(snapshotFiles, canonicalFiles);

  for (const relativePath of canonicalFiles) {
    const [canonical, snapshot] = await Promise.all([
      readFile(path.join(CANONICAL_ROOT, relativePath)),
      readFile(path.join(SNAPSHOT_ROOT, relativePath)),
    ]);
    assert.ok(snapshot.equals(canonical), `${relativePath} differs from canonical`);
  }
});
