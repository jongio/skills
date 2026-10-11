import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseFrontmatterScalar(contents, field, entryPath) {
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) {
    throw new Error(`${entryPath}: missing YAML frontmatter`);
  }
  const match = frontmatter[1].match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, "m"));
  if (!match) {
    throw new Error(`${entryPath}: missing required ${field} field`);
  }
  const value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function validateRelativePath(value, label, entryPath, errors) {
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    errors.push(`${entryPath}: ${label} must be relative, received absolute path "${value}"`);
    return false;
  }
  if (value.includes("\\")) {
    errors.push(`${entryPath}: ${label} must use forward slashes, received "${value}"`);
    return false;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) {
    errors.push(`${entryPath}: ${label} must not traverse parent directories, received "${value}"`);
    return false;
  }
  if (segments.some((segment) => segment === "" || segment === ".")) {
    errors.push(`${entryPath}: ${label} is not a normalized relative path: "${value}"`);
    return false;
  }
  return true;
}

function addGroupedMappingErrors(mappings, key, describe, errors) {
  const groups = new Map();
  for (const mapping of mappings) {
    const value = mapping[key];
    if (!value) continue;
    const groupKey = value.toLowerCase();
    const group = groups.get(groupKey) ?? { value, entries: [] };
    group.entries.push(mapping);
    groups.set(groupKey, group);
  }
  for (const { value, entries } of groups.values()) {
    if (entries.length > 1) errors.push(describe(value, entries));
  }
}

export function discoverThumbnailMappings(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_ROOT);
  const catalogDir = path.resolve(
    options.catalogDir ?? path.join(repoRoot, "site", "src", "content", "skills"),
  );
  const publicDir = path.resolve(options.publicDir ?? path.join(repoRoot, "site", "public"));
  const entries = readdirSync(catalogDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const errors = [];
  const mappings = [];

  for (const entry of entries) {
    const entryPath = path.join(catalogDir, entry.name);
    const entryId = path.basename(entry.name, ".md");
    let repoPath;
    let thumb;
    try {
      const contents = readFileSync(entryPath, "utf8");
      repoPath = parseFrontmatterScalar(contents, "repoPath", entryPath);
      thumb = parseFrontmatterScalar(contents, "thumb", entryPath);
    } catch (error) {
      errors.push(error.message);
      continue;
    }

    const repoPathValid = validateRelativePath(repoPath, "repoPath", entryPath, errors);
    const thumbValid = validateRelativePath(thumb, "thumb", entryPath, errors);
    const repoSegments = repoPath.split("/");
    const skillId = repoSegments.length === 2 && repoSegments[0] === "skills"
      ? repoSegments[1]
      : null;

    if (repoPathValid && !skillId) {
      errors.push(`${entryPath}: repoPath must match "skills/<id>", received "${repoPath}"`);
    } else if (skillId && skillId !== entryId) {
      errors.push(
        `${entryPath}: catalog id "${entryId}" does not match repoPath skill id "${skillId}"`,
      );
    }
    if (thumbValid && !thumb.startsWith("images/")) {
      errors.push(`${entryPath}: thumb must be under "images/", received "${thumb}"`);
    }
    if (thumbValid && skillId && path.posix.basename(thumb) !== `thumb-${skillId}.png`) {
      errors.push(
        `${entryPath}: thumb "${thumb}" does not match skill id "${skillId}"; expected ` +
          `"images/thumb-${skillId}.png"`,
      );
    }

    const source = repoPathValid
      ? path.join(repoRoot, ...repoSegments, "thumbnail.png")
      : null;
    const destination = thumbValid ? path.resolve(publicDir, ...thumb.split("/")) : null;
    if (source && !source.startsWith(`${repoRoot}${path.sep}`)) {
      errors.push(`${entryPath}: repoPath resolves outside the repository: "${repoPath}"`);
    }
    if (destination && !destination.startsWith(`${publicDir}${path.sep}`)) {
      errors.push(`${entryPath}: thumb resolves outside site/public: "${thumb}"`);
    }
    mappings.push({ entryId, entryPath, repoPath, thumb, source, destination });
  }

  addGroupedMappingErrors(
    mappings,
    "destination",
    (destination, grouped) =>
      `Duplicate thumbnail destination "${destination}" declared by ${grouped
        .map(({ entryPath }) => entryPath)
        .join(", ")}`,
    errors,
  );
  addGroupedMappingErrors(
    mappings,
    "source",
    (source, grouped) =>
      `Conflicting catalog mappings use source "${source}" for ${grouped
        .map(({ entryPath, thumb }) => `${entryPath} -> ${thumb}`)
        .join(", ")}`,
    errors,
  );

  for (const mapping of mappings) {
    if (!mapping.source || !mapping.destination) continue;
    if (!existsSync(mapping.source)) {
      errors.push(`${mapping.entryPath}: missing thumbnail source "${mapping.source}"`);
    } else if (!lstatSync(mapping.source).isFile()) {
      errors.push(`${mapping.entryPath}: thumbnail source is not a file: "${mapping.source}"`);
    }
    if (existsSync(mapping.destination) && !lstatSync(mapping.destination).isFile()) {
      errors.push(
        `${mapping.entryPath}: thumbnail destination conflicts with a non-file path: ` +
          `"${mapping.destination}"`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Catalog thumbnail validation failed:\n- ${errors.join("\n- ")}`);
  }
  return mappings;
}

export function synchronizeThumbnails(options = {}) {
  const mappings = discoverThumbnailMappings(options);
  for (const { source, destination } of mappings) {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  return mappings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mappings = synchronizeThumbnails();
    console.log(`Synchronized ${mappings.length} catalog thumbnails.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
