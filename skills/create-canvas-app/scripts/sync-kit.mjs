// scripts/sync-kit.mjs — copy the canonical kit/ into a consumer extension as
// canvas-kit/, and stamp which kit version was written.
//
// A shipped/generated extension vendors the kit verbatim (no npm, no build), so
// once it's copied there's nothing that tells you whether the copy is current.
// Run this after bumping kit/version.mjs (or any kit file) to refresh a vendored
// copy, then `node scripts/check-kit-freshness.mjs <dir>` in CI catches drift.
//
// Usage:
//   node scripts/sync-kit.mjs <extension-dir>
//
//   <extension-dir>  the extension folder; the kit is written to
//                    <extension-dir>/canvas-kit/. If the path already ends in
//                    "canvas-kit", it is used directly.
//
// Examples:
//   node scripts/sync-kit.mjs .github/extensions/market-feed
//   node scripts/sync-kit.mjs reference/decision-log

import { cp, mkdir, writeFile, readdir, rm, rmdir } from "node:fs/promises";
import { join, resolve, isAbsolute, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_VERSION } from "../kit/version.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KIT = join(ROOT, "kit");

// Metadata marker sync writes alongside the vendored kit. It is intentionally
// NOT part of the kit itself (kit/ has no such file), so the freshness check and
// the parity test treat it as out-of-band metadata, not a kit file.
export const VERSION_MARKER = ".kit-version.json";

function parseArgs(argv) {
  return { _: argv.filter((a) => !a.startsWith("--")) };
}

function resolveDest(dir) {
  const abs = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  return basename(abs) === "canvas-kit" ? abs : join(abs, "canvas-kit");
}

// Relative POSIX-style file list under a dir.
async function relFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      if (ent.isDirectory()) await walk(abs);
      else out.push(relative(dir, abs).replace(/\\/g, "/"));
    }
  }
  await walk(dir);
  return out;
}

// Make `dest` an EXACT mirror of kit/ (plus the version marker): remove any file
// that isn't in the canonical kit, then drop the now-empty directories. Without
// this, a file removed upstream would linger in a re-synced copy and trip the
// freshness check with no way to repair it via sync.
async function pruneToKit(dest) {
  const keep = new Set(await relFiles(KIT));
  const emptyDirs = [];
  async function walk(d) {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(abs);
        emptyDirs.push(abs); // deepest-first (children pushed before parents)
      } else {
        const rel = relative(dest, abs).replace(/\\/g, "/");
        if (rel !== VERSION_MARKER && !keep.has(rel)) await rm(abs, { force: true });
      }
    }
  }
  await walk(dest);
  for (const d of emptyDirs) {
    await rmdir(d).catch(() => {}); // ENOTEMPTY for dirs that still hold kit files
  }
}

export async function syncKit(dir) {
  const dest = resolveDest(dir);
  // Copy every canonical kit file over (vendor/ included), then prune stale extras
  // so the vendored copy is an exact mirror of kit/ plus the version marker.
  await mkdir(dest, { recursive: true });
  await cp(KIT, dest, { recursive: true, force: true });
  await pruneToKit(dest);

  const marker = {
    version: KIT_VERSION,
    syncedAt: new Date().toISOString(),
    source: "create-canvas-app/kit",
  };
  await writeFile(join(dest, VERSION_MARKER), JSON.stringify(marker, null, 2) + "\n", "utf8");
  return { dest, version: KIT_VERSION };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args._[0];
  if (!dir) {
    console.error(
      "Usage: node scripts/sync-kit.mjs <extension-dir>\n" +
        "  Copies kit/ into <extension-dir>/canvas-kit/ and records the kit version."
    );
    process.exit(1);
  }

  const { dest, version } = await syncKit(dir);
  console.log(`Synced kit ${version} -> ${dest}`);
  console.log(`Wrote ${join(dest, VERSION_MARKER)}`);
}

// Only run the CLI when invoked directly (not when imported by a test/tool).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
