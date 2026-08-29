import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import test, { before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFile(path.join(root, ...parts), "utf8");
const parse = async (...parts) => {
  const relativePath = parts.join("/");
  try {
    return JSON.parse(await read(...parts));
  } catch (error) {
    throw new Error(`Invalid JSON in ${relativePath}: ${error.message}`, {
      cause: error,
    });
  }
};

let rootPlugin;
let copilotMarketplace;
let codexPlugin;
let codexMarketplace;
let claudePlugin;
let claudeMarketplace;
let cursorMarketplace;
let geminiExtension;
let readme;
let lintWorkflow;
let skillNames;

before(async () => {
  [
    rootPlugin,
    copilotMarketplace,
    codexPlugin,
    codexMarketplace,
    claudePlugin,
    claudeMarketplace,
    cursorMarketplace,
    geminiExtension,
    readme,
    lintWorkflow,
  ] = await Promise.all([
    parse("plugin.json"),
    parse("marketplace.json"),
    parse(".codex-plugin", "plugin.json"),
    parse(".agents", "plugins", "marketplace.json"),
    parse(".claude-plugin", "plugin.json"),
    parse(".claude-plugin", "marketplace.json"),
    parse(".cursor-plugin", "marketplace.json"),
    parse("gemini-extension.json"),
    read("README.md"),
    read(".github", "workflows", "skill-lint.yml"),
  ]);

  skillNames = (
    await readdir(path.join(root, "skills"), { withFileTypes: true })
  )
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(path.join(root, "skills", entry.name, "SKILL.md")),
    )
    .map(({ name }) => name)
    .sort();
});

const packageName = "jongio-skills";
const packageVersion = "2.0.0";
const agentPluginSchema =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const description =
  "Jon Gallant's collection of reusable skills for AI coding agents.";

const assertExactKeys = (value, expectedKeys, label) => {
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expectedKeys].sort(),
    `${label} contains unsupported or missing fields`,
  );
};

const assertSafeHttpsUrl = (value, label) => {
  const url = new URL(value);
  assert.equal(url.protocol, "https:", `${label} must use HTTPS`);
  assert.equal(url.username, "", `${label} must not contain credentials`);
  assert.equal(url.password, "", `${label} must not contain credentials`);
};

const assertLocalSource = (value, label) => {
  assert.match(
    value,
    /^(?:\.\/|\.[/][^./\\][^/\\]*(?:[/][^./\\][^/\\]*)*[/]?)$/,
    `${label} must be a normalized relative path`,
  );
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  assert.equal(
    relative.startsWith("..") || path.isAbsolute(relative),
    false,
    `${label} must stay within the marketplace root`,
  );
};

test("root package uses the portable Agent Plugins manifest", () => {
  assertExactKeys(
    rootPlugin,
    [
      "$schema",
      "name",
      "description",
      "version",
      "author",
      "license",
      "keywords",
      "repository",
    ],
    "plugin.json",
  );
  assertExactKeys(rootPlugin.author, ["name", "url"], "plugin.json author");
  assert.equal(rootPlugin.$schema, agentPluginSchema);
  assert.equal(rootPlugin.name, packageName);
  assert.equal(typeof rootPlugin.description, "string");
  assert.ok(rootPlugin.description.trim().length > 0);
  assert.equal(rootPlugin.version, packageVersion);
  assert.equal(rootPlugin.author.name, "Jon Gallant");
  assert.equal(rootPlugin.repository, "https://github.com/jongio/skills");
  assert.equal(rootPlugin.license, "MIT");
  assert.equal(Array.isArray(rootPlugin.keywords), true);
  for (const keyword of rootPlugin.keywords) {
    assert.equal(typeof keyword, "string");
    assert.ok(keyword.length > 0);
  }
  assert.equal(
    Object.hasOwn(rootPlugin, "skills"),
    false,
    "Agent Plugins discovers the fixed skills/ directory",
  );

  for (const skillName of skillNames) {
    assert.ok(
      rootPlugin.keywords.includes(skillName),
      `plugin.json keywords must include ${skillName}`,
    );
  }
});

