#!/usr/bin/env node

import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HELP, parseArguments } from "./arguments.mjs";
import { composeCatalog } from "./catalog.mjs";
import {
  CONFIG_FILE,
  TEMPLATE_VERSION,
  canonicalJson,
  createConfig,
  loadConfig,
  validateTargetPath,
} from "./config.mjs";
import { createGitHubPlan } from "./github-plan.mjs";
import {
  STATE_FILE,
  applyManagedTransaction,
  buildState,
  classifyManagedFiles,
  inspectManagedState,
  loadState,
} from "./managed-files.mjs";
import {
  discoverSkills,
  readTreeAsManaged,
  renderConfig,
  renderRepositoryTemplates,
  writeRenderedTree,
} from "./render.mjs";
import {
  generateCatalog,
  generateExampleSkill,
  registerExistingSkill,
  resolveCatalogDependency,
  resolveCreateSkillDependency,
  resolveInputDirectory,
} from "./process-tools.mjs";
import {
  assertOutsideRoot,
  assertRepositoryRoot,
  desiredFromCurrentState,
  mergeMaps,
} from "./repository-files.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDirectory, "..");
const templateRoot = path.join(skillRoot, "templates", "repository");
const fixturePath = path.join(
  skillRoot,
  "references",
  "example-skill.fixture.json",
);
const SUPPORTED_OPERATIONS = new Set(["create", "upgrade", "sync"]);
const CREATE_OPTIONS = new Set([
  "owner-login", "owner-name", "repo", "package-name", "display-name",
  "description", "visibility", "default-branch", "no-catalog",
  "create-skill-source", "catalog-script", "catalog-templates-dir",
  "catalog-registry", "catalog-registry-ref",
]);
function assertCommandOptions(command, options) {
  const allowed = command === "create"
    ? CREATE_OPTIONS
    : command === "upgrade"
      ? new Set(["create-skill-source"])
      : new Set();
  const unsupported = Object.keys(options).filter(
    (name) => name !== "help" && !allowed.has(name),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `${command} does not support: ${unsupported.sort().join(", ")}.`,
    );
  }
}
async function renderDerived(root, config, state) {
  const skills = await discoverSkills(root);
  const current = await desiredFromCurrentState(root, state);
  const derived = await renderRepositoryTemplates(
    templateRoot,
    config,
    skills,
    { derivedOnly: true },
  );
  return mergeMaps(current, derived);
}
function productionDependencies(overrides = {}) {
  return {
    resolveCreateSkill:
      overrides.resolveCreateSkill ??
      ((explicit) => resolveCreateSkillDependency(skillRoot, explicit)),
    resolveCatalog:
      overrides.resolveCatalog ??
      ((explicit, templatesDirectory, template, registry, registryRef) =>
        resolveCatalogDependency(skillRoot, explicit, {
          templatesDirectory,
          template,
          registry,
          registryRef,
        })),
    createExample: overrides.createExample ?? generateExampleSkill,
    registerExisting: overrides.registerExisting ?? registerExistingSkill,
    createCatalog: overrides.createCatalog ?? generateCatalog,
    resolveCatalogTemplates:
      overrides.resolveCatalogTemplates ??
      ((input) => resolveInputDirectory(input, "catalog templates directory")),
  };
}

async function createDryRun(target, options, dependencies) {
  const config = createConfig({
    ownerLogin: options["owner-login"],
    ownerName: options["owner-name"],
    repositoryName: options.repo ?? path.basename(target),
    packageName: options["package-name"],
    displayName: options["display-name"],
    description: options.description,
    visibility: options.visibility,
    defaultBranch: options["default-branch"],
    catalogEnabled: !options["no-catalog"],
  });
  if (existsSync(target)) {
    await assertRepositoryRoot(target);
    const existingConfig = await loadConfig(target);
    if (canonicalJson(existingConfig) !== canonicalJson(config)) {
      throw new Error(
        "Create target is already managed with a different configuration.",
      );
    }
    const result = await updateRepository(
      "upgrade",
      target,
      options,
      dependencies,
      true,
    );
    return {
      ...result,
      command: "create",
      githubPlan: null,
    };
  }
  await dependencies.resolveCreateSkill(options["create-skill-source"]);
  const templatesDirectory =
    config.catalog.enabled && options["catalog-templates-dir"]
      ? await dependencies.resolveCatalogTemplates(options["catalog-templates-dir"])
      : undefined;
  if (config.catalog.enabled) {
    await dependencies.resolveCatalog(
      options["catalog-script"],
      templatesDirectory,
      config.catalog.template,
      options["catalog-registry"],
      options["catalog-registry-ref"],
    );
  }
  return {
    command: "create",
    dryRun: true,
    status: "planned",
    target,
    catalog: config.catalog.enabled,
    githubPlan: createGitHubPlan(config, target),
  };
}

