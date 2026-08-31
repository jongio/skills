import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export const CREATE_SKILL_INSTALL_GUIDANCE =
  "Install create-skill with: npx skills add jongio/skills --skill create-skill -g --agent github-copilot";
export const CATALOG_INSTALL_GUIDANCE =
  "Install create-gh-pages-site with: npx skills add jongio/skills --skill create-gh-pages-site -g --agent github-copilot";

function dependencyError(message) {
  const error = new Error(message);
  error.exitCode = 3;
  return error;
}

async function regularRealPath(input, label) {
  let resolved;
  try {
    resolved = await realpath(path.resolve(input));
    const metadata = await lstat(resolved);
    if (!metadata.isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw dependencyError(`${label} is unavailable at ${input}: ${error.message}`);
  }
  return resolved;
}

async function directoryRealPath(input, label) {
  let resolved;
  try {
    resolved = await realpath(path.resolve(input));
    const metadata = await lstat(resolved);
    if (!metadata.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw dependencyError(`${label} is unavailable at ${input}: ${error.message}`);
  }
  return resolved;
}

export async function resolveInputDirectory(input, label) {
  return directoryRealPath(input, label);
}

function minimalEnvironment() {
  const names = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
  ];
  return Object.fromEntries(
    names
      .filter((name) => typeof process.env[name] === "string")
      .map((name) => [name, process.env[name]]),
  );
}

export function runNodeScript(script, args, options = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd,
    env: minimalEnvironment(),
    encoding: "utf8",
    shell: false,
    timeout: options.timeout ?? 120_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${options.label ?? "Tool"} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${options.label ?? "Tool"} exited with ${result.status}${detail ? `: ${detail}` : "."}`,
    );
  }
  return result.stdout;
}

async function probeNodeScript(script, requiredText, label, guidance) {
  let output;
  try {
    output = runNodeScript(script, ["--help"], {
      cwd: path.dirname(script),
      label,
      timeout: 15_000,
    });
  } catch (error) {
    throw dependencyError(`${error.message}\n${guidance}`);
  }
  for (const fragment of requiredText) {
    if (!output.includes(fragment)) {
      throw dependencyError(
        `${label} does not support ${fragment}.\n${guidance}`,
      );
    }
  }
}

function installedSkillCandidates(skillRoot, skillName, scriptName) {
  const parent = path.dirname(skillRoot);
  return [
    path.join(parent, skillName, "scripts", scriptName),
    path.join(homedir(), ".copilot", "skills", skillName, "scripts", scriptName),
    path.join(
      homedir(),
      ".agents",
      "skills",
      skillName,
      "scripts",
      scriptName,
    ),
  ];
}

async function firstAvailableFile(candidates) {
  for (const candidate of candidates) {
    try {
      return await regularRealPath(candidate, "dependency");
    } catch {
      continue;
    }
  }
  return null;
}

async function firstAvailableDirectory(candidates) {
  for (const candidate of candidates) {
    try {
      return await directoryRealPath(candidate, "dependency");
    } catch {
      continue;
    }
  }
  return null;
}

export async function resolveCreateSkillDependency(skillRoot, explicitSource) {
  const source = explicitSource
    ? await directoryRealPath(explicitSource, "create-skill snapshot")
    : await firstAvailableDirectory([
      path.join(skillRoot, "templates", "repository", "skills", "create-skill"),
      path.join(path.dirname(skillRoot), "create-skill"),
      path.join(homedir(), ".copilot", "skills", "create-skill"),
      path.join(homedir(), ".agents", "skills", "create-skill"),
    ]);
  if (!source) {
    throw dependencyError(
      `create-skill snapshot is unavailable.\n${CREATE_SKILL_INSTALL_GUIDANCE}`,
    );
  }
  const script = await regularRealPath(
    path.join(source, "scripts", "create-skill.mjs"),
    "create-skill CLI",
  ).catch((error) => {
    throw dependencyError(`${error.message}\n${CREATE_SKILL_INSTALL_GUIDANCE}`);
  });
  await probeNodeScript(
    script,
    ["fixture", "register", "--input", "--repo-root", "--dry-run", "--approve"],
    "create-skill",
    CREATE_SKILL_INSTALL_GUIDANCE,
  );
  return { source, script, scriptRelative: "scripts/create-skill.mjs" };
}

export async function resolveCatalogDependency(
  skillRoot,
  explicitScript,
  options = {},
) {
  const candidate = explicitScript
    ? await regularRealPath(explicitScript, "create-gh-pages-site CLI")
    : await firstAvailableFile(
      installedSkillCandidates(
        skillRoot,
        "create-gh-pages-site",
        "new-site.mjs",
      ),
    );
  if (!candidate) {
    throw dependencyError(
      `create-gh-pages-site is unavailable.\n${CATALOG_INSTALL_GUIDANCE}`,
    );
  }
  await probeNodeScript(
    candidate,
    ["--repo", "--staging-dir", "--templates-dir", "--json"],
    "create-gh-pages-site",
    CATALOG_INSTALL_GUIDANCE,
  );
  if (options.templatesDirectory) {
    let templates;
    try {
      templates = runNodeScript(
        candidate,
        ["--list", "--templates-dir", options.templatesDirectory],
        {
          cwd: path.dirname(candidate),
          label: "create-gh-pages-site template discovery",
          timeout: 60_000,
        },
      );
    } catch (error) {
      throw dependencyError(`${error.message}\n${CATALOG_INSTALL_GUIDANCE}`);
    }
    if (!templates.split(/\r?\n/).some((line) =>
      line.trim().startsWith(`${options.template} `) ||
      line.trim() === options.template
    )) {
      throw dependencyError(
        `create-gh-pages-site does not provide template ${options.template}.\n${CATALOG_INSTALL_GUIDANCE}`,
      );
    }
  }
  return { script: candidate };
}

export function generateExampleSkill(dependency, options) {
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(options.fixturePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid example skill fixture: ${error.message}`, {
      cause: error,
    });
  }
  if (
    fixture?.schemaVersion !== 1 ||
    fixture?.name !== "example-skill" ||
    typeof fixture?.description !== "string" ||
    !Array.isArray(fixture?.routing?.useFor) ||
    !Array.isArray(fixture?.routing?.doNotUseFor)
  ) {
    throw new Error("Invalid example skill fixture schema.");
  }
  const baseArgs = [
    "fixture",
    "--input",
    options.fixturePath,
    "--repo-root",
    options.repoRoot,
  ];
  const previewOutput = runNodeScript(
    dependency.script,
    [...baseArgs, "--dry-run"],
    {
      cwd: options.repoRoot,
      label: "create-skill fixture preview",
    },
  );
  let preview;
  try {
    preview = JSON.parse(previewOutput);
  } catch (error) {
    throw new Error(`create-skill returned invalid preview JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (!/^[a-f0-9]{64}$/.test(preview?.hash ?? "")) {
    throw new Error("create-skill preview did not return a valid plan hash.");
  }
  runNodeScript(dependency.script, [...baseArgs, "--approve", preview.hash], {
    cwd: options.repoRoot,
    label: "create-skill fixture apply",
  });
}

export function registerExistingSkill(dependency, options) {
  const baseArgs = ["register", options.name];
  const previewOutput = runNodeScript(
    dependency.script,
    [...baseArgs, "--dry-run"],
    {
      cwd: options.repoRoot,
      label: `create-skill ${options.name} registration preview`,
    },
  );
  let preview;
  try {
    preview = JSON.parse(previewOutput);
  } catch (error) {
    throw new Error(`create-skill returned invalid registration preview JSON: ${error.message}`, {
      cause: error,
    });
  }
  if (!/^[a-f0-9]{64}$/.test(preview?.hash ?? "")) {
    throw new Error("create-skill registration preview did not return a valid plan hash.");
  }
  runNodeScript(dependency.script, [...baseArgs, "--approve", preview.hash], {
    cwd: options.repoRoot,
    label: `create-skill ${options.name} registration apply`,
  });
}

export function generateCatalog(dependency, options) {
  const args = [
    options.template,
    "--repo",
    options.repository,
    "--staging-dir",
    options.outputDirectory,
    "--json",
  ];
  for (const [flag, value] of [
    ["--site-name", options.siteName],
    ["--description", options.description],
    ["--default-branch", options.defaultBranch],
    ["--author", options.author],
    ["--package-name", options.packageName],
    ["--marketplace-id", options.marketplaceId],
    ["--registry", options.registry],
    ["--registry-ref", options.registryRef],
  ]) {
    if (value) args.push(flag, value);
  }
  if (options.templatesDirectory) {
    args.push("--templates-dir", options.templatesDirectory);
  }
  const output = runNodeScript(dependency.script, args, {
    cwd: options.repoRoot,
    label: "create-gh-pages-site",
  });
  let result;
  try {
    result = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `create-gh-pages-site returned invalid composition JSON: ${error.message}`,
      { cause: error },
    );
  }
  const [owner, repository] = options.repository.split("/");
  const expectedBase = repository.toLowerCase() === `${owner.toLowerCase()}.github.io`
    ? "/"
    : `/${repository}/`;
  if (
    result?.mode !== "staged" ||
    result?.template !== options.template ||
    path.resolve(result?.directory ?? "") !== path.resolve(options.outputDirectory) ||
    result?.replacements?.__REPO_SLUG__ !== options.repository ||
    result?.replacements?.__BASE_PATH__ !== expectedBase
  ) {
    throw new Error("create-gh-pages-site returned an invalid composition result.");
  }
  return result;
}
