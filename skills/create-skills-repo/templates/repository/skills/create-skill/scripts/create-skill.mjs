import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverRepository } from "./repository.mjs";
import { createSkillManifest, validateSkillName } from "./render.mjs";
import {
  applyPlan,
  buildArtPlan,
  buildCreatePlan,
  buildRegisterPlan,
  checkSkill,
} from "./registration.mjs";
import {
  buildArtActionPreview,
  consumeArtApproval,
  createArtApproval,
  createArtResult,
  defaultArtPrompt,
  readCustomArt,
} from "./art.mjs";
import { OPENAI_MODEL, generatePlaceholder } from "./providers.mjs";

const HELP = `create-skill

Usage:
  create-skill <name> --summary <text> --use-for <text> --do-not-use-for <text> [--author <name>] --dry-run
  create-skill <name> --summary <text> --use-for <text> --do-not-use-for <text> [--author <name>] --approve <hash>
  create-skill art <name> --provider <azure-openai|openai|placeholder|custom> [options] --dry-run
  create-skill art <name> --provider <provider> [options] --approve <token>
  create-skill register <name> --dry-run
  create-skill register <name> --approve <hash>
  create-skill check <name>
  create-skill fixture --input <fixture.json> --repo-root <path> --dry-run
  create-skill fixture --input <fixture.json> --repo-root <path> --approve <hash>

Custom art:
  Supply --custom-description, --delivery, --input, and --custom-provider after the user approves
  the exact provider and delivery workflow. The workflow may use any available tool or service.
  The input is only the delivered repository-relative PNG.
`;

export function parseArgs(argv) {
  const args = { positionals: [] };
  const valueOptions = new Set([
    "summary",
    "use-for",
    "do-not-use-for",
    "author",
    "approve",
    "provider",
    "prompt",
    "model",
    "input",
    "custom-description",
    "custom-provider",
    "custom-model",
    "custom-endpoint",
    "delivery",
    "repo-root",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") args.dryRun = true;
    else if (value === "--help" || value === "-h") args.help = true;
    else if (value.startsWith("--")) {
      const key = value.slice(2);
      if (!valueOptions.has(key)) throw new Error(`Unknown option ${value}`);
      const optionValue = argv[index + 1];
      if (!optionValue || optionValue.startsWith("--")) throw new Error(`${value} requires a value`);
      args[key] = optionValue;
      index += 1;
    } else {
      args.positionals.push(value);
    }
  }
  return args;
}

function fixtureText(value, label, maximum = 320) {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f\u2013\u2014]/.test(value)
  ) {
    throw new Error(`Fixture ${label} is invalid`);
  }
  return value;
}

export function parseFixture(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) {
    throw new Error("Fixture must be a schemaVersion 1 object");
  }
  const expected = new Set([
    "schemaVersion",
    "name",
    "title",
    "description",
    "routing",
    "behavior",
    "thumbnail",
    "author",
  ]);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length > 0) throw new Error(`Fixture has unsupported fields: ${unknown.join(", ")}`);
  validateSkillName(value.name);
  const type = value.routing?.type;
  if (!new Set(["workflow", "analysis", "utility"]).has(type)) {
    throw new Error("Fixture routing.type must be workflow, analysis, or utility");
  }
  const stringList = (items, label) => {
    if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
      throw new Error(`Fixture ${label} must be a non-empty array`);
    }
    return items.map((item) => fixtureText(item, label));
  };
  const commands = stringList(value.behavior?.commands, "behavior.commands");
  for (const command of commands) validateSkillName(command);
  if (value.thumbnail?.provider !== "builtin") {
    throw new Error("Fixture thumbnail.provider must be builtin for deterministic generation");
  }
  const manifest = createSkillManifest({
    name: value.name,
    title: fixtureText(value.title, "title", 100),
    summary: fixtureText(value.description, "description", 240),
    type,
    useFor: stringList(value.routing.useFor, "routing.useFor").join(", "),
    doNotUseFor: stringList(value.routing.doNotUseFor, "routing.doNotUseFor").join(", "),
    purpose: fixtureText(value.behavior.purpose, "behavior.purpose"),
    commands: Object.freeze(commands),
    author: fixtureText(value.author ?? "Repository contributors", "author", 100),
  });
  return Object.freeze({
    ...manifest,
    prompt: fixtureText(value.thumbnail.prompt, "thumbnail.prompt", 1000),
  });
}

export function loadFixture(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw new Error(`Cannot read fixture input: ${error.message}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) {
    throw new Error("Fixture input must be a regular JSON file no larger than 64 KiB");
  }
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse fixture JSON: ${error.message}`);
  }
  return parseFixture(value);
}

function newManifest(name, args) {
  return createSkillManifest({
    name,
    summary: args.summary,
    useFor: args["use-for"],
    doNotUseFor: args["do-not-use-for"],
    author: args.author,
  });
}

