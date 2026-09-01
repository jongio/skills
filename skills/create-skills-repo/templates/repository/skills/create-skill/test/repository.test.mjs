import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONFIG_FILE,
  discoverConventions,
  discoverRepository,
  normalizeRepositoryPath,
  validateManagedConfig,
} from "../scripts/repository.mjs";
import { createRepositoryFixture, write } from "./helpers.mjs";

test("managed repository discovery uses the nearest valid config", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-managed-"));
  try {
    createRepositoryFixture(root, { managed: true });
    const nested = join(root, "skills", "existing");
    const profile = discoverRepository(nested);
    assert.equal(CONFIG_FILE, "skills-repo.config.json");
    assert.equal(profile.mode, "managed");
    assert.equal(profile.root, root);
    assert.equal(profile.paths.skills, join(root, "skills"));
    assert.equal(profile.catalogEnabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed config mirrors the canonical strict schema and paths", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-config-"));
  try {
    createRepositoryFixture(root, { managed: true });
    const config = JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8"));
    const profile = validateManagedConfig(config, root);
    assert.equal(profile.paths.skills, join(root, "skills"));
    assert.equal(profile.identity.ownerName, "Octo Cat");
    assert.equal(profile.identity.repository, "octocat/skills");
    assert.equal(normalizeRepositoryPath(root, "safe/path", "test"), join(root, "safe", "path"));
    assert.throws(() => validateManagedConfig({ ...config, paths: {} }, root), /unsupported fields/);
    assert.throws(() => validateManagedConfig({ ...config, templateVersion: 2 }, root), /must be 1/);
    assert.throws(
      () =>
        validateManagedConfig(
          { ...config, owner: { ...config.owner, url: "https://example.com/octocat" } },
          root,
        ),
      /owner.url/,
    );
    assert.throws(
      () =>
        validateManagedConfig(
          { ...config, catalog: { enabled: true, template: "astro" } },
          root,
        ),
      /skills-catalog/,
    );
    const withoutCatalog = validateManagedConfig(
      { ...config, catalog: { enabled: false, template: "skills-catalog" } },
      root,
    );
    assert.equal(withoutCatalog.catalogEnabled, false);
    assert.equal(withoutCatalog.paths.catalogEntries, null);
    assert.equal(withoutCatalog.paths.catalogImages, null);
    assert.equal(withoutCatalog.paths.thumbnailPrompts, null);
    assert.throws(() => normalizeRepositoryPath(root, "", "test"), /non-empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing repository conventions are discovered without guessing", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-existing-"));
  try {
    createRepositoryFixture(root);
    const profile = discoverConventions(root);
    assert.equal(profile.mode, "discovered");
    assert.equal(profile.paths.marketplace, join(root, "marketplace.json"));
    assert.equal(profile.catalogEnabled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery fails closed for malformed, missing, or ambiguous repositories", () => {
  const malformed = mkdtempSync(join(tmpdir(), "create-skill-malformed-"));
  const empty = mkdtempSync(join(tmpdir(), "create-skill-empty-"));
  const ambiguous = mkdtempSync(join(tmpdir(), "create-skill-ambiguous-"));
  try {
    writeFileSync(join(malformed, CONFIG_FILE), "{");
    assert.throws(() => discoverRepository(malformed), /Cannot parse/);
    assert.throws(() => discoverRepository(empty), /No .*existing skills repository/);

    createRepositoryFixture(ambiguous);
    mkdirSync(join(ambiguous, "nested", "skills", "other"), { recursive: true });
    write(join(ambiguous, "nested", "skills", "other", "SKILL.md"), "---\nname: other\n---\n");
    assert.throws(() => discoverConventions(ambiguous), /exactly one/);

    rmSync(join(ambiguous, "nested"), { recursive: true, force: true });
    rmSync(join(ambiguous, "site", "public"), { recursive: true, force: true });
    assert.throws(() => discoverConventions(ambiguous), /Ambiguous registration/);

    createRepositoryFixture(empty);
    writeFileSync(
      join(empty, "plugin.json"),
      JSON.stringify({
        repository: "https://github.com/octocat\ninjected/repository",
      }),
    );
    assert.throws(() => discoverConventions(empty), /valid GitHub owner and repository/);
  } finally {
    rmSync(malformed, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
    rmSync(ambiguous, { recursive: true, force: true });
  }
});

test("repository discovery never crosses the nearest git boundary", () => {
  const outer = mkdtempSync(join(tmpdir(), "create-skill-boundary-"));
  const inner = join(outer, "inner");
  try {
    createRepositoryFixture(outer, { managed: true });
    createRepositoryFixture(inner);
    const profile = discoverRepository(join(inner, "skills", "existing"));
    assert.equal(profile.root, inner);
    assert.equal(profile.mode, "discovered");
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});
