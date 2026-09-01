import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CONFIG_FILE = "skills-repo.config.json";

const DEFAULT_PATHS = Object.freeze({
  skills: "skills",
  readme: "README.md",
  marketplace: "marketplace.json",
  plugin: "plugin.json",
  vallyLock: ".github/tools/vally/package-lock.json",
  evalWorkflow: ".github/workflows/skill-eval.yml",
  dependabot: ".github/dependabot.yml",
  catalogEntries: "site/src/content/skills",
  catalogImages: "site/public/images",
  thumbnailPrompts: "docs/thumbnail-prompts.md",
});

const CONFIG_KEYS = new Set([
  "schemaVersion",
  "templateVersion",
  "owner",
  "repository",
  "package",
  "catalog",
  "github",
]);
const IDENTIFIER = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_.-])?$/;
const VISIBILITIES = new Set(["public", "private", "internal"]);

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unsupported fields: ${unknown.sort().join(", ")}`);
  }
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new Error(`${label} is missing fields: ${missing.sort().join(", ")}`);
  }
}

function assertText(value, label, maximum, pattern) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.normalize("NFC") ||
    /[\u0000-\u001f\u007f\u2013\u2014]/.test(value) ||
    value.endsWith(" ") ||
    (pattern && !pattern.test(value))
  ) {
    throw new Error(`${label} has an invalid value`);
  }
  return value;
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function normalizeRepositoryPath(root, value, label) {
  if (typeof value !== "string" || value.trim() === "" || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const path = resolve(root, value);
  if (!inside(root, path)) throw new Error(`${label} escapes the repository root`);
  return path;
}

export function validateManagedConfig(config, root) {
  assertExactKeys(config, CONFIG_KEYS, CONFIG_FILE);
  if (config.schemaVersion !== 1 || config.templateVersion !== 1) {
    throw new Error(`${CONFIG_FILE} schemaVersion and templateVersion must be 1`);
  }
  assertExactKeys(config.owner, new Set(["login", "name", "url"]), "owner");
  const ownerLogin = assertText(config.owner.login, "owner.login", 39, GITHUB_LOGIN);
  const ownerName = assertText(config.owner.name, "owner.name", 80);
  const ownerUrl = `https://github.com/${ownerLogin}`;
  if (config.owner.url !== ownerUrl) throw new Error(`owner.url must be ${ownerUrl}`);

  assertExactKeys(
    config.repository,
    new Set(["name", "url", "visibility"]),
    "repository",
  );
  const repositoryName = assertText(
    config.repository.name,
    "repository.name",
    100,
    REPOSITORY_NAME,
  );
  const repositoryUrl = `${ownerUrl}/${repositoryName}`;
  if (config.repository.url !== repositoryUrl) {
    throw new Error(`repository.url must be ${repositoryUrl}`);
  }
  if (!VISIBILITIES.has(config.repository.visibility)) {
    throw new Error("repository.visibility has an invalid value");
  }

  assertExactKeys(
    config.package,
    new Set(["name", "displayName", "description", "version"]),
    "package",
  );
  assertText(config.package.name, "package.name", 64, IDENTIFIER);
  assertText(config.package.displayName, "package.displayName", 80);
  assertText(config.package.description, "package.description", 240);
  if (config.package.version !== "1.0.0") throw new Error("package.version must be 1.0.0");

  assertExactKeys(config.catalog, new Set(["enabled", "template"]), "catalog");
  if (typeof config.catalog.enabled !== "boolean") {
    throw new Error("catalog.enabled must be a boolean");
  }
  if (config.catalog.template !== "skills-catalog") {
    throw new Error("catalog.template must be skills-catalog");
  }
  assertExactKeys(config.github, new Set(["defaultBranch"]), "github");
  assertText(config.github.defaultBranch, "github.defaultBranch", 64, IDENTIFIER);

  const paths = {};
  for (const [key, value] of Object.entries(DEFAULT_PATHS)) {
    paths[key] = normalizeRepositoryPath(root, value, key);
  }
  const required = [
    "skills",
    "readme",
    "marketplace",
    "plugin",
    "vallyLock",
    "evalWorkflow",
    "dependabot",
  ];
  const missing = required.filter((key) => !existsSync(paths[key]));
  if (missing.length > 0) {
    throw new Error(`Managed repository is missing paths: ${missing.join(", ")}`);
  }
  if (!config.catalog.enabled) {
    paths.catalogEntries = null;
    paths.catalogImages = null;
    paths.thumbnailPrompts = null;
  } else if (!existsSync(paths.catalogEntries) || !existsSync(paths.catalogImages)) {
    throw new Error("Managed catalog is enabled but its entry or image directory is missing");
  }
  if (paths.thumbnailPrompts && !existsSync(paths.thumbnailPrompts)) {
    paths.thumbnailPrompts = null;
  }
  return Object.freeze({
    mode: "managed",
    root,
    configPath: join(root, CONFIG_FILE),
    paths: Object.freeze(paths),
    catalogEnabled: config.catalog.enabled,
    identity: Object.freeze({
      ownerName,
      repository: `${ownerLogin}/${repositoryName}`,
    }),
  });
}

