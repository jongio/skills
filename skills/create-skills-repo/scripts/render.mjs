import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  validateConfig,
  validateRelativeTemplatePath,
} from "./config.mjs";

const TEMPLATE_SUFFIX = ".template";
const DERIVED_PATHS = new Set([
  "README.md",
  "plugin.json",
  "marketplace.json",
  ".agents/plugins/marketplace.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  "gemini-extension.json",
  ".github/dependabot.yml",
]);
const SKIPPED_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "vally-results",
]);
const SKILL_NAME = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function foldYamlBlock(lines) {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseYamlScalar(value, label) {
  const scalar = value.trim();
  const doubleQuoted = scalar.match(/^"(?:[^"\\]|\\.)*"/);
  if (doubleQuoted) {
    const trailing = scalar.slice(doubleQuoted[0].length).trim();
    if (trailing && !trailing.startsWith("#")) {
      throw new Error(`${label} has invalid content after its YAML scalar.`);
    }
    try {
      return JSON.parse(doubleQuoted[0]).replace(/\s+/g, " ").trim();
    } catch (error) {
      throw new Error(`${label} has an invalid double-quoted YAML scalar.`, {
        cause: error,
      });
    }
  }
  const singleQuoted = scalar.match(/^'(?:[^']|'')*'/);
  if (singleQuoted) {
    const trailing = scalar.slice(singleQuoted[0].length).trim();
    if (trailing && !trailing.startsWith("#")) {
      throw new Error(`${label} has invalid content after its YAML scalar.`);
    }
    return singleQuoted[0].slice(1, -1).replaceAll("''", "'");
  }
  if (/^['"]|['"]$/.test(scalar)) {
    throw new Error(`${label} has mismatched YAML scalar quotes.`);
  }
  return scalar.replace(/\s+#.*$/, "").trimEnd();
}

export function readSkillFrontmatter(source, directoryName) {
  const normalized = source.replace(/\r\n?/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    throw new Error(`skills/${directoryName}/SKILL.md has no YAML frontmatter.`);
  }
  const lines = match[1].split("\n");
  const nameLine = lines.find((line) => /^name:\s*/.test(line));
  if (!nameLine) {
    throw new Error(`skills/${directoryName}/SKILL.md has no frontmatter name.`);
  }
  const name = parseYamlScalar(
    nameLine.replace(/^name:\s*/, ""),
    `skills/${directoryName}/SKILL.md name`,
  );
  if (!SKILL_NAME.test(directoryName) || !SKILL_NAME.test(name)) {
    throw new Error(
      `skills/${directoryName}/SKILL.md must use a lowercase dash-separated name.`,
    );
  }
  if (name !== directoryName) {
    throw new Error(
      `skills/${directoryName}/SKILL.md name must match its directory.`,
    );
  }

  const descriptionIndex = lines.findIndex((line) => /^description:\s*/.test(line));
  if (descriptionIndex < 0) {
    throw new Error(`skills/${directoryName}/SKILL.md has no description.`);
  }
  const descriptionHead = lines[descriptionIndex].replace(/^description:\s*/, "");
  let description;
  if (/^[>|][+-]?$/.test(descriptionHead.trim())) {
    const block = [];
    for (const line of lines.slice(descriptionIndex + 1)) {
      if (!/^\s+/.test(line) && line.trim() !== "") break;
      block.push(line);
    }
    description = foldYamlBlock(block);
  } else {
    description = parseYamlScalar(
      descriptionHead,
      `skills/${directoryName}/SKILL.md description`,
    );
  }
  if (description.length === 0 || description.length > 1024) {
    throw new Error(
      `skills/${directoryName}/SKILL.md description must contain 1 to 1024 characters.`,
    );
  }
  return { name, description };
}

export async function discoverSkills(root) {
  const skillsRoot = path.join(root, "skills");
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  const names = new Set();
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )) {
    if (!entry.isDirectory() || SKIPPED_NAMES.has(entry.name)) continue;
    validateRelativeTemplatePath(`skills/${entry.name}`, "skill directory");
    const skillPath = path.join(skillsRoot, entry.name, "SKILL.md");
    let metadata;
    try {
      metadata = await lstat(skillPath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`skills/${entry.name}/SKILL.md must be a regular file.`);
    }
    const record = readSkillFrontmatter(
      await readFile(skillPath, "utf8"),
      entry.name,
    );
    const caseKey = record.name.toLowerCase();
    if (names.has(caseKey)) {
      throw new Error(`Duplicate skill directory identity: ${record.name}.`);
    }
    names.add(caseKey);
    records.push(record);
  }
  return records;
}

