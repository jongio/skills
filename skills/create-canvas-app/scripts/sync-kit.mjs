// scripts/sync-kit.mjs — copy the canonical kit/ into a consumer extension as
// canvas-kit/, and stamp which kit version was written.
//
// Generated extensions carry .kit-features.json, so synchronization preserves
// their selected canonical files and exact icon subset. Older consumers without
// that manifest remain full-kit mirrors. The freshness command validates either
// shape offline.
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

import { copyFile, mkdir, writeFile, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_VERSION } from "../kit/version.mjs";
import {
  FEATURE_MANIFEST,
  createFeatureManifest,
  readFeatureManifest,
  renderFeatureManifest,
  renderIconSubset,
} from "./kit-features.mjs";

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
async function pruneToFiles(dest, files) {
  const keep = new Set(files);
  const emptyDirs = [];
  async function walk(d) {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(abs);
        emptyDirs.push(abs); // deepest-first (children pushed before parents)
      } else {
        const rel = relative(dest, abs).replace(/\\/g, "/");
        if (rel !== VERSION_MARKER && rel !== FEATURE_MANIFEST && !keep.has(rel)) {
          await rm(abs, { force: true });
        }
      }
    }
  }
  await walk(dest);
  for (const d of emptyDirs) {
    await rmdir(d).catch(() => {}); // ENOTEMPTY for dirs that still hold kit files
  }
}

async function copySelectedFiles(dest, files, icons) {
  for (const rel of files) {
    const output = join(dest, rel);
    await mkdir(dirname(output), { recursive: true });
    if (rel === "vendor/lucide.mjs" && icons !== null) {
      await writeFile(output, renderIconSubset(icons), "utf8");
    } else {
      await copyFile(join(KIT, rel), output);
    }
  }
}

export async function syncKit(dir, selection = null) {
  const dest = resolveDest(dir);
  await mkdir(dest, { recursive: true });
  const existingManifest = selection
    ? null
    : await readFeatureManifest(dest, { allowVersionMismatch: true });
  const manifest = selection
    ? createFeatureManifest(selection)
    : existingManifest
      ? createFeatureManifest(existingManifest)
      : null;
  const files = manifest ? manifest.files : await relFiles(KIT);

  await copySelectedFiles(dest, files, manifest?.icons ?? null);
  await pruneToFiles(dest, files);
  if (manifest) {
    await writeFile(join(dest, FEATURE_MANIFEST), renderFeatureManifest(manifest), "utf8");
  } else {
    await rm(join(dest, FEATURE_MANIFEST), { force: true });
  }

  const marker = {
    version: KIT_VERSION,
    syncedAt: new Date().toISOString(),
    source: "create-canvas-app/kit",
  };
  await writeFile(join(dest, VERSION_MARKER), JSON.stringify(marker, null, 2) + "\n", "utf8");
  return { dest, version: KIT_VERSION, manifest };
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
