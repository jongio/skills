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
let workflows;
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
  ]);

  const workflowNames = (
    await readdir(path.join(root, ".github", "workflows"))
  )
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  workflows = Object.fromEntries(
    await Promise.all(
      workflowNames.map(async (name) => [
        name,
        await read(".github", "workflows", name),
      ]),
    ),
  );
  lintWorkflow = workflows["skill-lint.yml"];

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

const getStepBlocks = (workflow) => {
  const lines = workflow.split(/\r?\n/);
  const starts = lines
    .map((line, index) => (
      /^(\s*)-\s+(?:name|run|uses):/.test(line) ? index : -1
    ))
    .filter((index) => index >= 0);

  return starts.map((start) => {
    const indent = lines[start].match(/^(\s*)/)[1].length;
    let end = start + 1;
    while (end < lines.length) {
      const line = lines[end];
      const candidateIndent = line.match(/^(\s*)/)[1].length;
      if (
        line.trim() !== "" &&
        (
          candidateIndent < indent ||
          (
            candidateIndent === indent &&
            (/^\s*-\s+/.test(line) || line.trimStart().startsWith("#"))
          )
        )
      ) {
        break;
      }
      end += 1;
    }
    return lines.slice(start, end);
  });
};

const getActionSteps = (workflow) =>
  getStepBlocks(workflow).flatMap((lines) => {
    const uses = lines.find((line) => /^\s*(?:-\s+)?uses:/.test(line));
    return uses ? [{ lines, uses }] : [];
  });

const getRunScripts = (workflow) =>
  getStepBlocks(workflow).flatMap((lines) => {
    const runIndex = lines.findIndex((line) =>
      /^\s*(?:-\s+)?run:/.test(line),
    );
    if (runIndex < 0) {
      return [];
    }
    const runLine = lines[runIndex];
    const value = runLine.replace(/^\s*(?:-\s+)?run:\s*/, "");
    if (!/^[|>](?:[+-][1-9]?|[1-9][+-]?)?$/.test(value)) {
      return [value];
    }
    const indent = runLine.match(/^(\s*)/)[1].length + 2;
    return [
      lines
        .slice(runIndex + 1)
        .map((line) => line.slice(indent))
        .join("\n")
        .trimEnd(),
    ];
  });

const getWorkflowPermissions = (workflow) => {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "permissions:");
  assert.notEqual(start, -1, "workflow must declare root permissions");
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    const match = line.match(/^  ([a-z-]+):\s*(\S+)\s*(?:#.*)?$/);
    if (match) {
      entries.push([match[1], match[2]]);
    }
  }
  return entries;
};

