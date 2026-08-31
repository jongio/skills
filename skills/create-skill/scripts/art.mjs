import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertValidPng } from "./png.mjs";
import { generateBuiltInArt } from "./providers.mjs";

export const BUILT_IN_PROVIDERS = Object.freeze([
  "azure-openai",
  "openai",
  "placeholder",
]);

export function defaultArtPrompt(manifest) {
  return [
    `Create a square thumbnail for the ${manifest.name} agent skill.`,
    manifest.summary,
    "Use a pure white background and a centered flat vector illustration.",
    "Show one hero surface with a clear left to right transformation into a completed skill package.",
    "Use small status badges, subtle guide lines, soft shadows, and one restrained accent palette.",
    "Include a small Octocat mark with a dotted tether.",
    "Use minimal text. Keep all important details legible at card size.",
    "Output exactly 1024x1024 pixels.",
  ].join(" ");
}

export function buildArtActionPreview(input) {
  const provider = input.provider;
  if (![...BUILT_IN_PROVIDERS, "custom"].includes(provider)) {
    throw new Error(`Unknown art provider ${provider}`);
  }
  const preview = {
    skill: input.name,
    provider,
    prompt: input.prompt,
    targets: [...input.targets].sort(),
    billed: provider === "azure-openai" || provider === "openai" || input.billed === true,
    attempts: 1,
    fallback: "none",
  };
  if (provider === "azure-openai") {
    if (!input.endpoint) throw new Error("Azure OpenAI art preview requires an exact endpoint");
    if (!input.deployment) throw new Error("Azure OpenAI art preview requires an exact deployment");
    preview.endpoint = input.endpoint;
    preview.model = "gpt-image-2";
    preview.deployment = input.deployment;
  } else if (provider === "openai") {
    preview.endpoint = "https://api.openai.com";
    preview.model = input.model;
  } else if (provider === "custom") {
    if (typeof input.customDescription !== "string" || input.customDescription.trim().length < 10) {
      throw new Error("Custom art requires an exact provider and delivery description");
    }
    preview.customAction = input.customDescription.trim();
    if (typeof input.customProvider !== "string" || input.customProvider.trim().length < 2) {
      throw new Error("Custom art preview requires the provider name");
    }
    if (typeof input.delivery !== "string" || input.delivery.trim().length < 2) {
      throw new Error("Custom art preview requires the delivery method");
    }
    preview.customProvider = input.customProvider.trim();
    preview.delivery = input.delivery;
    if (input.customModel) preview.customModel = input.customModel;
    if (input.customEndpoint) {
      const endpoint = new URL(input.customEndpoint);
      if (
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        input.customEndpoint !== endpoint.origin
      ) {
        throw new Error("Custom art endpoint must be an exact origin without credentials");
      }
      preview.customEndpoint = endpoint.origin;
    }
    if (typeof input.input !== "string" || !/^[a-f0-9]{64}$/.test(input.inputDigest ?? "")) {
      throw new Error("Custom art preview requires a validated delivered PNG and digest");
    }
    preview.input = input.input;
    preview.inputDigest = input.inputDigest;
  } else {
    preview.model = "deterministic-local-v1";
  }
  return Object.freeze(preview);
}

export function hashArtAction(preview, nonce = "") {
  return createHash("sha256")
    .update(nonce)
    .update("\0")
    .update(JSON.stringify(preview))
    .digest("hex");
}

export function createArtApproval(preview, nonce = randomBytes(16).toString("hex")) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) {
    throw new Error("Art approval nonce must contain 32 lowercase hexadecimal characters");
  }
  return `${nonce}.${hashArtAction(preview, nonce)}`;
}

export function consumeArtApproval(preview, token, options = {}) {
  const match = token?.match(/^([a-f0-9]{32})\.([a-f0-9]{64})$/);
  if (!match || hashArtAction(preview, match[1]) !== match[2]) {
    throw new Error("Art action requires the approval token from its latest preview");
  }
  const stateRoot = options.stateRoot ??
    join(homedir(), ".create-skill", "consumed-approvals");
  mkdirSync(stateRoot, { recursive: true });
  const marker = join(
    stateRoot,
    createHash("sha256").update(token).digest("hex"),
  );
  try {
    writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("Art approval token has already been used");
    }
    throw error;
  }
  return token;
}

export function readCustomArt(root, inputPath, provenance) {
  if (
    typeof inputPath !== "string" ||
    isAbsolute(inputPath) ||
    /^[A-Za-z]:/.test(inputPath)
  ) {
    throw new Error("Custom art input must be a repository-relative path");
  }
  const path = resolve(root, inputPath);
  const rel = relative(root, path);
  if (
    rel === "" ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    !existsSync(path)
  ) {
    throw new Error("Custom art input must exist inside the repository");
  }
  let ancestor = dirname(path);
  while (ancestor !== resolve(root)) {
    if (lstatSync(ancestor).isSymbolicLink()) {
      throw new Error("Custom art input must not have a symbolic link ancestor");
    }
    ancestor = dirname(ancestor);
  }
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error("Custom art input must be a regular file, not a symbolic link");
  }
  const realRoot = realpathSync(root);
  const realInput = realpathSync(path);
  const realRelative = relative(realRoot, realInput);
  if (
    isAbsolute(realRelative) ||
    realRelative === ".." ||
    realRelative.startsWith(`..${sep}`)
  ) {
    throw new Error("Custom art input resolves outside the repository");
  }
  return {
    bytes: assertValidPng(readFileSync(path)),
    provenance: {
      provider: provenance.provider,
      model: provenance.model,
      endpoint: provenance.endpoint,
      delivery: provenance.delivery,
    },
  };
}

export async function createArtResult(provider, options) {
  const prompt = options.prompt;
  let result;
  if (provider === "custom") {
    result = options.customResult ??
      readCustomArt(options.root, options.inputPath, options.provenance);
  } else {
    result = await generateBuiltInArt(provider, { ...options, prompt });
  }
  return Object.freeze({
    bytes: assertValidPng(result.bytes),
    prompt,
    provenance: Object.freeze(result.provenance),
  });
}