function findUp(start, predicate, stop = null) {
  let current = resolve(start);
  while (true) {
    if (predicate(current)) return current;
    if (stop && current === stop) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findNamedDirectories(root, name, maxDepth = 4, depth = 0) {
  if (depth > maxDepth) return [];
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "vendor") continue;
    const path = join(root, entry.name);
    if (entry.name === name) found.push(path);
    else found.push(...findNamedDirectories(path, name, maxDepth, depth + 1));
  }
  return found;
}

export function discoverConventions(root) {
  const skillsCandidates = findNamedDirectories(root, "skills", 3).filter((path) =>
    readdirSync(path, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(path, entry.name, "SKILL.md")),
    ),
  );
  if (skillsCandidates.length !== 1) {
    throw new Error(
      `Convention discovery requires exactly one populated skills directory; found ${skillsCandidates.length}`,
    );
  }

  const paths = { skills: skillsCandidates[0] };
  for (const [key, rel] of Object.entries(DEFAULT_PATHS)) {
    if (key === "skills") continue;
    const candidate = join(root, rel);
    paths[key] = existsSync(candidate) ? candidate : null;
  }

  const ambiguous = [];
  const marketplaceCandidates = findNamedDirectories(root, "plugins", 3);
  if (!paths.marketplace && marketplaceCandidates.length > 1) {
    ambiguous.push("marketplace registration");
  }
  if ((paths.catalogEntries && !paths.catalogImages) || (!paths.catalogEntries && paths.catalogImages)) {
    ambiguous.push("catalog entry and image directories");
  }
  if (ambiguous.length > 0) {
    throw new Error(`Ambiguous registration surfaces: ${ambiguous.join(", ")}`);
  }
  let identity = { ownerName: "Repository contributors", repository: null };
  if (paths.plugin) {
    try {
      const plugin = JSON.parse(readFileSync(paths.plugin, "utf8"));
      const match = plugin.repository?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/);
      if (match) {
        if (!GITHUB_LOGIN.test(match[1]) || !REPOSITORY_NAME.test(match[2])) {
          throw new Error("Existing plugin.json repository must contain a valid GitHub owner and repository");
        }
        identity = {
          ownerName: plugin.author?.name ?? "Repository contributors",
          repository: `${match[1]}/${match[2]}`,
        };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error("Existing plugin.json is not valid JSON");
    }
  }
  if (paths.catalogEntries && !identity.repository) {
    throw new Error("Catalog registration is ambiguous without a GitHub repository identity");
  }
  return Object.freeze({
    mode: "discovered",
    root,
    configPath: null,
    paths: Object.freeze(paths),
    catalogEnabled: paths.catalogEntries !== null,
    identity: Object.freeze(identity),
  });
}

export function discoverRepository(start = process.cwd()) {
  const gitRoot = findUp(start, (dir) => existsSync(join(dir, ".git")));
  const configRoot = findUp(
    start,
    (dir) => existsSync(join(dir, CONFIG_FILE)),
    gitRoot,
  );
  if (configRoot) {
    const configPath = join(configRoot, CONFIG_FILE);
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot parse ${configPath}: ${error.message}`);
    }
    return validateManagedConfig(config, configRoot);
  }

  const root = gitRoot ?? findUp(
    start,
    (dir) => existsSync(join(dir, "skills")),
  );
  if (!root || !statSync(root).isDirectory()) {
    throw new Error(`No ${CONFIG_FILE} or existing skills repository found`);
  }
  return discoverConventions(root);
}
