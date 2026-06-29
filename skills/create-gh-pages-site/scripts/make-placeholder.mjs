#!/usr/bin/env node
// make-placeholder.mjs — generate obviously-placeholder image assets the user
// swaps out later, plus an IMAGES.md checklist telling them exactly what to drop
// in (path, purpose, dimensions).
//
//   node scripts/make-placeholder.mjs --out <dir> [--preset site|cli|library|app|collection]
//   node scripts/make-placeholder.mjs --out public/images --label "Hero" --width 1200 --height 630 --file hero.svg
//
// Placeholders are SVG (crisp at any size, tiny, no binary) with a dashed border,
// a label, and the target dimensions printed on them — so nobody mistakes one for
// final art. The IMAGES.md manifest is the hand-off contract: each row is a real
// file the site references and the user is expected to replace.
//
// No dependencies — runs on bare node 18+.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// What images a site of each repo type typically needs. width × height in px.
// `ref` documents where the stamped site references the file.
export const PRESETS = {
  common: [
    { file: "logo.svg", label: "Logo", width: 512, height: 512, purpose: "Site logo / wordmark (top bar, hero)." },
    { file: "og.svg", label: "Social card", width: 1200, height: 630, purpose: "Open Graph / Twitter share image. Replace with a raster og.png (scrapers ignore SVG) and update the meta tag." },
    { file: "favicon.svg", label: "Favicon", width: 64, height: 64, purpose: "Browser tab icon." },
  ],
  cli: [
    { file: "hero-terminal.svg", label: "Terminal demo", width: 1280, height: 720, purpose: "Screenshot/GIF of the CLI in action (hero)." },
  ],
  library: [
    { file: "hero-diagram.svg", label: "Diagram", width: 1280, height: 720, purpose: "Architecture / how-it-works diagram (hero)." },
  ],
  app: [
    { file: "hero-screenshot.svg", label: "App screenshot", width: 1600, height: 1000, purpose: "Product screenshot of the running app (hero)." },
    { file: "feature-1.svg", label: "Feature 1", width: 800, height: 500, purpose: "Feature highlight screenshot." },
  ],
  collection: [
    { file: "hero.svg", label: "Hero", width: 1280, height: 640, purpose: "Hero banner for the landing page." },
    { file: "item-thumb.svg", label: "Item thumbnail", width: 640, height: 400, purpose: "Per-item card thumbnail (duplicate per item)." },
  ],
  site: [
    { file: "hero.svg", label: "Hero", width: 1280, height: 640, purpose: "Hero banner for the landing page." },
  ],
};

/** Resolve a preset name into the list of needed images (common + type-specific). */
export function imagesForPreset(preset = "site") {
  const extra = PRESETS[preset] || PRESETS.site;
  return [...PRESETS.common, ...extra];
}

/** Render a labeled placeholder SVG at the given dimensions. */
export function placeholderSvg({ label = "Placeholder", width = 1200, height = 630 } = {}) {
  const w = Math.max(16, Math.round(width));
  const h = Math.max(16, Math.round(height));
  const fontSize = Math.max(12, Math.round(Math.min(w, h) / 12));
  const sub = `${w}×${h}`;
  const safe = String(label).replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" }[c]));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${safe} placeholder ${sub}">
  <rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="${Math.min(24, Math.round(Math.min(w, h) / 16))}" fill="#0d1117" stroke="#30363d" stroke-width="2" stroke-dasharray="10 8"/>
  <g fill="#9198a1" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif" text-anchor="middle">
    <text x="50%" y="50%" dy="-0.2em" font-size="${fontSize}" font-weight="700" fill="#e6edf3">${safe}</text>
    <text x="50%" y="50%" dy="1.4em" font-size="${Math.round(fontSize * 0.7)}">placeholder · ${sub} · replace me</text>
  </g>
</svg>
`;
}

/** Build the IMAGES.md manifest body from a list of image specs. */
export function imagesManifest(images, { dir = "public/images", repo = "your repo" } = {}) {
  const rows = images
    .map((i) => `| \`${i.file}\` | ${i.purpose} | ${i.width}×${i.height} |`)
    .join("\n");
  return `# Images to supply

These are **placeholders**. Replace each file in \`${dir}/\` with real art for
${repo}. Keep the same filename (or update the reference in the site) and aim for
the listed dimensions. Delete this file once every image is real.

| File | Purpose | Recommended size |
| --- | --- | --- |
${rows}

Tips:
- Export at 2× for crisp display on high-DPI screens, then keep the file reasonably small.
- PNG for screenshots/photos, SVG for logos/diagrams. The social card (\`og.*\`) must be a raster (PNG/JPG) — most scrapers ignore SVG.
- A placeholder left in place still deploys fine; it just looks like a placeholder.
`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--help" || x === "-h") a.help = true;
    else if (x === "--no-manifest") a.noManifest = true;
    else if (x === "--force") a.force = true;
    else if (x.startsWith("--")) a[x.slice(2)] = argv[++i];
    else a._.push(x);
  }
  return a;
}

const HELP = `make-placeholder — generate placeholder images + an IMAGES.md checklist.

Usage:
  node scripts/make-placeholder.mjs --out <dir> [--preset site|cli|library|app|collection] [--repo owner/name]
  node scripts/make-placeholder.mjs --out <dir> --file hero.svg --label "Hero" --width 1280 --height 640

Options:
  --out <dir>        Output directory (created if missing). Required.
  --preset <name>    Image set to generate (default: site). Adds common + type images.
  --repo <slug>      Used in the IMAGES.md heading.
  --file/--label/--width/--height   Generate a single custom placeholder instead of a preset.
  --no-manifest      Don't write IMAGES.md.
  --force            Overwrite existing files.
`;

function writeOne(outDir, spec, force) {
  const dest = join(outDir, spec.file);
  if (existsSync(dest) && !force) return { file: spec.file, skipped: true };
  mkdirSync(dirname(dest), { recursive: true });
  // Only SVG content is generated; an .png target still gets SVG bytes — rename or
  // replace later. We keep the requested name so references line up.
  writeFileSync(dest, placeholderSvg(spec));
  return { file: spec.file, skipped: false };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.out) { console.log(HELP); if (!args.out && !args.help) process.exit(1); return; }
  const outDir = resolve(args.out);

  let images;
  if (args.file) {
    images = [{
      file: args.file,
      label: args.label || "Placeholder",
      width: Number(args.width) || 1200,
      height: Number(args.height) || 630,
      purpose: args.purpose || "Custom image.",
    }];
  } else {
    images = imagesForPreset(args.preset || "site");
  }

  const results = images.map((spec) => writeOne(outDir, spec, args.force));
  if (!args.noManifest && !args.file) {
    const manifestPath = join(outDir, "IMAGES.md");
    if (!existsSync(manifestPath) || args.force) {
      writeFileSync(manifestPath, imagesManifest(images, { dir: args.out, repo: args.repo || "your repo" }));
    }
  }

  const wrote = results.filter((r) => !r.skipped).map((r) => r.file);
  const skipped = results.filter((r) => r.skipped).map((r) => r.file);
  console.log(`✓ placeholders in ${outDir}`);
  if (wrote.length) console.log(`  wrote:   ${wrote.join(", ")}`);
  if (skipped.length) console.log(`  skipped (exists): ${skipped.join(", ")}  — use --force to overwrite`);
  if (!args.noManifest && !args.file) console.log(`  manifest: IMAGES.md`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