test("every canonical skill is registered in the Copilot marketplace", async () => {
  assertExactKeys(
    copilotMarketplace,
    ["name", "owner", "metadata", "plugins"],
    "marketplace.json",
  );
  assertExactKeys(
    copilotMarketplace.owner,
    ["name", "url"],
    "marketplace.json owner",
  );
  assertExactKeys(
    copilotMarketplace.metadata,
    ["description"],
    "marketplace.json metadata",
  );
  assert.equal(
    new Set(copilotMarketplace.plugins.map(({ name }) => name)).size,
    copilotMarketplace.plugins.length,
    "Copilot marketplace plugin names must be unique",
  );
  assert.ok(copilotMarketplace.metadata.description.length > 0);
  const individualEntries = copilotMarketplace.plugins.filter(
    ({ name }) => name !== packageName,
  );
  assert.deepEqual(
    individualEntries.map(({ name }) => name).sort(),
    skillNames,
  );

  for (const entry of individualEntries) {
    assertExactKeys(
      entry,
      ["name", "source", "description", "version"],
      `${entry.name} Copilot marketplace entry`,
    );
    assert.equal(entry.source, `./skills/${entry.name}`);
    assertLocalSource(entry.source, `${entry.name} Copilot source`);
    assert.ok(entry.description.length > 0);
    const skill = await read("skills", entry.name, "SKILL.md");
    assert.match(
      skill,
      new RegExp(`^name:\\s*${entry.name}\\s*$`, "m"),
      `${entry.name} SKILL.md frontmatter must match its directory`,
    );
  }

  const aggregate = copilotMarketplace.plugins.find(
    ({ name }) => name === packageName,
  );
  assert.ok(aggregate, "Copilot marketplace must expose the aggregate plugin");
  assertExactKeys(
    aggregate,
    ["name", "source", "description", "version"],
    "aggregate Copilot marketplace entry",
  );
  assert.equal(aggregate.source, "./");
  assertLocalSource(aggregate.source, "aggregate Copilot source");
  assert.equal(
    aggregate.description,
    "Install the complete Jon Gallant skills collection as one plugin.",
  );
  assert.equal(aggregate.version, packageVersion);
});

test("Codex and ChatGPT manifests expose the aggregate skills package", () => {
  assertExactKeys(
    codexPlugin,
    [
      "name",
      "version",
      "description",
      "author",
      "repository",
      "license",
      "skills",
    ],
    "Codex plugin manifest",
  );
  assertExactKeys(codexPlugin.author, ["name", "url"], "Codex plugin author");
  assertExactKeys(
    codexMarketplace,
    ["name", "interface", "plugins"],
    "Codex marketplace",
  );
  assertExactKeys(
    codexMarketplace.interface,
    ["displayName"],
    "Codex marketplace interface",
  );
  assert.equal(codexPlugin.name, packageName);
  assert.equal(codexPlugin.version, packageVersion);
  assert.equal(codexPlugin.skills, "./skills/");
  assert.equal(codexMarketplace.name, packageName);
  assert.equal(codexMarketplace.interface.displayName, "Jon Gallant Skills");
  assert.equal(codexMarketplace.plugins.length, 1);

  const [entry] = codexMarketplace.plugins;
  assertExactKeys(
    entry,
    ["name", "source", "policy", "category"],
    "Codex marketplace entry",
  );
  assertExactKeys(entry.source, ["source", "path"], "Codex plugin source");
  assertExactKeys(
    entry.policy,
    ["installation", "authentication"],
    "Codex plugin policy",
  );
  assert.equal(entry.name, packageName);
  assert.deepEqual(entry.source, { source: "local", path: "./" });
  assertLocalSource(entry.source.path, "Codex plugin source");
  assert.deepEqual(entry.policy, {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL",
  });
  assert.equal(entry.category, "Developer Tools");
});