async function createRepository(target, options, dependencies) {
  const config = createConfig({
    ownerLogin: options["owner-login"],
    ownerName: options["owner-name"],
    repositoryName: options.repo ?? path.basename(target),
    packageName: options["package-name"],
    displayName: options["display-name"],
    description: options.description,
    visibility: options.visibility,
    defaultBranch: options["default-branch"],
    catalogEnabled: !options["no-catalog"],
  });

  if (existsSync(target)) {
    await assertRepositoryRoot(target);
    const existingConfig = await loadConfig(target);
    if (canonicalJson(existingConfig) !== canonicalJson(config)) {
      throw new Error(
        "Create target is already managed with a different configuration.",
      );
    }
    const result = await updateRepository(
      "upgrade",
      target,
      options,
      dependencies,
      false,
    );
    return {
      ...result,
      command: "create",
      status: result.written === 0 ? "unchanged" : result.status,
      githubPlan: null,
    };
  }

  const createSkillDependency =
    await dependencies.resolveCreateSkill(options["create-skill-source"]);
  const catalogTemplatesDirectory =
    config.catalog.enabled && options["catalog-templates-dir"]
      ? await dependencies.resolveCatalogTemplates(options["catalog-templates-dir"])
      : undefined;
  const catalogDependency = config.catalog.enabled
    ? await dependencies.resolveCatalog(
      options["catalog-script"],
      catalogTemplatesDirectory,
      config.catalog.template,
      options["catalog-registry"],
      options["catalog-registry-ref"],
    )
    : null;

  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(
    path.join(parent, `.${path.basename(target)}.create-skills-repo-`),
  );
  const catalogStage = `${stage}.catalog`;
  let renamed = false;
  try {
    const initial = await renderRepositoryTemplates(
      templateRoot,
      config,
      [],
    );
    initial.set(CONFIG_FILE, renderConfig(config));
    await writeRenderedTree(stage, initial);

    const snapshot = await readTreeAsManaged(
      createSkillDependency.source,
      "skills/create-skill",
    );
    await writeRenderedTree(stage, snapshot);
    const seededSkills = await discoverSkills(stage);
    const seededRepository = await renderRepositoryTemplates(
      templateRoot,
      config,
      seededSkills,
    );
    seededRepository.set(CONFIG_FILE, renderConfig(config));
    await writeRenderedTree(stage, seededRepository);

    if (config.catalog.enabled) {
      await dependencies.createCatalog(catalogDependency, {
        template: config.catalog.template,
        repository: `${config.owner.login}/${config.repository.name}`,
        outputDirectory: catalogStage,
        siteName: `${config.package.displayName} Catalog`,
        description: config.package.description,
        defaultBranch: config.github.defaultBranch,
        author: config.owner.name,
        packageName: config.package.name,
        marketplaceId: config.package.name,
        templatesDirectory: catalogTemplatesDirectory,
        registry: options["catalog-registry"],
        registryRef: options["catalog-registry-ref"],
        repoRoot: stage,
      });
      await composeCatalog(catalogStage, stage);
      await rm(catalogStage, { recursive: true, force: true });
    }

    const provisionalManaged = mergeMaps(seededRepository, snapshot);
    await mkdir(path.dirname(path.join(stage, STATE_FILE)), { recursive: true });
    await writeFile(
      path.join(stage, STATE_FILE),
      canonicalJson(buildState(provisionalManaged, TEMPLATE_VERSION)),
    );

    const stagedCreateSkillDependency = {
      ...createSkillDependency,
      script: path.join(
        stage,
        "skills",
        "create-skill",
        createSkillDependency.scriptRelative ?? "scripts/create-skill.mjs",
      ),
    };
    await dependencies.registerExisting(stagedCreateSkillDependency, {
      name: "create-skill",
      repoRoot: stage,
    });
    await dependencies.createExample(stagedCreateSkillDependency, {
      fixturePath,
      repoRoot: stage,
    });
    const examplePath = path.join(stage, "skills", "example-skill", "SKILL.md");
    if (!existsSync(examplePath)) {
      throw new Error(
        "create-skill completed without generating skills/example-skill/SKILL.md.",
      );
    }

    const skills = await discoverSkills(stage);
    const rendered = await renderRepositoryTemplates(templateRoot, config, skills);
    rendered.set(CONFIG_FILE, renderConfig(config));
    await writeRenderedTree(stage, rendered);
    const managed = mergeMaps(rendered, snapshot);
    await mkdir(path.dirname(path.join(stage, STATE_FILE)), { recursive: true });
    await writeFile(
      path.join(stage, STATE_FILE),
      canonicalJson(buildState(managed, TEMPLATE_VERSION)),
    );

    for (const relativePath of [
      "plugin.json",
      "marketplace.json",
      ".agents/plugins/marketplace.json",
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      ".cursor-plugin/marketplace.json",
      "gemini-extension.json",
    ]) {
      JSON.parse(await readFile(path.join(stage, relativePath), "utf8"));
    }

    await rename(stage, target);
    renamed = true;
    return {
      command: "create",
      dryRun: false,
      status: "created",
      target,
      managedFiles: managed.size,
      skills: skills.map((skill) => skill.name),
      catalog: config.catalog.enabled,
      githubPlan: createGitHubPlan(config, target),
    };
  } finally {
    if (existsSync(catalogStage)) {
      await rm(catalogStage, { recursive: true, force: true });
    }
    if (!renamed) await rm(stage, { recursive: true, force: true });
  }
}

