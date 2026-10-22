import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { applyRepositoryPlan, buildRepositoryPlan } from "./registration.mjs";
import { bumpVersion, readSkillVersion, setSkillVersion, validateVersion } from "./versions.mjs";

const MANIFESTS = ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "gemini-extension.json"];
const MARKETPLACES = ["marketplace.json", ".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function planVersions(root, { command = "check", target, level } = {}) {
  root = resolve(root);
  if (!["check", "sync", "bump"].includes(command)) throw new Error(`Unknown version command: ${command}`);
  const values = new Map();
  const read = (file) => {
    const absolute = join(root, file);
    let current = root;
    for (const part of file.split(/[\\/]/)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Version source is a symbolic link: ${file}`);
    }
    return readFileSync(absolute, "utf8");
  };
  const parse = (file) => JSON.parse(read(file));
  const put = (file, value) => {
    if (JSON.stringify(parse(file)) !== JSON.stringify(value)) {
      values.set(join(root, file), json(value));
    }
  };
  const plugin = parse("plugin.json");
  const config = existsSync(join(root, "skills-repo.config.json")) ? parse("skills-repo.config.json") : null;
  let aggregateVersion = validateVersion(config ? config.package.version : plugin.version, "package version");
  const marketplace = parse("marketplace.json");
  const skills = new Map();
  for (const entry of readdirSync(join(root, "skills"), { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(root, "skills", entry.name, "SKILL.md"))) continue;
    const file = `skills/${entry.name}/SKILL.md`;
    const source = read(file);
    let version = readSkillVersion(source, { optional: command === "sync" });
    if (!version) {
      const listings = marketplace.plugins.filter((item) => item.name === entry.name && item.source === `./skills/${entry.name}`);
      if (listings.length !== 1) throw new Error(`Cannot migrate version for ${entry.name}: expected one marketplace entry.`);
      version = validateVersion(listings[0].version, `${entry.name} legacy version`);
      values.set(join(root, file), setSkillVersion(source, version));
    }
    skills.set(entry.name, { file, source, version });
  }
  const extensions = existsSync(join(root, "extensions", "plugin.json")) ? parse("extensions/plugin.json") : null;
  if (extensions) validateVersion(extensions.version, "extensions version");
  if (command === "bump") {
    if (target === "package") aggregateVersion = bumpVersion(aggregateVersion, level);
    else if (target === "statuslines" && extensions) {
      extensions.version = bumpVersion(extensions.version, level);
      put("extensions/plugin.json", extensions);
      aggregateVersion = bumpVersion(aggregateVersion, "patch");
    } else {
      const skill = skills.get(target);
      if (!skill) throw new Error(`Unknown version target: ${target}`);
      skill.version = bumpVersion(skill.version, level);
      values.set(join(root, skill.file), setSkillVersion(skill.source, skill.version));
      aggregateVersion = bumpVersion(aggregateVersion, "patch");
    }
  }
  const bundledAuthoring = "skills/create-skills-repo/templates/repository/skills/create-skill/SKILL.md";
  if (skills.has("create-skill") && existsSync(join(root, bundledAuthoring))) {
    values.set(join(root, bundledAuthoring), setSkillVersion(read(bundledAuthoring), skills.get("create-skill").version));
    if (command === "bump" && target === "create-skill" && skills.has("create-skills-repo")) {
      const generator = skills.get("create-skills-repo");
      generator.version = bumpVersion(generator.version, "patch");
      values.set(join(root, generator.file), setSkillVersion(generator.source, generator.version));
    }
  }
  if (config) {
    config.package.version = aggregateVersion;
    put("skills-repo.config.json", config);
  }
  for (const file of MANIFESTS) {
    const manifest = file === "plugin.json" ? plugin : parse(file);
    manifest.version = aggregateVersion;
    put(file, manifest);
  }
  for (const file of MARKETPLACES) {
    const manifest = file === "marketplace.json" ? marketplace : parse(file);
    const names = new Set();
    for (const entry of manifest.plugins) {
      if (names.has(entry.name)) throw new Error(`Duplicate plugin ${entry.name} in ${file}`);
      names.add(entry.name);
      if (entry.name === plugin.name && entry.source === "./") entry.version = aggregateVersion;
      else if (extensions && entry.name === extensions.name && entry.source === "./extensions") entry.version = extensions.version;
      else if (skills.has(entry.name) && entry.source === `./skills/${entry.name}`) entry.version = skills.get(entry.name).version;
      else throw new Error(`Unknown local plugin mapping in ${file}: ${entry.name}`);
    }
    if (!names.has(plugin.name)) throw new Error(`${file} is missing the aggregate plugin.`);
    if (file === "marketplace.json") {
      for (const name of skills.keys()) {
        if (!names.has(name)) throw new Error(`Marketplace is missing skill ${name}. Run create-skill register first.`);
      }
    }
    // Marketplace metadata describes the catalog, not an independently released plugin.
    put(file, manifest);
  }
  // Do not add unsupported version fields to the Codex marketplace index.
  const plan = buildRepositoryPlan(root, values);
  return Object.freeze({ ...plan, managed: config !== null });
}

export function runVersionCommand(root, argv) {
  const args = argv.filter((value) => value !== "--dry-run");
  const [command, target, level] = args;
  if (!["check", "sync", "bump"].includes(command) ||
      args.length !== (command === "bump" ? 3 : 1)) {
    throw new Error("Usage: version-skills.mjs check|sync|bump <package|skill-name|statuslines> <major|minor|patch> [--dry-run]");
  }
  if (command === "check" || argv.includes("--dry-run")) {
    const plan = planVersions(root, { command, target, level });
    const changes = changedPaths(plan);
    return { status: changes.length ? (command === "check" ? "drift" : "planned") : "clean", changes };
  }
  const { plan, result } = applyRepositoryPlan(root, () => planVersions(root, { command, target, level }));
  if (result.cleanupFailures.length) throw new Error(result.cleanupFailures.join("\n"));
  const changes = changedPaths(plan);
  return { status: changes.length ? "updated" : "clean", changes };
}

function changedPaths(plan) {
  return plan.mutations.map((item) => item.path.slice(plan.root.length + 1).split(sep).join("/"));
}