test("Claude Code marketplace and plugin resolve from the repository root", () => {
  assertExactKeys(
    claudePlugin,
    [
      "name",
      "version",
      "description",
      "author",
      "repository",
      "license",
      "skills",
    ],
    "Claude plugin manifest",
  );
  assertExactKeys(claudePlugin.author, ["name", "url"], "Claude plugin author");
  assertExactKeys(
    claudeMarketplace,
    ["name", "description", "owner", "plugins"],
    "Claude marketplace",
  );
  assertExactKeys(
    claudeMarketplace.owner,
    ["name", "url"],
    "Claude marketplace owner",
  );
  assert.equal(claudePlugin.name, packageName);
  assert.equal(claudePlugin.version, packageVersion);
  assert.equal(claudePlugin.skills, "./skills/");
  assert.equal(claudeMarketplace.name, packageName);
  assert.equal(
    claudeMarketplace.description,
    description,
  );
  assert.equal(claudeMarketplace.owner.name, "Jon Gallant");
  assert.equal(claudeMarketplace.plugins.length, 1);
  assertExactKeys(
    claudeMarketplace.plugins[0],
    ["name", "source", "description", "version"],
    "Claude marketplace entry",
  );
  assert.equal(claudeMarketplace.plugins[0].name, packageName);
  assert.equal(claudeMarketplace.plugins[0].source, "./");
  assert.equal(claudeMarketplace.plugins[0].version, packageVersion);
  assertLocalSource(
    claudeMarketplace.plugins[0].source,
    "Claude marketplace source",
  );
});

test("Cursor marketplace points at the portable root plugin", () => {
  assertExactKeys(
    cursorMarketplace,
    ["name", "owner", "metadata", "plugins"],
    "Cursor marketplace",
  );
  assertExactKeys(cursorMarketplace.owner, ["name"], "Cursor marketplace owner");
  assertExactKeys(
    cursorMarketplace.metadata,
    ["description"],
    "Cursor marketplace metadata",
  );
  assert.equal(cursorMarketplace.name, packageName);
  assert.equal(cursorMarketplace.owner.name, "Jon Gallant");
  assert.equal(
    cursorMarketplace.metadata.description,
    description,
  );
  assert.equal(cursorMarketplace.plugins.length, 1);
  assertExactKeys(
    cursorMarketplace.plugins[0],
    ["name", "source", "description"],
    "Cursor marketplace entry",
  );
  assert.equal(cursorMarketplace.plugins[0].name, packageName);
  assert.equal(cursorMarketplace.plugins[0].source, "./");
  assertLocalSource(
    cursorMarketplace.plugins[0].source,
    "Cursor marketplace source",
  );
  assert.equal(
    cursorMarketplace.plugins[0].description,
    description,
  );
});

test("Gemini extension exposes the canonical skills directory", () => {
  assert.deepEqual(geminiExtension, {
    name: packageName,
    version: packageVersion,
    description,
  });
});

test("all manifest URLs use exact trusted HTTPS origins", () => {
  for (const [label, value, expected] of [
    ["Agent Plugins schema", rootPlugin.$schema, agentPluginSchema],
    ["root author URL", rootPlugin.author.url, "https://github.com/jongio"],
    ["root repository URL", rootPlugin.repository, "https://github.com/jongio/skills"],
    ["Copilot owner URL", copilotMarketplace.owner.url, "https://github.com/jongio"],
    ["Codex author URL", codexPlugin.author.url, "https://github.com/jongio"],
    ["Codex repository URL", codexPlugin.repository, "https://github.com/jongio/skills"],
    ["Claude author URL", claudePlugin.author.url, "https://github.com/jongio"],
    ["Claude repository URL", claudePlugin.repository, "https://github.com/jongio/skills"],
    ["Claude owner URL", claudeMarketplace.owner.url, "https://github.com/jongio"],
  ]) {
    assertSafeHttpsUrl(value, label);
    assert.equal(value, expected, `${label} must use the trusted canonical URL`);
  }
});

test("manifest safety guards reject unsafe values", () => {
  for (const value of [
    "http://example.com",
    "https://user:password@example.com",
  ]) {
    assert.throws(() => assertSafeHttpsUrl(value, "unsafe URL"));
  }

  for (const value of [
    "../outside",
    "./../outside",
    "./skills//outside",
    "./foo\\..\\..\\bar",
    "C:\\outside",
  ]) {
    assert.throws(() => assertLocalSource(value, "unsafe source"));
  }
});

test("repo-ready remains self-contained when installed individually", async (t) => {
  const installRoot = await mkdtemp(path.join(tmpdir(), "repo-ready-install-"));
  t.after(() => rm(installRoot, { recursive: true, force: true }));

  const scriptsRoot = path.join(installRoot, "scripts");
  await cp(
    path.join(root, "skills", "repo-ready", "scripts"),
    scriptsRoot,
    { recursive: true },
  );
  const fixtureRoot = path.join(installRoot, "fixture");
  await mkdir(fixtureRoot);
  await writeFile(path.join(fixtureRoot, "package-lock.json"), "{}");

  for (const script of ["generate.mjs", "scan-repo.mjs"]) {
    await import(pathToFileURL(path.join(scriptsRoot, script)).href);
  }
  const installedModule = await import(
    pathToFileURL(path.join(scriptsRoot, "detect-stack.mjs")).href,
  );
  assert.deepEqual(installedModule.detectStack(fixtureRoot), {
    stacks: ["node"],
    pkgManager: "npm",
    labels: ["Node.js"],
  });
});

