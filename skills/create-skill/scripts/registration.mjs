import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertValidPng } from "./png.mjs";
import { renderSkillFiles, validateSkillName } from "./render.mjs";

function toBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function escapeMarkdownTableCell(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, " ");
}

function addReadmeRow(text, manifest, skillsRelative) {
  const marker = `](skills/${manifest.name}/)`;
  if (text.includes(marker) || text.includes(`](${skillsRelative}/${manifest.name}/)`)) return text;
  const lines = text.split(/\r?\n/);
  const rowIndexes = lines
    .map((line, index) => (/^\|\s*\[`[^`]+`\]\([^)]+\)\s*\|/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (rowIndexes.length === 0) throw new Error("README skill catalog table could not be identified");
  const insertion = rowIndexes.at(-1) + 1;
  lines.splice(
    insertion,
    0,
    `| [\`${manifest.name}\`](${skillsRelative}/${manifest.name}/) | ${escapeMarkdownTableCell(manifest.summary)} |`,
  );
  return lines.join("\n");
}

function addMarketplaceEntry(text, manifest, skillsRelative) {
  const value = JSON.parse(text);
  if (!Array.isArray(value.plugins)) throw new Error("Marketplace manifest must contain plugins");
  const existing = value.plugins.find((entry) => entry.name === manifest.name);
  const expectedSource = `./${skillsRelative}/${manifest.name}`;
  if (existing) {
    if (existing.source !== expectedSource) {
      throw new Error(`Marketplace entry ${manifest.name} points to ${existing.source}`);
    }
    return text;
  }
  value.plugins.push({
    name: manifest.name,
    source: expectedSource,
    description: manifest.summary,
    version: manifest.version,
  });
  return json(value);
}

function addPluginKeyword(text, manifest) {
  const value = JSON.parse(text);
  if (!Array.isArray(value.keywords)) throw new Error("Plugin manifest must contain keywords");
  if (!value.keywords.includes(manifest.name)) value.keywords.push(manifest.name);
  return json(value);
}

function addEvalEntry(text, manifest, skillsRelative) {
  if (text.includes(`"skill_id":"${manifest.name}"`)) return text;
  if (
    /find\s+skills\b/.test(text) &&
    /skills\/\*\/evals\/\*\/eval\.yaml/.test(text) &&
    /all=\$\(jq\s+-sc/.test(text)
  ) {
    return text;
  }
  const block = text.match(/(\s+all='\[\r?\n)([\s\S]*?)(\r?\n\s+\]')/);
  if (!block) throw new Error("Eval workflow skill matrix could not be identified");
  const indent = block[1].match(/\n(\s*)all=/)?.[1] ?? "";
  const itemIndent = `${indent}  `;
  const existing = block[2].trimEnd();
  const comma = existing.trim().length === 0 ? "" : existing.trimEnd().endsWith(",") ? "" : ",";
  const entry =
    `${itemIndent}{"skill":"${skillsRelative}/${manifest.name}",` +
    `"skill_id":"${manifest.name}",` +
    `"eval_spec":"evals/${manifest.name}/eval.yaml"}`;
  return text.replace(block[0], `${block[1]}${existing}${comma}\n${entry}${block[3]}`);
}

function addDependabotEntry(text, manifest, skillsRelative) {
  const directory = `/${skillsRelative}/${manifest.name}`;
  const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^\\s*directory:\\s*["']?${escaped}["']?\\s*$`, "m").test(text)) {
    return text;
  }
  if (!/^version:\s*2\s*$/m.test(text) || !/^updates:\s*$/m.test(text)) {
    throw new Error("Dependabot configuration does not use version 2 updates");
  }
  const suffix = `  - package-ecosystem: npm
    directory: ${directory}
    schedule:
      interval: weekly
    open-pull-requests-limit: 2
`;
  return `${text.trimEnd()}\n${suffix}`;
}

function renderCatalogEntry(manifest, repository) {
  if (!repository) throw new Error("Catalog entry requires a GitHub repository identity");
  return `---
title: ${manifest.name}
tagline: ${JSON.stringify(manifest.summary)}
useWhen: ${JSON.stringify(manifest.useFor)}
repoPath: skills/${manifest.name}
thumb: images/thumb-${manifest.name}.png
install:
  - label: Install for GitHub Copilot
    cmd: ${JSON.stringify(`npx skills add ${repository} --skill ${manifest.name} -g --agent github-copilot`)}
---

## What it does

${manifest.summary}

## Use it

\`\`\`text
/${manifest.name}
\`\`\`
`;
}

function renderProvenance(manifest, prompt, provenance, digest) {
  const fields = [
    `## ${manifest.name} (${digest.slice(0, 12)})`,
    "",
    `Prompt: ${JSON.stringify(prompt)}`,
    "",
    `Provider: ${provenance.provider}`,
  ];
  for (const key of ["model", "deployment", "endpoint", "apiVersion", "delivery"]) {
    if (provenance[key]) fields.push(`${key}: ${provenance[key]}`);
  }
  fields.push(`SHA-256: ${digest}`, "");
  return fields.join("\n");
}

function safeProvenance(value) {
  const blocked = /(?:token|secret|password|api[-_]?key|authorization|cookie)/i;
  const output = {};
  for (const [key, item] of Object.entries(value ?? {})) {
    if (blocked.test(key)) throw new Error(`Provenance field ${key} may contain a secret`);
    if (typeof item === "string" && item.length <= 500 && !/[\r\n\u0000]/.test(item)) {
      if (key === "endpoint") {
        const url = new URL(item);
        if (url.username || url.password || url.search || url.hash || item !== url.origin) {
          throw new Error("Provenance endpoint must be an exact origin without credentials");
        }
      }
      output[key] = item;
    }
  }
  if (!output.provider) throw new Error("Art provenance must identify the provider");
  return output;
}

export function hashPlan(mutations) {
  const hash = createHash("sha256");
  for (const mutation of [...mutations].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(mutation.path);
    hash.update("\0");
    hash.update(mutation.expected ?? Buffer.from("create"));
    hash.update("\0");
    hash.update(mutation.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function makePlan(root, values) {
  const mutations = [...values.entries()]
    .map(([path, value]) => {
      const bytes = toBuffer(value);
      const current = existsSync(path) ? readFileSync(path) : null;
      return current?.equals(bytes)
        ? null
        : {
            path,
            bytes,
            expected: current,
            action: current ? "update" : "create",
          };
    })
    .filter(Boolean);
  return Object.freeze({
    root,
    mutations: Object.freeze(mutations),
    hash: hashPlan(mutations),
  });
}

function hashManagedContent(value, normalization) {
  const bytes = toBuffer(value);
  const normalized = normalization === "lf"
    ? Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8")
    : bytes;
  return createHash("sha256").update(normalized).digest("hex");
}

function addManagedStateUpdate(profile, values) {
  if (profile.mode !== "managed") return;
  const statePath = join(profile.root, ".skills-repo", "state.json");
  let state;
  try {
    state = JSON.parse(readText(statePath));
  } catch (error) {
    throw new Error(`Managed repository state is unreadable: ${error.message}`);
  }
  if (
    state?.schemaVersion !== 1 ||
    state?.hashVersion !== 1 ||
    !state.files ||
    typeof state.files !== "object" ||
    Array.isArray(state.files)
  ) {
    throw new Error("Managed repository state has an invalid schema");
  }
  let changed = false;
  for (const [absolute, value] of values) {
    const relativePath = relative(profile.root, absolute).split(sep).join("/");
    const record = state.files[relativePath];
    if (!record) continue;
    if (
      !["lf", "raw"].includes(record.normalization) ||
      !/^[a-f0-9]{64}$/.test(record.sha256 ?? "")
    ) {
      throw new Error(`Managed repository state has an invalid record for ${relativePath}`);
    }
    record.sha256 = hashManagedContent(value, record.normalization);
    changed = true;
  }
  if (changed) values.set(statePath, json(state));
}

export function buildRegistrationUpdates(profile, manifest, art) {
  const provenance = safeProvenance(art.provenance);
  const values = new Map();
  const skillsRelative = relative(profile.root, profile.paths.skills).split(sep).join("/");
  if (profile.paths.readme) {
    values.set(
      profile.paths.readme,
      addReadmeRow(readText(profile.paths.readme), manifest, skillsRelative),
    );
  }
  if (profile.paths.marketplace) {
    values.set(
      profile.paths.marketplace,
      addMarketplaceEntry(readText(profile.paths.marketplace), manifest, skillsRelative),
    );
  }
  if (profile.paths.plugin) {
    values.set(profile.paths.plugin, addPluginKeyword(readText(profile.paths.plugin), manifest));
  }
  if (profile.paths.evalWorkflow) {
    values.set(
      profile.paths.evalWorkflow,
      addEvalEntry(readText(profile.paths.evalWorkflow), manifest, skillsRelative),
    );
  }
  if (profile.paths.dependabot) {
    values.set(
      profile.paths.dependabot,
      addDependabotEntry(readText(profile.paths.dependabot), manifest, skillsRelative),
    );
  }
  if (profile.catalogEnabled) {
    if (!profile.paths.catalogEntries || !profile.paths.catalogImages) {
      throw new Error("Catalog registration requires both entry and image paths");
    }
    values.set(
      join(profile.paths.catalogEntries, `${manifest.name}.md`),
      renderCatalogEntry(manifest, profile.identity?.repository),
    );
    values.set(join(profile.paths.catalogImages, `thumb-${manifest.name}.png`), art.bytes);
  }
  if (profile.paths.thumbnailPrompts) {
    const current = readText(profile.paths.thumbnailPrompts);
    const digest = createHash("sha256").update(art.bytes).digest("hex");
    if (!current.includes(`SHA-256: ${digest}`)) {
      values.set(
        profile.paths.thumbnailPrompts,
        `${current.trimEnd()}\n\n${renderProvenance(
          manifest,
          art.prompt,
          provenance,
          digest,
        )}`,
      );
    }
  }
  addManagedStateUpdate(profile, values);
  return values;
}

export function buildCreatePlan(profile, manifest, options = {}) {
  const skillDir = join(profile.paths.skills, manifest.name);
  if (existsSync(skillDir)) throw new Error(`Skill directory already exists: ${skillDir}`);
  if (!profile.paths.vallyLock || !existsSync(profile.paths.vallyLock)) {
    throw new Error("Repository does not expose a locked Vally toolchain");
  }
  const thumbnail = assertValidPng(options.art.bytes);
  const skillFiles = renderSkillFiles(manifest, {
    lockfile: readText(profile.paths.vallyLock),
    thumbnail,
    repository: profile.identity?.repository,
  });
  const values = new Map();
  for (const [path, content] of skillFiles) values.set(join(skillDir, path), content);
  for (const [path, content] of buildRegistrationUpdates(profile, manifest, options.art)) {
    values.set(path, content);
  }
  return makePlan(profile.root, values);
}

export function buildRegisterPlan(profile, manifest, art) {
  const thumbnail = assertValidPng(art.bytes);
  return makePlan(
    profile.root,
    buildRegistrationUpdates(profile, manifest, {
      ...art,
      bytes: thumbnail,
    }),
  );
}

export function buildArtPlan(profile, manifest, art) {
  const bytes = assertValidPng(art.bytes);
  const provenance = safeProvenance(art.provenance);
  const values = new Map();
  const installed = join(profile.paths.skills, manifest.name, "thumbnail.png");
  if (!existsSync(dirname(installed))) throw new Error(`Skill ${manifest.name} does not exist`);
  values.set(installed, bytes);
  if (profile.catalogEnabled) {
    if (!profile.paths.catalogImages) throw new Error("Catalog image path is unavailable");
    values.set(join(profile.paths.catalogImages, `thumb-${manifest.name}.png`), bytes);
  }
  if (profile.paths.thumbnailPrompts) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const current = readText(profile.paths.thumbnailPrompts);
    if (!current.includes(`SHA-256: ${digest}`)) {
      values.set(
        profile.paths.thumbnailPrompts,
        `${current.trimEnd()}\n\n${renderProvenance(
          manifest,
          art.prompt,
          provenance,
          digest,
        )}`,
      );
    }
  }
  return makePlan(profile.root, values);
}

function ensureSafeDestination(root, path) {
  const absolute = resolve(path);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel === "") {
    throw new Error(`Unsafe plan destination ${path}`);
  }

  let current = dirname(absolute);
  while (current !== root && current.startsWith(root)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Plan destination has a symbolic link ancestor: ${path}`);
    }
    current = dirname(current);
  }
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    throw new Error(`Plan destination is a symbolic link: ${path}`);
  }
}

function matchesExpected(mutation) {
  if (mutation.expected === null) return !existsSync(mutation.path);
  return existsSync(mutation.path) && readFileSync(mutation.path).equals(mutation.expected);
}

function acquirePlanLock(root) {
  const lockPath = `${resolve(root)}.create-skill.lock`;
  const owner = `${process.pid}.${randomBytes(16).toString("hex")}`;
  const candidate = `${lockPath}.${owner}.candidate`;
  writeFileSync(candidate, `${owner}\n`, { flag: "wx", mode: 0o600 });
  try {
    linkSync(candidate, lockPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      const currentOwner = readFileSync(lockPath, "utf8").trim() || "unknown";
      throw new Error(
        `Another create-skill operation holds ${lockPath} for ${currentOwner}. Remove the lock only after confirming that operation has stopped.`,
      );
    }
    throw error;
  } finally {
    rmSync(candidate, { force: true });
  }
  return () => {
    const currentOwner = readFileSync(lockPath, "utf8").trim();
    if (currentOwner !== owner) {
      throw new Error(`Refusing to release create-skill lock owned by ${currentOwner || "unknown"}.`);
    }
    rmSync(lockPath);
  };
}

function applyPlanUnlocked(plan, options = {}) {
  if (options.dryRun) {
    return {
      applied: false,
      hash: plan.hash,
      changes: plan.mutations.map(({ path, action, bytes }) => ({
        path: relative(plan.root, path).split(sep).join("/"),
        action,
        bytes: bytes.length,
      })),
    };
  }
  if (!options.approval || options.approval !== plan.hash) {
    throw new Error(`Apply requires the single-use approval hash ${plan.hash}`);
  }
  for (const mutation of plan.mutations) ensureSafeDestination(plan.root, mutation.path);
  for (const mutation of plan.mutations) {
    if (!matchesExpected(mutation)) {
      throw new Error(`Plan source changed since preview: ${mutation.path}`);
    }
  }

  const token = `${process.pid}.${randomBytes(8).toString("hex")}`;
  const staged = [];
  const applied = [];
  const createdDirectories = new Set();
  try {
    for (const mutation of plan.mutations) {
      let parent = dirname(mutation.path);
      while (parent !== plan.root && !existsSync(parent)) {
        createdDirectories.add(parent);
        parent = dirname(parent);
      }
      mkdirSync(dirname(mutation.path), { recursive: true });
      const temporary = `${mutation.path}.${token}.tmp`;
      const existed = existsSync(mutation.path);
      const backup = existed ? `${mutation.path}.${token}.bak` : null;
      writeFileSync(temporary, mutation.bytes, { flag: "wx" });
      if (backup) copyFileSync(mutation.path, backup);
      staged.push({ ...mutation, temporary, backup, existed });
    }
    for (const item of staged) {
      if (!matchesExpected(item)) {
        throw new Error(`Plan source changed during apply: ${item.path}`);
      }
      renameSync(item.temporary, item.path);
      applied.push(item);
      if (options.afterWrite) options.afterWrite(item, applied.length);
    }
    for (const item of staged) {
      if (!readFileSync(item.path).equals(item.bytes)) {
        throw new Error(`Post-write verification failed for ${item.path}`);
      }
    }
  } catch (error) {
    const preserved = [];
    for (const item of [...applied].reverse()) {
      if (!existsSync(item.path) || !readFileSync(item.path).equals(item.bytes)) {
        preserved.push(item.path);
        continue;
      }
      if (item.backup && existsSync(item.backup)) {
        copyFileSync(item.backup, item.path);
      } else if (!item.existed) {
        rmSync(item.path, { force: true });
      }
    }
    for (const item of staged) {
      rmSync(item.temporary, { force: true });
      if (item.backup) rmSync(item.backup, { force: true });
    }
    for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
      try {
        rmdirSync(directory);
      } catch {
      }
    }
    if (preserved.length > 0) {
      throw new Error(
        `Atomic apply failed. Rollback preserved external edits to: ${preserved.sort().join(", ")}. ${error.message}`,
        { cause: error },
      );
    }
    throw new Error(`Atomic apply failed and was rolled back: ${error.message}`);
  }

  const cleanupFailures = [];
  for (const item of staged) {
    if (!item.backup) continue;
    try {
      rmSync(item.backup, { force: true });
    } catch (error) {
      cleanupFailures.push(`${item.backup}: ${error.message}`);
    }
  }
  return {
    applied: true,
    hash: plan.hash,
    changes: plan.mutations.length,
    cleanupFailures,
  };
}

export function applyPlan(plan, options = {}) {
  if (options.dryRun || !options.approval || options.approval !== plan.hash) {
    return applyPlanUnlocked(plan, options);
  }
  const release = acquirePlanLock(plan.root);
  try {
    return applyPlanUnlocked(plan, options);
  } finally {
    release();
  }
}

export function checkSkill(profile, name) {
  validateSkillName(name);
  const dir = join(profile.paths.skills, name);
  const required = [
    "SKILL.md",
    "README.md",
    "LICENSE",
    "package.json",
    "package-lock.json",
    ".vally.yaml",
    "thumbnail.png",
    `evals/${name}/eval.yaml`,
  ];
  const failures = required
    .filter((path) => !existsSync(join(dir, path)))
    .map((path) => `missing ${path}`);
  if (existsSync(join(dir, "thumbnail.png"))) {
    try {
      assertValidPng(readFileSync(join(dir, "thumbnail.png")));
    } catch (error) {
      failures.push(`thumbnail.png: ${error.message}`);
    }
  }
  if (profile.catalogEnabled && profile.paths.catalogImages) {
    const installed = join(dir, "thumbnail.png");
    const catalog = join(profile.paths.catalogImages, `thumb-${name}.png`);
    if (!existsSync(catalog)) failures.push("missing catalog thumbnail");
    else if (existsSync(installed) && !readFileSync(installed).equals(readFileSync(catalog))) {
      failures.push("catalog thumbnail differs from skill thumbnail");
    }
  }
  if (existsSync(dir)) {
    const names = readdirSync(dir);
    if (!names.includes("test")) failures.push("missing test directory");
  }
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}