const getJobBlocks = (workflow) => {
  const lines = workflow.split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => line === "jobs:");
  assert.notEqual(jobsIndex, -1, "workflow must declare jobs");
  const starts = lines
    .map((line, index) => {
      const isJob = /^  ["']?[a-zA-Z0-9_-]+["']?:\s*$/.test(line);
      return index > jobsIndex && isJob ? index : -1;
    })
    .filter((index) => index >= 0);
  return Object.fromEntries(starts.map((start, position) => {
    const name = lines[start].match(
      /^  ["']?([a-zA-Z0-9_-]+)["']?:\s*$/,
    )[1];
    const end = starts[position + 1] ?? lines.length;
    return [name, lines.slice(start, end).join("\n")];
  }));
};

const hasWorkflowTrigger = (workflow, trigger) => {
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lines = workflow
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const triggerToken = `["']?${escaped}["']?`;
  return (
    new RegExp(`(?:^|[\\s{,])${triggerToken}\\s*:`, "m").test(lines) ||
    new RegExp(`^on\\s*:\\s*${triggerToken}(?:\\s|$)`, "m").test(lines) ||
    new RegExp(`^on\\s*:\\s*\\[[^\\]]*${triggerToken}`, "m").test(lines)
  );
};

const getWritePermissions = (source) => {
  const withoutComments = source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
  return [
    ...withoutComments.matchAll(
      /(?:^|[\s{,])["']?([a-z-]+)["']?\s*:\s*["']?write["']?\b/gm,
    ),
  ].map((match) => match[1]).sort();
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
    ".github/workflows/**",
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

test("every workflow uses least privilege and bounded jobs", () => {
  for (const [workflowName, workflow] of Object.entries(workflows)) {
    assert.deepEqual(
      getWorkflowPermissions(workflow),
      [["contents", "read"]],
      `${workflowName} must grant only contents read at workflow scope`,
    );
    assert.doesNotMatch(
      workflow,
      /^\s*permissions:\s*write-all\s*$/m,
      `${workflowName} must not grant write-all`,
    );
    for (const [jobName, job] of Object.entries(getJobBlocks(workflow))) {
      const timeout = job.match(/^\s{4}timeout-minutes:\s*([0-9]+)\s*$/m);
      assert.ok(timeout, `${workflowName} job ${jobName} must have a timeout`);
      assert.ok(
        Number(timeout[1]) >= 1 && Number(timeout[1]) <= 360,
        `${workflowName} job ${jobName} timeout must be between 1 and 360 minutes`,
      );
    }
  }

  const expectedWrites = {
    "deploy.yml": { deploy: ["id-token", "pages"] },
    "deploy-pages.yml": { deploy: ["id-token", "pages"] },
    "skill-eval.yml": { eval: ["copilot-requests"] },
    "skill-lint.yml": {},
  };
  for (const [workflowName, workflow] of Object.entries(workflows)) {
    for (const [jobName, job] of Object.entries(getJobBlocks(workflow))) {
      assert.deepEqual(
        getWritePermissions(job),
        expectedWrites[workflowName]?.[jobName] ?? [],
        `${workflowName} job ${jobName} has unexpected write permissions`,
      );
    }
  }
});

test("every action occurrence is pinned and every checkout drops credentials", () => {
  for (const [workflowName, workflow] of Object.entries(workflows)) {
    const actionSteps = getActionSteps(workflow);
    const rawUses = workflow.match(/^\s*(?:-\s+)?uses:\s*\S+/gm) ?? [];
    assert.equal(
      actionSteps.length,
      rawUses.length,
      `${workflowName} must inspect every uses occurrence`,
    );
    for (const { lines, uses } of actionSteps) {
      const match = uses.match(
        /^\s*(?:-\s+)?uses:\s*([^@\s#]+)@([0-9a-f]{40})\s+#\s+(v[0-9]+\.[0-9]+\.[0-9]+)\s*$/,
      );
      assert.ok(
        match,
        `${workflowName} action must use a full commit SHA and version comment: ${uses.trim()}`,
      );
      if (match[1] === "actions/checkout") {
        assert.match(
          lines.join("\n"),
          /^\s+persist-credentials:\s*false\s*$/m,
          `${workflowName} checkout must disable persisted credentials`,
        );
      }
    }
  }
});

test("every npm clean install suppresses lifecycle scripts", () => {
  let installs = 0;
  for (const [workflowName, workflow] of Object.entries(workflows)) {
    const rawInstalls = workflow.match(/^\s*(?!#).*\bnpm ci\b.*$/gm) ?? [];
    let inspectedInstalls = 0;
    for (const script of getRunScripts(workflow)) {
      assert.doesNotMatch(
        script,
        /\bnpm (?:i|install)\b/,
        `${workflowName} must use npm ci instead of npm install`,
      );
      for (const line of script.split("\n").filter((value) => /\bnpm ci\b/.test(value))) {
        installs += 1;
        inspectedInstalls += 1;
        assert.match(
          line,
          /\bnpm ci\b.*\s--ignore-scripts(?:\s|$)/,
          `${workflowName} must suppress scripts for every npm ci: ${line.trim()}`,
        );
      }
    }
    assert.equal(
      inspectedInstalls,
      rawInstalls.length,
      `${workflowName} must inspect every npm ci occurrence`,
    );
  }
  assert.ok(installs > 0, "workflow npm ci checks must inspect at least one command");
});

test("run blocks never interpolate GitHub expressions directly", () => {
  for (const [workflowName, workflow] of Object.entries(workflows)) {
    const scripts = getRunScripts(workflow);
    const rawRuns = workflow.match(
      /^\s*(?:-\s+)?run:\s*(?:[|>](?:[+-][1-9]?|[1-9][+-]?)?|.+)\s*$/gm,
    ) ?? [];
    assert.equal(
      scripts.length,
      rawRuns.length,
      `${workflowName} must inspect every run occurrence`,
    );
    for (const script of scripts) {
      assert.doesNotMatch(
        script,
        /\$\{\{/,
        `${workflowName} must route GitHub expressions through step env`,
      );
    }
  }
});

test("pull request workflows fail closed without elevated credentials", () => {
  for (const [workflowName, workflow] of Object.entries(workflows)) {
    assert.equal(
      hasWorkflowTrigger(workflow, "pull_request_target"),
      false,
      `${workflowName} must not use pull_request_target`,
    );
    if (!hasWorkflowTrigger(workflow, "pull_request")) {
      continue;
    }
    assert.doesNotMatch(
      workflow,
      /\$\{\{\s*secrets\./,
      `${workflowName} must not expose secrets to pull request jobs`,
    );
    assert.doesNotMatch(
      getWritePermissions(workflow).join("\n"),
      /.+/,
      `${workflowName} pull request jobs must not receive write permissions`,
    );
    assert.deepEqual(
      getWorkflowPermissions(workflow),
      [["contents", "read"]],
      `${workflowName} pull request jobs must remain read-only`,
    );
  }
});

test("workflow inspection recognizes alternate secure YAML forms", () => {
  const literal = [
    "jobs:",
    "  test:",
    "    steps:",
    "      - name: Literal",
    "        run: |-",
    "          echo ${{ github.ref }}",
  ].join("\n");
  assert.match(getRunScripts(literal)[0], /\$\{\{/);
  assert.deepEqual(
    getRunScripts([
      literal,
      "      # The next step is not part of the literal.",
      "      - name: Next",
      "        run: echo done",
    ].join("\n")),
    ["echo ${{ github.ref }}", "echo done"],
  );
  assert.match(
    getRunScripts("jobs:\n  test:\n    steps:\n      - run: echo ${{ github.ref }}")[0],
    /\$\{\{/,
  );
  assert.deepEqual(
    Object.keys(getJobBlocks("jobs:\n  'quoted-job':\n    timeout-minutes: 1")),
    ["quoted-job"],
  );
  assert.deepEqual(
    getWritePermissions("permissions: { 'issues': 'write' }"),
    ["issues"],
  );

  for (const trigger of [
    "on: pull_request_target",
    "on: [push, pull_request_target]",
    "on: { pull_request_target: {} }",
    "on:\n  'pull_request_target': {}",
    "on:\n  pull_request_target : {}",
  ]) {
    assert.equal(hasWorkflowTrigger(trigger, "pull_request_target"), true);
  }
  assert.equal(
    hasWorkflowTrigger("on:\n  pull_request: {}", "pull_request"),
    true,
  );
});

test("skill eval is trusted, discovered, bounded, and token scoped", () => {
  const workflow = workflows["skill-eval.yml"];
  assert.equal(
    hasWorkflowTrigger(workflow, "pull_request"),
    false,
    "skill eval must remain disabled for pull requests",
  );
  assert.match(workflow, /^  workflow_dispatch:\s*$/m);
  assert.match(workflow, /^  schedule:\s*$/m);
  assert.match(workflow, /^\s+group:\s*skill-eval\s*$/m);
  assert.match(workflow, /^\s+max-parallel:\s*2\s*$/m);
  assert.doesNotMatch(
    workflow,
    /\{"skill":"skills\//,
    "skill eval must not use a hardcoded matrix",
  );
  assert.match(
    workflow,
    /find skills -mindepth 4 -maxdepth 4 -type f/,
    "skill eval must discover eval specifications",
  );
  assert.match(
    workflow,
    /\^\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$/,
    "skill eval must allow only canonical skill ids",
  );
  assert.match(
    workflow,
    /\[ "\$spec" != "\$expected" \]/,
    "skill eval must require the canonical eval path",
  );
  assert.match(
    workflows["skill-lint.yml"],
    /\^skills\/\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$/,
    "skill lint must allow only canonical dynamic skill directories",
  );
  const versionSteps = getStepBlocks(workflow).filter((lines) =>
    lines.some((line) => line.includes("- name: Report Vally version")),
  );
  assert.equal(versionSteps.length, 1, "skill eval must report its Vally version once");
  assert.deepEqual(
    getRunScripts(versionSteps[0].join("\n")),
    ['"$VALLY_BIN" --version'],
    "the Vally version step must invoke the configured executable",
  );

  const tokenSteps = getStepBlocks(workflow).filter((lines) =>
    lines.some((line) => line.includes("secrets.GITHUB_TOKEN")),
  );
  assert.equal(tokenSteps.length, 1, "only one skill eval step may receive a token");
  const [tokenStep] = tokenSteps;
  const tokenStepSource = tokenStep.join("\n");
  assert.match(tokenStepSource, /- name: Run eval/);
  assert.equal(
    tokenStep.filter((line) => line.includes("secrets.GITHUB_TOKEN")).length,
    2,
    "the eval step must map only the two SDK token variables",
  );
  const envIndex = tokenStep.findIndex((line) => /^\s+env:\s*$/.test(line));
  assert.notEqual(envIndex, -1, "the eval step must declare an env map");
  const envIndent = tokenStep[envIndex].match(/^(\s*)/)[1].length;
  const envEntries = [];
  for (const line of tokenStep.slice(envIndex + 1)) {
    const indent = line.match(/^(\s*)/)[1].length;
    if (line.trim() !== "" && indent <= envIndent) {
      break;
    }
    const match = line.match(/^\s+([A-Z_]+):\s*(.+)\s*$/);
    if (match) {
      envEntries.push([match[1], match[2]]);
    }
  }
  assert.deepEqual(envEntries, [
    ["GITHUB_TOKEN", "${{ secrets.GITHUB_TOKEN }}"],
    ["COPILOT_GITHUB_TOKEN", "${{ secrets.GITHUB_TOKEN }}"],
    ["EVAL_SPEC", "${{ matrix.eval_spec }}"],
    [
      "VALLY_BIN",
      "${{ github.workspace }}/.github/tools/vally/node_modules/.bin/vally",
    ],
  ]);
  const [evalScript] = getRunScripts(tokenStep.join("\n"));
  const commandLines = evalScript.trim().split("\n");
  for (const line of commandLines.slice(0, -1)) {
    assert.match(
      line,
      /\\\s*$/,
      "each continued Vally command line must end with a backslash",
    );
  }
  assert.doesNotMatch(commandLines.at(-1), /\\\s*$/);
  const command = commandLines
    .map((line) => line.replace(/\\\s*$/, "").trim())
    .join(" ");
  assert.equal(
    command,
    '"$VALLY_BIN" eval --eval-spec "$EVAL_SPEC" --skill-dir . --output-dir ./vally-results --runs 5 --workers 2 --max-retries 0',
    "the token-bearing step must execute only the Vally eval command",
  );
});

test("workflow artifacts are short-lived and exclude sensitive output", () => {
  for (const [workflowName, workflow] of Object.entries(workflows)) {
    for (const { lines, uses } of getActionSteps(workflow)) {
      if (!/actions\/upload-(?:pages-)?artifact@/.test(uses)) {
        continue;
      }
      const step = lines.join("\n");
      const retention = step.match(/^\s+retention-days:\s*([0-9]+)\s*$/m);
      assert.ok(retention, `${workflowName} artifact must set retention-days`);
      assert.ok(
        Number(retention[1]) <= 3,
        `${workflowName} artifact retention must not exceed three days`,
      );
      assert.doesNotMatch(
        step,
        /events\.jsonl|vally-results|transcript|\.env\b|GITHUB_ENV/i,
        `${workflowName} must not upload transcripts or environment-bearing files`,
      );
    }
  }
  assert.doesNotMatch(
    workflows["skill-eval.yml"],
    /actions\/upload-(?:pages-)?artifact@/,
    "skill eval must not upload agent output",
  );
});
