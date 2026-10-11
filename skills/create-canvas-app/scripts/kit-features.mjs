import { readFile } from "node:fs/promises";
import { join } from "node:path";
import LUCIDE, { aliases as LUCIDE_ALIASES } from "../kit/vendor/lucide.mjs";
import { KIT_VERSION } from "../kit/version.mjs";

export const FEATURE_MANIFEST = ".kit-features.json";

const MANIFEST_KEYS = ["features", "files", "icons", "kitVersion"];

function sortedUnique(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(values)].sort();
}

export function createFeatureManifest({ features, files, icons }) {
  const manifest = {
    kitVersion: KIT_VERSION,
    features: sortedUnique(features, "features"),
    files: sortedUnique(files, "files"),
    icons: sortedUnique(icons, "icons"),
  };
  assertFeatureManifest(manifest);
  return manifest;
}

export function assertFeatureManifest(manifest, { allowVersionMismatch = false } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${FEATURE_MANIFEST} must contain an object`);
  }
  const keys = Object.keys(manifest).sort();
  if (JSON.stringify(keys) !== JSON.stringify(MANIFEST_KEYS)) {
    throw new Error(`${FEATURE_MANIFEST} must contain exactly: ${MANIFEST_KEYS.join(", ")}`);
  }
  if (!allowVersionMismatch && manifest.kitVersion !== KIT_VERSION) {
    throw new Error(
      `${FEATURE_MANIFEST} kitVersion ${JSON.stringify(manifest.kitVersion)} does not match ${JSON.stringify(KIT_VERSION)}`
    );
  }
  for (const key of ["features", "files", "icons"]) {
    const sorted = sortedUnique(manifest[key], key);
    if (JSON.stringify(sorted) !== JSON.stringify(manifest[key])) {
      throw new Error(`${FEATURE_MANIFEST} ${key} must be sorted and unique`);
    }
    for (const file of manifest.files) {
      if (
        file.startsWith("/") ||
        file.startsWith("\\") ||
        file.includes("\\") ||
        file.split("/").includes("..")
      ) {
        throw new Error(`${FEATURE_MANIFEST} contains an unsafe file path: ${file}`);
      }
    }
  }
  for (const name of manifest.icons) {
    if (!Object.hasOwn(LUCIDE, name) && !Object.hasOwn(LUCIDE_ALIASES, name)) {
      throw new Error(`${FEATURE_MANIFEST} references unknown icon: ${name}`);
    }
  }
  if (manifest.icons.length > 0 && !manifest.files.includes("vendor/lucide.mjs")) {
    throw new Error(`${FEATURE_MANIFEST} icons require vendor/lucide.mjs`);
  }
  return manifest;
}

export async function readFeatureManifest(canvasKitDir, options) {
  let raw;
  try {
    raw = await readFile(join(canvasKitDir, FEATURE_MANIFEST), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return assertFeatureManifest(JSON.parse(raw), options);
  } catch (error) {
    throw new Error(`invalid ${FEATURE_MANIFEST}: ${error.message}`);
  }
}

export function renderFeatureManifest(manifest) {
  return JSON.stringify(assertFeatureManifest(manifest), null, 2) + "\n";
}

export function renderIconSubset(iconNames) {
  const requested = sortedUnique(iconNames, "icons");
  const icons = {};
  const aliases = {};
  for (const name of requested) {
    const canonical = Object.hasOwn(LUCIDE, name) ? name : LUCIDE_ALIASES[name];
    icons[canonical] = LUCIDE[canonical];
    if (canonical !== name) aliases[name] = canonical;
  }
  const orderedIcons = Object.fromEntries(Object.entries(icons).sort(([a], [b]) => a.localeCompare(b)));
  const orderedAliases = Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)));
  return (
    "// AUTO-GENERATED. Do not edit by hand.\n" +
    "// Feature-scoped Lucide icon subset from the canonical Canvas Kit vendor file.\n" +
    "export default " + JSON.stringify(orderedIcons) + ";\n" +
    "export const aliases = " + JSON.stringify(orderedAliases) + ";\n"
  );
}

export function assertSizeBudget(template, actualBytes, allowedBytes) {
  if (!Number.isSafeInteger(actualBytes) || actualBytes < 0) {
    throw new Error("actualBytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(allowedBytes) || allowedBytes < 0) {
    throw new Error("allowedBytes must be a non-negative safe integer");
  }
  if (actualBytes > allowedBytes) {
    throw new Error(
      `${template} template size budget exceeded: actual ${actualBytes} bytes, allowed ${allowedBytes} bytes`
    );
  }
}
