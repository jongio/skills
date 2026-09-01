import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BUILT_IN_PROVIDERS,
  buildArtActionPreview,
  consumeArtApproval,
  createArtApproval,
  createArtResult,
  defaultArtPrompt,
  hashArtAction,
  readCustomArt,
} from "../scripts/art.mjs";
import { createSkillManifest } from "../scripts/render.mjs";
import { encodeDeterministicPlaceholderPng, validatePng } from "../scripts/png.mjs";

const manifest = createSkillManifest({
  name: "image-helper",
  summary: "Create safe image assets for repository documentation",
  useFor: "image helper, documentation image",
  doNotUseFor: "unapproved billed image generation",
});

test("art prompt and previews bind every action input", () => {
  assert.deepEqual(BUILT_IN_PROVIDERS, ["azure-openai", "openai", "placeholder"]);
  const prompt = defaultArtPrompt(manifest);
  assert.match(prompt, /1024x1024/);
  const preview = buildArtActionPreview({
    name: manifest.name,
    provider: "openai",
    prompt,
    targets: ["b.png", "a.png"],
    model: "gpt-image-2",
  });
  assert.deepEqual(preview.targets, ["a.png", "b.png"]);
  assert.equal(preview.attempts, 1);
  assert.equal(preview.fallback, "none");
  assert.notEqual(hashArtAction(preview), hashArtAction({ ...preview, prompt: `${prompt} changed` }));
  assert.throws(() => buildArtActionPreview({ provider: "unknown", targets: [] }), /Unknown/);
  assert.throws(
    () =>
      buildArtActionPreview({
        name: "x",
        provider: "custom",
        prompt: "x",
        targets: [],
        customDescription: "short",
      }),
    /exact provider/,
  );
  assert.throws(
    () =>
      buildArtActionPreview({
        name: "x",
        provider: "azure-openai",
        prompt: "x",
        targets: [],
      }),
    /exact endpoint/,
  );
  const custom = buildArtActionPreview({
    name: "x",
    provider: "custom",
    prompt: "x",
    targets: ["thumbnail.png"],
    customDescription: "Use the approved remote design service exactly once",
    customProvider: "design-service",
    delivery: "file attachment",
    input: "delivered.png",
    inputDigest: "a".repeat(64),
  });
  assert.equal(custom.customProvider, "design-service");
  assert.equal(custom.inputDigest, "a".repeat(64));
  const customWithDetails = buildArtActionPreview({
    ...custom,
    targets: ["thumbnail.png"],
    customDescription: custom.customAction,
    customProvider: custom.customProvider,
    customModel: "model-a",
    customEndpoint: "https://images.example.com",
  });
  assert.notEqual(hashArtAction(custom), hashArtAction(customWithDetails));
  assert.throws(
    () =>
      buildArtActionPreview({
        ...custom,
        targets: ["thumbnail.png"],
        customDescription: custom.customAction,
        customProvider: custom.customProvider,
        customEndpoint: "https://images.example.com/path?key=secret",
      }),
    /exact origin/,
  );
});

test("art approval tokens bind the preview and can be consumed once", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "create-skill-approval-"));
  try {
    const preview = buildArtActionPreview({
      name: manifest.name,
      provider: "placeholder",
      prompt: defaultArtPrompt(manifest),
      targets: ["thumbnail.png"],
    });
    const token = createArtApproval(preview, "a".repeat(32));
    assert.equal(consumeArtApproval(preview, token, { stateRoot }), token);
    assert.throws(
      () => consumeArtApproval(preview, token, { stateRoot }),
      /already been used/,
    );
    assert.throws(
      () =>
        consumeArtApproval(
          { ...preview, prompt: `${preview.prompt} changed` },
          createArtApproval(preview, "b".repeat(32)),
          { stateRoot },
        ),
      /latest preview/,
    );
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("custom art accepts only a validated regular repository file", async () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-custom-art-"));
  const external = mkdtempSync(join(tmpdir(), "create-skill-external-art-"));
  try {
    writeFileSync(join(root, "delivered.png"), encodeDeterministicPlaceholderPng());
    writeFileSync(join(external, "escaped.png"), encodeDeterministicPlaceholderPng());
    symlinkSync(external, join(root, "linked"), "junction");
    const result = readCustomArt(root, "delivered.png", {
      provider: "design-service",
      model: "custom",
      delivery: "approved attachment",
    });
    validatePng(result.bytes);
    const wrapped = await createArtResult("custom", {
      root,
      inputPath: "delivered.png",
      prompt: "Exact prompt",
      provenance: result.provenance,
    });
    assert.equal(wrapped.prompt, "Exact prompt");
    assert.throws(() => readCustomArt(root, join(root, "delivered.png"), {}), /relative/);
    assert.throws(() => readCustomArt(root, "../outside.png", {}), /inside/);
    assert.throws(() => readCustomArt(root, "Z:outside.png", {}), /relative/);
    assert.throws(() => readCustomArt(root, "missing.png", {}), /inside/);
    assert.throws(() => readCustomArt(root, ".", {}), /inside/);
    assert.throws(
      () => readCustomArt(root, "linked/escaped.png", {}),
      /symbolic link ancestor/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("placeholder art uses the shared validator", async () => {
  const result = await createArtResult("placeholder", { prompt: "Placeholder prompt" });
  validatePng(result.bytes);
  assert.equal(result.provenance.provider, "placeholder");
});
