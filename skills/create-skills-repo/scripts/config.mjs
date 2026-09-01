import { readFile } from "node:fs/promises";
import path from "node:path";

export const CONFIG_FILE = "skills-repo.config.json";
export const CONFIG_SCHEMA_VERSION = 1;
export const TEMPLATE_VERSION = 1;

const IDENTIFIER = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_.-])?$/;
const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const VISIBILITIES = new Set(["public", "private", "internal"]);
const CATALOG_TEMPLATES = new Set(["skills-catalog"]);
const CONFIG_KEYS = new Set([
  "schemaVersion",
  "templateVersion",
  "owner",
  "repository",
  "package",
  "catalog",
  "github",
]);

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unsupported fields: ${unknown.sort().join(", ")}.`);
  }
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new Error(`${label} is missing fields: ${missing.sort().join(", ")}.`);
  }
}

function assertText(value, label, maximum, pattern) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  if (value !== value.normalize("NFC")) {
    throw new Error(`${label} must use NFC Unicode normalization.`);
  }
  if (value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must contain between 1 and ${maximum} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  if (/[\u2013\u2014]/.test(value)) {
    throw new Error(`${label} must not contain Unicode dash punctuation.`);
  }
  if (value.endsWith(" ")) {
    throw new Error(`${label} must not end with a space.`);
  }
  if (pattern && !pattern.test(value)) {
    throw new Error(`${label} has an invalid format.`);
  }
  return value;
}

export function validateRelativeTemplatePath(value, label = "template path") {
  const text = assertText(value, label, 240);
  if (path.isAbsolute(text) || text.includes("\\") || text.startsWith("-")) {
    throw new Error(`${label} must be a normalized relative path.`);
  }
  const normalized = path.posix.normalize(text);
  if (
    normalized !== text ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some(
      (part) =>
        RESERVED_WINDOWS_NAMES.test(part) ||
        part.endsWith(".") ||
        part.endsWith(" "),
    )
  ) {
    throw new Error(`${label} must stay inside the repository.`);
  }
  return normalized;
}

export function validateTargetPath(value) {
  const text = assertText(value, "target path", 1024);
  const resolved = path.resolve(text);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    throw new Error("target path must not be a filesystem root.");
  }
  if (RESERVED_WINDOWS_NAMES.test(path.basename(resolved))) {
    throw new Error("target path uses a reserved Windows name.");
  }
  return resolved;
}

export function validateConfig(input) {
  assertExactKeys(input, CONFIG_KEYS, "configuration");
  if (input.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${CONFIG_SCHEMA_VERSION}.`);
  }
  if (input.templateVersion !== TEMPLATE_VERSION) {
    throw new Error(`templateVersion must be ${TEMPLATE_VERSION}.`);
  }

  assertExactKeys(input.owner, new Set(["login", "name", "url"]), "owner");
  const ownerLogin = assertText(input.owner.login, "owner.login", 39, GITHUB_LOGIN);
  const ownerName = assertText(input.owner.name, "owner.name", 80);
  const expectedOwnerUrl = `https://github.com/${ownerLogin}`;
  if (input.owner.url !== expectedOwnerUrl) {
    throw new Error(`owner.url must be ${expectedOwnerUrl}.`);
  }

  assertExactKeys(
    input.repository,
    new Set(["name", "url", "visibility"]),
    "repository",
  );
  const repositoryName = assertText(
    input.repository.name,
    "repository.name",
    100,
    REPOSITORY,
  );
  if (RESERVED_WINDOWS_NAMES.test(repositoryName)) {
    throw new Error("repository.name uses a reserved Windows name.");
  }
  const expectedRepositoryUrl = `${expectedOwnerUrl}/${repositoryName}`;
  if (input.repository.url !== expectedRepositoryUrl) {
    throw new Error(`repository.url must be ${expectedRepositoryUrl}.`);
  }
  if (!VISIBILITIES.has(input.repository.visibility)) {
    throw new Error("repository.visibility must be public, private, or internal.");
  }

  assertExactKeys(
    input.package,
    new Set(["name", "displayName", "description", "version"]),
    "package",
  );
  assertText(input.package.name, "package.name", 64, IDENTIFIER);
  assertText(input.package.displayName, "package.displayName", 80);
  assertText(input.package.description, "package.description", 240);
  if (input.package.version !== "1.0.0") {
    throw new Error("package.version must be 1.0.0.");
  }

  assertExactKeys(input.catalog, new Set(["enabled", "template"]), "catalog");
  if (typeof input.catalog.enabled !== "boolean") {
    throw new Error("catalog.enabled must be a boolean.");
  }
  if (!CATALOG_TEMPLATES.has(input.catalog.template)) {
    throw new Error("catalog.template must be skills-catalog.");
  }

  assertExactKeys(input.github, new Set(["defaultBranch"]), "github");
  assertText(input.github.defaultBranch, "github.defaultBranch", 64, IDENTIFIER);

  return structuredClone(input);
}

function titleize(value) {
  return value
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

export function createConfig(options) {
  const ownerLogin = assertText(
    options.ownerLogin,
    "owner login",
    39,
    GITHUB_LOGIN,
  );
  const repositoryName = assertText(
    options.repositoryName,
    "repository name",
    100,
    REPOSITORY,
  );
  const packageName = options.packageName ?? `${ownerLogin.toLowerCase()}-skills`;
  const displayName =
    options.displayName ?? `${titleize(ownerLogin)} Skills`;
  const description =
    options.description ??
    `${displayName}, packaged for compatible AI coding agents.`;

  return validateConfig({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    templateVersion: TEMPLATE_VERSION,
    owner: {
      login: ownerLogin,
      name: options.ownerName ?? titleize(ownerLogin),
      url: `https://github.com/${ownerLogin}`,
    },
    repository: {
      name: repositoryName,
      url: `https://github.com/${ownerLogin}/${repositoryName}`,
      visibility: options.visibility ?? "public",
    },
    package: {
      name: packageName,
      displayName,
      description,
      version: "1.0.0",
    },
    catalog: {
      enabled: options.catalogEnabled ?? true,
      template: options.catalogTemplate ?? "skills-catalog",
    },
    github: {
      defaultBranch: options.defaultBranch ?? "main",
    },
  });
}

export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${CONFIG_FILE}: ${error.message}`, {
      cause: error,
    });
  }
  return validateConfig(parsed);
}