async function walkTemplate(root, current = root) {
  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )) {
    if (SKIPPED_NAMES.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Repository template contains a symlink: ${absolute}.`);
    }
    if (metadata.isDirectory()) {
      files.push(...await walkTemplate(root, absolute));
    } else if (metadata.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function marketplaceEntries(config, skills) {
  return [
    {
      name: config.package.name,
      source: "./",
      description: `Install the complete ${config.package.displayName} collection.`,
      version: config.package.version,
    },
    ...skills.map((skill) => ({
      name: skill.name,
      source: `./skills/${skill.name}`,
      description: skill.description,
      version: "1.0.0",
    })),
  ];
}

function escapeMarkdown(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/([`*_[\]{}()#+.!|<>])/g, "\\$1");
}

function replacements(config, skills) {
  const skillTable = skills.length === 0
    ? "| None yet | Create the first skill with `create-skill`. |"
    : skills
      .map(
        (skill) =>
          `| [\`${skill.name}\`](skills/${skill.name}/) | ${escapeMarkdown(skill.description)} |`,
      )
      .join("\n");
  const dependabotCatalog = config.catalog.enabled
      ? [
        "  - package-ecosystem: npm",
        "    directory: /site",
        "    schedule:",
        "      interval: weekly",
        "    open-pull-requests-limit: 2",
      ].join("\n")
      : "";
  const dependabotSkills = skills
    .map(
      (skill) => [
        "  - package-ecosystem: npm",
        `    directory: /skills/${skill.name}`,
        "    schedule:",
        "      interval: weekly",
        "    open-pull-requests-limit: 2",
      ].join("\n"),
    )
    .join("\n");
  const catalogSection = config.catalog.enabled
    ? [
      "## Catalog",
      "",
      "The catalog lives in `site/`. Preview it locally before publishing:",
      "",
      "```sh",
      "npm ci --prefix site --ignore-scripts",
      "npm run dev --prefix site",
      "```",
      "",
      "Publishing requires separate owner approval. The generated Pages workflow never runs on pull requests.",
    ].join("\n")
    : [
      "## Catalog",
      "",
      "Catalog generation is disabled in `skills-repo.config.json`.",
    ].join("\n");
  const values = {
    __PACKAGE_NAME_JSON__: JSON.stringify(config.package.name),
    __PACKAGE_VERSION_JSON__: JSON.stringify(config.package.version),
    __DESCRIPTION_JSON__: JSON.stringify(config.package.description),
    __DISPLAY_NAME_JSON__: JSON.stringify(config.package.displayName),
    __OWNER_NAME_JSON__: JSON.stringify(config.owner.name),
    __OWNER_NAME_TEXT__: config.owner.name,
    __OWNER_URL_JSON__: JSON.stringify(config.owner.url),
    __REPOSITORY_URL_JSON__: JSON.stringify(config.repository.url),
    __MARKETPLACE_PLUGINS_JSON__: JSON.stringify(
      marketplaceEntries(config, skills),
      null,
      2,
    ),
    __SKILL_KEYWORDS_JSON__: JSON.stringify(
      ["skills", "agent-skills", ...skills.map((skill) => skill.name)],
      null,
      2,
    ),
    __SKILL_TABLE__: skillTable,
    __DEPENDABOT_SKILLS__: dependabotSkills,
    __DEPENDABOT_CATALOG__: dependabotCatalog,
    __CATALOG_SECTION__: catalogSection,
    __PACKAGE_NAME_TEXT__: config.package.name,
    __DISPLAY_NAME_TEXT__: escapeMarkdown(config.package.displayName),
    __DESCRIPTION_TEXT__: escapeMarkdown(config.package.description),
    __REPOSITORY_URL_TEXT__: config.repository.url,
    __DEFAULT_BRANCH__: config.github.defaultBranch,
  };
  return values;
}

function applyReplacements(source, values, relativePath) {
  const token = /__[A-Z0-9_]+__/g;
  for (const value of source.match(token) ?? []) {
    if (!Object.hasOwn(values, value)) {
      throw new Error(`Unknown template token ${value} in ${relativePath}.`);
    }
  }
  return source.replace(token, (value) => {
    return values[value];
  }).replace(/\r\n?/g, "\n");
}

export async function renderRepositoryTemplates(
  templateRoot,
  configInput,
  skills,
  options = {},
) {
  const config = validateConfig(configInput);
  const values = replacements(config, skills);
  const rendered = new Map();
  for (const absolute of await walkTemplate(templateRoot)) {
    const templateRelative = path.relative(templateRoot, absolute).replaceAll("\\", "/");
    if (templateRelative.startsWith("skills/create-skill/")) continue;
    const relativePath = templateRelative.endsWith(TEMPLATE_SUFFIX)
      ? templateRelative.slice(0, -TEMPLATE_SUFFIX.length)
      : templateRelative;
    validateRelativeTemplatePath(relativePath);
    if (options.derivedOnly && !DERIVED_PATHS.has(relativePath)) continue;
    const content = await readFile(absolute, "utf8");
    rendered.set(relativePath, applyReplacements(content, values, relativePath));
  }
  return rendered;
}

export async function readTreeAsManaged(sourceRoot, destinationPrefix) {
  const files = new Map();
  for (const absolute of await walkTemplate(sourceRoot)) {
    const sourceRelative = path.relative(sourceRoot, absolute).replaceAll("\\", "/");
    const relativePath = `${destinationPrefix}/${sourceRelative}`;
    validateRelativeTemplatePath(relativePath, "snapshot path");
    files.set(relativePath, await readFile(absolute));
  }
  return files;
}

export async function writeRenderedTree(root, rendered) {
  for (const relativePath of [...rendered.keys()].sort()) {
    const absolute = path.join(root, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, rendered.get(relativePath));
  }
}

export function renderConfig(config) {
  return canonicalJson(validateConfig(config));
}

export { DERIVED_PATHS };
