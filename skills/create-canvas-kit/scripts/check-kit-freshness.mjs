// scripts/check-kit-freshness.mjs — OFFLINE parity/freshness gate for vendored
// kits. Point it at a directory that holds one or more extensions (or a single
// extension / canvas-kit dir) and it fails if any vendored canvas-kit/ has
// drifted from the canonical kit/ — by file set, by file contents, or by the
// recorded version.
//
// Intended for CI: a consumer repo vendors the kit, then runs
//   node scripts/check-kit-freshness.mjs .github/extensions
// to guarantee nobody hand-edited the kit or forgot to re-sync after a bump.
//
// Usage:
//   node scripts/check-kit-freshness.mjs <dir>
//
// Exit code 0 = all vendored kits fresh; 1 = drift found (or bad usage).

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, isAbsolute, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_VERSION } from "../kit/version.mjs";
import { VERSION_MARKER } from "./sync-kit.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KIT = join(ROOT, "kit");

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(abs)));
    else out.push(abs);
  }
  return out.sort();
}

// Relative POSIX-style file list for a dir (so comparisons are OS-agnostic).
async function relFiles(dir) {
  return (await walk(dir)).map((p) => relative(dir, p).replace(/\\/g, "/")).sort();
}

// Find every vendored canvas-kit/ to check, given a root the user passed in.
async function findVendoredKits(root) {
  if (basename(root) === "canvas-kit" && (await isDir(root))) return [root];
  if (await isDir(join(root, "canvas-kit"))) return [join(root, "canvas-kit")];

  const found = [];
  if (!(await isDir(root))) return found;
  for (const ent of await readdir(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const candidate = join(root, ent.name, "canvas-kit");
    if (await isDir(candidate)) found.push(candidate);
  }
  return found.sort();
}

/**
 * Compare one vendored canvas-kit/ against the canonical kit/.
 * @returns {Promise<{dir:string, problems:string[]}>}
 */
export async function checkOne(canvasKitDir, kitDir = KIT) {
  const problems = [];

  const kitFiles = await relFiles(kitDir);
  const vendoredFiles = (await relFiles(canvasKitDir)).filter((f) => f !== VERSION_MARKER);

  const kitSet = new Set(kitFiles);
  const vendoredSet = new Set(vendoredFiles);

  for (const f of kitFiles) {
    if (!vendoredSet.has(f)) {
      problems.push(`missing file: ${f}`);
      continue;
    }
    const [a, b] = await Promise.all([
      readFile(join(kitDir, f)),
      readFile(join(canvasKitDir, f)),
    ]);
    if (!a.equals(b)) problems.push(`content differs: ${f}`);
  }
  for (const f of vendoredFiles) {
    if (!kitSet.has(f)) problems.push(`unexpected extra file: ${f}`);
  }

  // Version marker — distinguish a genuinely absent file from a corrupt one.
  let raw = null;
  try {
    raw = await readFile(join(canvasKitDir, VERSION_MARKER), "utf8");
  } catch {
    problems.push(`missing ${VERSION_MARKER} (run scripts/sync-kit.mjs)`);
  }
  if (raw != null) {
    let marker = null;
    try {
      marker = JSON.parse(raw);
    } catch {
      problems.push(`invalid ${VERSION_MARKER} (corrupt JSON; run scripts/sync-kit.mjs)`);
    }
    if (marker && marker.version !== KIT_VERSION) {
      problems.push(`version drift: recorded ${JSON.stringify(marker.version)}, expected ${JSON.stringify(KIT_VERSION)}`);
    }
  }

  return { dir: canvasKitDir, problems };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "Usage: node scripts/check-kit-freshness.mjs <dir>\n" +
        "  <dir> may be an extensions parent dir, a single extension dir, or a canvas-kit dir."
    );
    process.exit(1);
  }

  const root = isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  if (!(await isDir(root))) {
    console.error(`check-kit-freshness: path not found or not a directory: ${root}`);
    process.exit(1);
  }
  const kits = await findVendoredKits(root);

  if (kits.length === 0) {
    console.log(`No vendored canvas-kit/ found under ${root} — nothing to check.`);
    process.exit(0);
  }

  let drifted = 0;
  for (const dir of kits) {
    const { problems } = await checkOne(dir);
    if (problems.length === 0) {
      console.log(`  ok    ${dir} (kit ${KIT_VERSION})`);
    } else {
      drifted++;
      console.error(`  DRIFT ${dir}`);
      for (const p of problems) console.error(`        - ${p}`);
    }
  }

  if (drifted > 0) {
    console.error(`\n${drifted} vendored kit(s) drifted from kit/ ${KIT_VERSION}. Run: node scripts/sync-kit.mjs <dir>`);
    process.exit(1);
  }
  console.log(`\nAll ${kits.length} vendored kit(s) are fresh (kit ${KIT_VERSION}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