export function manifestFromExistingSkill(profile, name) {
  validateSkillName(name);
  const path = join(profile.paths.skills, name, "SKILL.md");
  const text = readFileSync(path, "utf8");
  const folded = text.match(
    /^description:\s*[>|][+-]?\s*\r?\n((?:(?:[ \t]+[^\r\n]*)?\r?\n)*)/m,
  )?.[1]
    ?.replace(/^\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const scalar = text.match(/^description:\s*(?![>|][+-]?\s*$)(.+)$/m)?.[1]?.trim();
  let description = folded ?? scalar;
  if (description?.startsWith('"') && description.endsWith('"')) {
    description = JSON.parse(description);
  } else if (description?.startsWith("'") && description.endsWith("'")) {
    description = description.slice(1, -1).replaceAll("''", "'");
  }
  description = description?.replace(/\s+/g, " ").trim();
  if (!description) throw new Error(`Cannot read description from ${path}`);
  const summary = description
    .replace(/^\*\*(?:WORKFLOW|ANALYSIS|UTILITY) SKILL\*\*\s*-\s*/i, "")
    .split(/\s+(?:USE FOR:|Use when\b)/i)[0]
    .replace(/[\u2013\u2014]/g, ",")
    .trim();
  const useFor = description.match(/\bUSE FOR:\s*(.*?)(?:\s+DO NOT USE FOR:|$)/i)?.[1]?.trim()
    ?? `Use ${name}`;
  return Object.freeze({ name, summary, useFor, version: "1.0.0" });
}

function targetPaths(profile, name) {
  const targets = [
    join(profile.paths.skills, name, "thumbnail.png"),
    profile.catalogEnabled && profile.paths.catalogImages
      ? join(profile.paths.catalogImages, `thumb-${name}.png`)
      : null,
    profile.paths.thumbnailPrompts,
  ].filter(Boolean);
  return targets.map((path) => relative(profile.root, path).split(sep).join("/"));
}

function print(value, output) {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function run(argv, context = {}) {
  const args = parseArgs(argv);
  const output = context.output ?? process.stdout;
  const cwd = context.cwd ?? process.cwd();
  const discover = context.discover ?? discoverRepository;
  if (args.help || args.positionals.length === 0) {
    output.write(HELP);
    return args.help ? 0 : 1;
  }

  const command = ["art", "check", "fixture", "register"].includes(args.positionals[0])
    ? args.positionals[0]
    : "create";
  if (command === "fixture" && args.positionals.length !== 1) {
    throw new Error("Fixture mode accepts no positional arguments");
  }
  if (command === "fixture" && !args.input) {
    throw new Error("Fixture mode requires --input");
  }
  const fixture = command === "fixture"
    ? loadFixture(resolve(cwd, args.input))
    : null;
  const name = command === "create"
    ? args.positionals[0]
    : command === "fixture"
      ? fixture.name
      : args.positionals[1];
  validateSkillName(name);
  if (command === "fixture" && !args["repo-root"]) {
    throw new Error("Fixture mode requires --repo-root");
  }
  const profile = discover(
    command === "fixture" ? resolve(cwd, args["repo-root"]) : cwd,
  );

  if (command === "check") {
    const result = checkSkill(profile, name);
    print(result, output);
    return result.ok ? 0 : 2;
  }

  if (command === "register") {
    const manifest = manifestFromExistingSkill(profile, name);
    const bytes = readFileSync(join(profile.paths.skills, name, "thumbnail.png"));
    const plan = buildRegisterPlan(profile, manifest, {
      bytes,
      prompt: defaultArtPrompt(manifest),
      provenance: {
        provider: "bundled-snapshot",
        model: "deterministic-local-v1",
      },
    });
    const result = applyPlan(plan, { dryRun: args.dryRun, approval: args.approve });
    print(result, output);
    return args.dryRun || result.applied ? 0 : 2;
  }

  if (command === "create" || command === "fixture") {
    const manifest = command === "fixture"
      ? fixture
      : newManifest(name, args);
    const placeholder = generatePlaceholder();
    const art = {
      ...placeholder,
      prompt: command === "fixture" ? fixture.prompt : defaultArtPrompt(manifest),
    };
    const plan = buildCreatePlan(profile, manifest, { art });
    const result = applyPlan(plan, { dryRun: args.dryRun, approval: args.approve });
    print(result, output);
    return args.dryRun || result.applied ? 0 : 2;
  }

  const manifest = manifestFromExistingSkill(profile, name);
  const provider = args.provider ?? "placeholder";
  const prompt = args.prompt ?? defaultArtPrompt(manifest);
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureDeployment = "gpt-image-2";
  const customResult = provider === "custom"
    ? readCustomArt(profile.root, args.input, {
        provider: args["custom-provider"],
        model: args["custom-model"],
        endpoint: args["custom-endpoint"],
        delivery: args.delivery,
      })
    : null;
  const preview = buildArtActionPreview({
    name,
    provider,
    prompt,
    targets: targetPaths(profile, name),
    endpoint: provider === "azure-openai" ? azureEndpoint : undefined,
    deployment: provider === "azure-openai" ? azureDeployment : undefined,
    model: args.model ?? OPENAI_MODEL,
    billed: provider === "custom",
    customDescription: args["custom-description"],
    customProvider: args["custom-provider"],
    customModel: args["custom-model"],
    customEndpoint: args["custom-endpoint"],
    delivery: args.delivery,
    input: provider === "custom" ? args.input : undefined,
    inputDigest: customResult
      ? createHash("sha256").update(customResult.bytes).digest("hex")
      : undefined,
  });
  const approvalHash = args.dryRun ? createArtApproval(preview) : args.approve;
  if (args.dryRun) {
    print({ ...preview, approvalHash }, output);
    return 0;
  }
  consumeArtApproval(preview, args.approve, {
    stateRoot: context.approvalStateRoot,
  });
  const art = await createArtResult(provider, {
    root: profile.root,
    prompt,
    inputPath: args.input,
    model: args.model ?? OPENAI_MODEL,
    endpoint: azureEndpoint,
    deployment: azureDeployment,
    customResult,
    provenance: {
      provider: args["custom-provider"],
      model: args["custom-model"],
      endpoint: args["custom-endpoint"],
      delivery: args.delivery,
    },
  });
  const plan = buildArtPlan(profile, manifest, art);
  const result = applyPlan(plan, { approval: plan.hash });
  print({ ...result, actionApproval: approvalHash }, output);
  return 0;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`create-skill: ${error.message}\n`);
      process.exitCode = 1;
    });
}
