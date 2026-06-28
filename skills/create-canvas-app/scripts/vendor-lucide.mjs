// scripts/vendor-lucide.mjs — regenerate kit/vendor/lucide.mjs from a pinned
// lucide-react release, byte-faithfully.
//
// kit/vendor/lucide.mjs is AUTO-GENERATED: it mirrors the exact icon geometry of
// the lucide-react version the Copilot host app ships, so a canvas renders the
// same glyphs the host does. This script reproduces that file deterministically
// from an installed lucide-react package — no hand-editing, no drift. Run it when
// the host bumps its Lucide version, then re-sync vendored copies and bump
// kit/version.mjs.
//
// Usage:
//   node scripts/vendor-lucide.mjs <version> [--icons-dir <path>] [--out <path>]
//
//   <version>        lucide-react version to stamp + install (e.g. 1.21.0).
//   --icons-dir <p>  read icons from an existing install's dist/esm/icons dir
//                    instead of installing. The <version> is still used for the
//                    stamped header, so pass the version that <p> was built from.
//   --out <p>        output file (default: kit/vendor/lucide.mjs).
//
// Examples:
//   node scripts/vendor-lucide.mjs 1.21.0
//   node scripts/vendor-lucide.mjs 1.21.0 --icons-dir /tmp/lr/node_modules/lucide-react/dist/esm/icons

import { readdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_OUT = join(ROOT, "kit", "vendor", "lucide.mjs");

// Read every icon module under an esm/icons dir and build the vendored shape:
//   icons:   name -> iconNode array of [tag, attrs] (the lucide `key` stripped,
//            source attr order preserved), canonical names sorted.
//   aliases: deprecated/alternate name -> canonical name, sorted by alias.
// This mirrors the lucide-react package layout: a canonical icon module defines
// `__iconNode`; an alias module simply re-exports `from './<canonical>.mjs'`.
export async function generateIconData(iconsDir) {
  const files = (await readdir(iconsDir)).filter((f) => f.endsWith(".mjs") && !f.endsWith(".mjs.map"));

  const icons = {};
  const aliasPairs = [];

  for (const f of files) {
    const name = f.replace(/\.mjs$/, "");
    const src = await readFile(join(iconsDir, f), "utf8");
    if (src.includes("__iconNode")) {
      const mod = await import(pathToFileURL(join(iconsDir, f)).href);
      if (mod.__iconNode) {
        icons[name] = mod.__iconNode.map(([tag, attrs]) => {
          const { key, ...rest } = attrs || {};
          return [tag, rest];
        });
      }
    } else if (name !== "index") {
      // index.mjs is the barrel; everything else here is an alias re-export.
      const m = src.match(/from '\.\/([a-z0-9-]+)\.mjs'/);
      if (m) aliasPairs.push([name, m[1]]);
    }
  }

  const orderedIcons = {};
  for (const n of Object.keys(icons).sort()) orderedIcons[n] = icons[n];

  const aliases = {};
  for (const [alias, canon] of aliasPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    aliases[alias] = canon;
  }

  return { icons: orderedIcons, aliases };
}

// Render the exact on-disk form of kit/vendor/lucide.mjs (compact JSON, trailing
// newline). The header wording is fixed; only the version string varies.
export function renderVendorFile({ icons, aliases }, version) {
  const header =
    "// AUTO-GENERATED. Do not edit by hand.\n" +
    `// Vendored Lucide icon geometry from lucide-react@${version} (ISC license),\n` +
    "// the same icon set and version used by github-app (src/lib/icons.tsx).\n" +
    "// Each entry: name -> iconNode array of [tag, attrs] on a 0 0 24 24 viewBox.\n" +
    "// `aliases` maps deprecated/alternate names to their canonical icon name.\n";
  return (
    header +
    "export default " + JSON.stringify(icons) + ";\n" +
    "export const aliases = " + JSON.stringify(aliases) + ";\n"
  );
}

// Verify every alias points at a real canonical icon. A dangling alias would make
// the kit resolve a name the host can't, so fail loudly rather than ship it.
function assertAliasIntegrity({ icons, aliases }) {
  const missing = Object.entries(aliases).filter(([, canon]) => !(canon in icons));
  if (missing.length) {
    throw new Error(
      `alias(es) point at missing icons: ${missing.map(([a, c]) => `${a}->${c}`).join(", ")}`
    );
  }
}

function parseArgs(argv) {
  const out = { _: [], iconsDir: null, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--icons-dir") out.iconsDir = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (!a.startsWith("--")) out._.push(a);
  }
  return out;
}

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

// Running npm.cmd on Windows requires shell:true, so the version is validated to a
// strict semver charset before it ever reaches the shell — no spaces or shell
// metacharacters can slip into the install command.
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/;
export function assertSafeVersion(version) {
  if (!VERSION_RE.test(version)) {
    throw new Error(`invalid lucide-react version "${version}" (expected e.g. 1.21.0 or 1.21.0-beta.1)`);
  }
}

// Install lucide-react@<version> into a throwaway dir and return its esm/icons
// path. Used when --icons-dir isn't supplied so the common case is one command.
async function installLucide(version) {
  assertSafeVersion(version);
  const dir = await mkdtemp(join(tmpdir(), "vendor-lucide-"));
  // shell:true is required to launch npm.cmd on Windows (Node refuses to spawn
  // .cmd without a shell). Under a shell, Node concatenates args without quoting,
  // so a temp path containing a space would be split. Quote the one dynamic path
  // arg ourselves; `version` is already charset-validated by assertSafeVersion.
  const useShell = process.platform === "win32";
  const prefixArg = useShell ? `"${dir}"` : dir;
  const res = spawnSync(
    npmCmd(),
    ["install", "--no-audit", "--no-fund", "--no-save", "--prefix", prefixArg, `lucide-react@${version}`],
    { encoding: "utf8", shell: useShell }
  );
  if (res.status !== 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    const detail = res.error?.message || res.stderr || res.stdout || `exited with code ${res.status}`;
    throw new Error(`npm install lucide-react@${version} failed:\n${detail}`);
  }
  return { dir, iconsDir: join(dir, "node_modules", "lucide-react", "dist", "esm", "icons") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args._[0];
  if (!version) {
    console.error(
      "Usage: node scripts/vendor-lucide.mjs <version> [--icons-dir <path>] [--out <path>]\n" +
        "  Regenerates kit/vendor/lucide.mjs from lucide-react@<version>."
    );
    process.exit(1);
  }

  const outFile = isAbsolute(args.out) ? args.out : resolve(process.cwd(), args.out);

  let iconsDir = args.iconsDir;
  let tempDir = null;
  try {
    if (!iconsDir) {
      console.log(`Installing lucide-react@${version} (temp)…`);
      const installed = await installLucide(version);
      iconsDir = installed.iconsDir;
      tempDir = installed.dir;
    }

    const data = await generateIconData(iconsDir);
    assertAliasIntegrity(data);
    const source = renderVendorFile(data, version);
    await writeFile(outFile, source, "utf8");

    const iconCount = Object.keys(data.icons).length;
    const aliasCount = Object.keys(data.aliases).length;
    console.log(`Wrote ${outFile}: ${iconCount} icons, ${aliasCount} aliases (lucide-react@${version})`);
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Only run the CLI when invoked directly (not when imported by a test/tool).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