test("portable package cannot gain implicit executable components", () => {
  for (const implicitPath of [
    "mcp.json",
    ".mcp.json",
    ".lsp.json",
    "settings.json",
    "hooks",
    "agents",
    "commands",
    "workflows",
    "output-styles",
    "themes",
    "monitors",
    "bin",
    "com.github.copilot",
  ]) {
    assert.equal(
      existsSync(path.join(root, implicitPath)),
      false,
      `${implicitPath} requires an explicit security review before distribution`,
    );
  }
});

test("documentation defines every supported application surface", () => {
  for (const row of [
    "| GitHub Copilot app | Marketplace and individual or complete plugin install |",
    "| GitHub Copilot in Visual Studio Code | Agent Plugins 1.0 and marketplace install |",
    "| GitHub Copilot CLI | Marketplace and direct plugin install |",
    "| Copilot coding agent and code review | Agent Skills in the target repository |",
    "| ChatGPT desktop and Codex CLI | Codex marketplace and skills-only plugin |",
    "| ChatGPT web and mobile | Public directory plugins only |",
    "| Codex IDE extension | Standalone Agent Skills only |",
    "| Claude Code, including its Visual Studio Code and JetBrains integrations | Claude marketplace plugin |",
    "| Cursor | Agent Plugins 1.0 and Cursor marketplace |",
    "| Gemini CLI and its editor companion | Gemini extension |",
    "| Goose Desktop, Windsurf, Cline, Roo Code, and OpenCode | Native Agent Skills |",
  ]) {
    assert.ok(readme.includes(row), `README must contain support row: ${row}`);
  }
});

test("CI runs distribution parity for every manifest change", () => {
  for (const manifestPath of [
    "marketplace.json",
    "plugin.json",
    ".agents/plugins/**",
    ".codex-plugin/**",
    ".claude-plugin/**",
    ".cursor-plugin/**",
    "gemini-extension.json",
    "skills/**/*.yaml",
    "skills/**/*.yml",
    ".github/tools/vally/**",
    "test/**",
    "mcp.json",
    ".mcp.json",
    ".lsp.json",
    "settings.json",
    "hooks/**",
    "agents/**",
    "commands/**",
    "workflows/**",
    "output-styles/**",
    "themes/**",
    "monitors/**",
    "bin/**",
    "com.github.copilot/**",
  ]) {
    assert.ok(
      lintWorkflow.includes(`"${manifestPath}"`),
      `skill-lint.yml must watch ${manifestPath}`,
    );
  }
  assert.ok(
    lintWorkflow.includes(
      "node --test test/*.test.mjs",
    ),
    "skill-lint.yml must run all distribution tests",
  );
  assert.match(
    lintWorkflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/,
    "skill-lint.yml must pin actions/checkout v7.0.1 by commit SHA",
  );
  assert.match(
    lintWorkflow,
    /persist-credentials: false/,
    "skill-lint.yml must not persist checkout credentials",
  );
  assert.match(
    lintWorkflow,
    /npm ci --prefix site --ignore-scripts/,
    "skill-lint.yml must suppress dependency lifecycle scripts",
  );
  assert.match(
    lintWorkflow,
    /npm ci --prefix \.github\/tools\/vally --ignore-scripts/,
    "skill-lint.yml must install the locked Vally toolchain without scripts",
  );
  assert.doesNotMatch(
    lintWorkflow,
    /actions\/setup-node@v7/,
    "skill-lint.yml must pin every setup-node action by commit SHA",
  );
  assert.match(
    lintWorkflow,
    /CHANGED=.*git diff --name-only/,
    "skill-lint.yml must inspect all changed paths",
  );
  assert.match(
    lintWorkflow,
    /\.\*\\\.ya\?ml/,
    "skill-lint.yml must select nested YAML and YML skill files",
  );
  assert.match(lintWorkflow, /\| sort -u \|\| true\)/);
});