async function prepareUpgrade(root, options, dependencies) {
  const [config, state] = await Promise.all([loadConfig(root), loadState(root)]);
  const dependency =
    await dependencies.resolveCreateSkill(options["create-skill-source"]);
  const skills = await discoverSkills(root);
  const rendered = await renderRepositoryTemplates(
    templateRoot,
    config,
    skills,
  );
  rendered.set(CONFIG_FILE, renderConfig(config));
  const snapshot = await readTreeAsManaged(dependency.source, "skills/create-skill");
  return {
    config,
    state,
    desired: mergeMaps(rendered, snapshot),
  };
}

async function inspectOperation(operation, root, options, dependencies) {
  await assertRepositoryRoot(root);
  if (operation === "upgrade") {
    const prepared = await prepareUpgrade(root, options, dependencies);
    const classification = await classifyManagedFiles(
      root,
      prepared.desired,
      prepared.state,
    );
    return { ...prepared, classification };
  }
  const [config, state] = await Promise.all([loadConfig(root), loadState(root)]);
  const stateConflicts = await inspectManagedState(root, state);
  if (stateConflicts.length > 0) {
    return {
      config,
      state,
      desired: new Map(),
      classification: {
        changes: [],
        conflicts: stateConflicts,
        unchanged: [],
      },
    };
  }
  const desired = await renderDerived(root, config, state);
  const classification = await classifyManagedFiles(root, desired, state);
  return { config, state, desired, classification };
}

async function updateRepository(operation, root, options, dependencies, dryRun) {
  const prepared = await inspectOperation(
    operation,
    root,
    options,
    dependencies,
  );
  const conflicts = prepared.classification.conflicts;
  if (dryRun || conflicts.length > 0) {
    return {
      command: operation,
      dryRun,
      status: conflicts.length > 0 ? "conflict" : "planned",
      target: root,
      changes: prepared.classification.changes,
      conflicts,
    };
  }
  const result = await applyManagedTransaction(
    root,
    prepared.desired,
    prepared.state,
    TEMPLATE_VERSION,
  );
  return {
    command: operation,
    dryRun: false,
    status: result.conflicts.length > 0 ? "conflict" : "updated",
    target: root,
    written: result.written,
    changes: result.changes,
    conflicts: result.conflicts,
  };
}

async function checkRepository(root, dependencies) {
  const prepared = await inspectOperation(
    "sync",
    root,
    {},
    dependencies,
  );
  const drift = [
    ...prepared.classification.changes,
    ...prepared.classification.conflicts,
  ];
  return {
    command: "check",
    dryRun: true,
    status: drift.length === 0 ? "clean" : "drift",
    target: root,
    drift,
  };
}

export async function execute(argv, overrides = {}) {
  const { positional, options } = parseArguments(argv);
  if (options.help || positional.length === 0) {
    return { command: "help", text: HELP };
  }
  let command = positional.shift();
  let dryRun = false;
  if (command === "dry-run") {
    dryRun = true;
    command = positional.shift();
    if (!SUPPORTED_OPERATIONS.has(command)) {
      throw new Error("dry-run requires create, upgrade, or sync.");
    }
  }
  if (![...SUPPORTED_OPERATIONS, "check"].includes(command)) {
    throw new Error(`Unknown command: ${command}.`);
  }
  assertCommandOptions(command, options);
  if (positional.length !== 1) {
    throw new Error(`${command} requires exactly one target path.`);
  }
  const target = validateTargetPath(positional[0]);
  assertOutsideRoot(target, skillRoot);
  const dependencies = productionDependencies(overrides);

  if (command === "create") {
    return dryRun
      ? createDryRun(target, options, dependencies)
      : createRepository(target, options, dependencies);
  }
  if (command === "check") return checkRepository(target, dependencies);
  return updateRepository(
    command,
    target,
    options,
    dependencies,
    dryRun,
  );
}

async function main() {
  try {
    const result = await execute(process.argv.slice(2));
    if (result.command === "help") console.log(result.text);
    else console.log(canonicalJson(result).trimEnd());
    if (result.status === "conflict" || result.status === "drift") {
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
