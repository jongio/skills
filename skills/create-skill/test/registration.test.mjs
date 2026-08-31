import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRepository } from "../scripts/repository.mjs";
import { createSkillManifest } from "../scripts/render.mjs";
import {
  applyPlan,
  buildArtPlan,
  buildCreatePlan,
  buildRegistrationUpdates,
  checkSkill,
  hashPlan,
} from "../scripts/registration.mjs";
import { defaultArtPrompt } from "../scripts/art.mjs";
import { generatePlaceholder } from "../scripts/providers.mjs";
import { createRepositoryFixture } from "./helpers.mjs";

const manifest = createSkillManifest({
  name: "release-notes-helper",
  summary: "Create accurate release notes from repository changes",
  useFor: "release notes, changelog draft",
  doNotUseFor: "publishing releases without approval",
  author: "Example Author",
});

function placeholderArt() {
  return {
    ...generatePlaceholder(),
    prompt: defaultArtPrompt(manifest),
  };
}

test("create plan covers skill files and every discovered registration surface", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-plan-"));
  try {
    createRepositoryFixture(root);
    const profile = discoverRepository(root);
    const updates = buildRegistrationUpdates(profile, manifest, placeholderArt());
    assert.ok(updates.has(join(root, "README.md")));
    assert.ok(updates.has(join(root, "marketplace.json")));
    assert.ok(updates.has(join(root, "plugin.json")));
    assert.ok(updates.has(join(root, "site", "public", "images", `thumb-${manifest.name}.png`)));

    const plan = buildCreatePlan(profile, manifest, { art: placeholderArt() });
    assert.ok(plan.mutations.length >= 17);
    assert.equal(plan.hash, hashPlan(plan.mutations));
    assert.equal(hashPlan([...plan.mutations].reverse()), plan.hash);
    const preview = applyPlan(plan, { dryRun: true });
    assert.equal(preview.applied, false);
    assert.ok(preview.changes.some(({ path }) => path === `skills/${manifest.name}/SKILL.md`));
    assert.throws(() => applyPlan(plan), /single-use approval/);
    assert.equal(readFileSync(join(root, "README.md"), "utf8").includes(manifest.name), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("README registration escapes Markdown table separators", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-readme-"));
  try {
    createRepositoryFixture(root);
    const profile = discoverRepository(root);
    const pipeManifest = createSkillManifest({
      name: "table-safe-skill",
      summary: "Generate A | B release notes safely",
      useFor: "release notes that compare two sources",
      doNotUseFor: "publishing releases without approval",
      author: "Example Author",
    });
    const updates = buildRegistrationUpdates(profile, pipeManifest, placeholderArt());
    assert.match(
      updates.get(join(root, "README.md")),
      /Generate A \\\| B release notes safely/,
    );
    assert.match(
      updates.get(join(root, "site", "src", "content", "skills", "table-safe-skill.md")),
      /cmd: "npx skills add octocat\/skills --skill table-safe-skill -g --agent github-copilot"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Dependabot registration distinguishes skill-name prefixes", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-dependabot-"));
  try {
    createRepositoryFixture(root);
    const dependabot = join(root, ".github", "dependabot.yml");
    writeFileSync(
      dependabot,
      "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /skills/foobar\n    schedule:\n      interval: weekly\n",
    );
    const profile = discoverRepository(root);
    const prefixedManifest = createSkillManifest({
      name: "foo",
      summary: "Generate safe release notes from changes",
      useFor: "release notes from repository changes",
      doNotUseFor: "publishing releases without approval",
      author: "Example Author",
    });
    const updates = buildRegistrationUpdates(profile, prefixedManifest, placeholderArt());
    const result = updates.get(dependabot);
    assert.match(result, /^\s*directory: \/skills\/foo\s*$/m);
    assert.match(result, /^\s*directory: \/skills\/foobar\s*$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approved apply is complete, byte-identical, and checkable", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-apply-"));
  try {
    createRepositoryFixture(root);
    const profile = discoverRepository(root);
    const plan = buildCreatePlan(profile, manifest, { art: placeholderArt() });
    const result = applyPlan(plan, { approval: plan.hash });
    assert.equal(result.applied, true);
    assert.deepEqual(result.cleanupFailures, []);

    const installed = readFileSync(join(root, "skills", manifest.name, "thumbnail.png"));
    const catalog = readFileSync(
      join(root, "site", "public", "images", `thumb-${manifest.name}.png`),
    );
    assert.ok(installed.equals(catalog));
    assert.match(readFileSync(join(root, "README.md"), "utf8"), /release-notes-helper/);
    assert.match(readFileSync(join(root, "plugin.json"), "utf8"), /release-notes-helper/);
    assert.match(readFileSync(join(root, ".github", "workflows", "skill-eval.yml"), "utf8"), /release-notes-helper/);
    assert.match(readFileSync(join(root, "docs", "thumbnail-prompts.md"), "utf8"), /SHA-256:/);
    assert.doesNotMatch(
      readFileSync(join(root, "site", "src", "content", "skills", `${manifest.name}.md`), "utf8"),
      /OWNER\/REPOSITORY/,
    );
    assert.match(
      readFileSync(join(root, "skills", manifest.name, "README.md"), "utf8"),
      /npx skills add octocat\/skills/,
    );
    assert.deepEqual(checkSkill(profile, manifest.name), { ok: true, failures: [] });

    const artPlan = buildArtPlan(profile, manifest, placeholderArt());
    assert.equal(artPlan.mutations.length, 0);
    assert.equal(applyPlan(artPlan, { approval: artPlan.hash }).changes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approved apply rejects files changed after preview", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-preimage-"));
  try {
    createRepositoryFixture(root);
    const profile = discoverRepository(root);
    const plan = buildCreatePlan(profile, manifest, { art: placeholderArt() });
    writeFileSync(join(root, "README.md"), "# Concurrent edit\n");
    assert.throws(
      () => applyPlan(plan, { approval: plan.hash }),
      /source changed since preview/,
    );
    assert.equal(existsSync(join(root, "skills", manifest.name)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed registration updates managed state hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-state-"));
  try {
    createRepositoryFixture(root, { managed: true });
    const profile = discoverRepository(root);
    const plan = buildCreatePlan(profile, manifest, { art: placeholderArt() });
    applyPlan(plan, { approval: plan.hash });

    const readme = readFileSync(join(root, "README.md"), "utf8").replace(/\r\n?/g, "\n");
    const expected = createHash("sha256").update(readme).digest("hex");
    const state = JSON.parse(
      readFileSync(join(root, ".skills-repo", "state.json"), "utf8"),
    );
    assert.equal(state.files["README.md"].sha256, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed apply removes transaction-created directories so retry is possible", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-rollback-"));
  try {
    const target = join(root, "skills", "retryable", "SKILL.md");
    const mutations = [
      {
        path: target,
        bytes: Buffer.from("content"),
        expected: null,
        action: "create",
      },
      {
        path: target,
        bytes: Buffer.from("duplicate destination"),
        expected: null,
        action: "create",
      },
    ];
    const plan = { root, mutations, hash: hashPlan(mutations) };
    assert.throws(() => applyPlan(plan, { approval: plan.hash }), /rolled back/);
    assert.equal(existsSync(join(root, "skills", "retryable")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed apply preserves edits made after a file is published", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-published-edit-"));
  try {
    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    writeFileSync(first, "original first");
    writeFileSync(second, "original second");
    const mutations = [
      {
        path: first,
        bytes: Buffer.from("generated first"),
        expected: Buffer.from("original first"),
        action: "update",
      },
      {
        path: second,
        bytes: Buffer.from("generated second"),
        expected: Buffer.from("original second"),
        action: "update",
      },
    ];
    const plan = { root, mutations, hash: hashPlan(mutations) };
    assert.throws(
      () =>
        applyPlan(plan, {
          approval: plan.hash,
          afterWrite: (_item, applied) => {
            if (applied === 1) writeFileSync(first, "editor first");
          },
        }),
      /Rollback preserved external edits/,
    );
    assert.equal(readFileSync(first, "utf8"), "editor first");
    assert.equal(readFileSync(second, "utf8"), "original second");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approved apply serializes writers with an owner-checked repository lock", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-lock-"));
  try {
    const target = join(root, "target.txt");
    writeFileSync(target, "original");
    const mutations = [{
      path: target,
      bytes: Buffer.from("generated"),
      expected: Buffer.from("original"),
      action: "update",
    }];
    const plan = { root, mutations, hash: hashPlan(mutations) };
    assert.throws(
      () =>
        applyPlan(plan, {
          approval: plan.hash,
          afterWrite: () => applyPlan(plan, { approval: plan.hash }),
        }),
      /Another create-skill operation holds/,
    );
    assert.equal(readFileSync(target, "utf8"), "original");
    assert.equal(existsSync(`${root}.create-skill.lock`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}.create-skill.lock`, { force: true });
  }
});

test("registration rejects incomplete tooling, secret provenance, and missing skills", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-failures-"));
  try {
    createRepositoryFixture(root);
    const profile = discoverRepository(root);
    assert.equal(checkSkill(profile, "missing-skill").ok, false);
    assert.throws(
      () =>
        buildRegistrationUpdates(profile, manifest, {
          ...placeholderArt(),
          provenance: { provider: "custom", apiKey: "secret" },
        }),
      /may contain a secret/,
    );
    assert.throws(
      () =>
        buildRegistrationUpdates(profile, manifest, {
          ...placeholderArt(),
          provenance: { provider: "custom", endpoint: "https://example.com/path?token=x" },
        }),
      /exact origin/,
    );
    const noLock = { ...profile, paths: { ...profile.paths, vallyLock: null } };
    assert.throws(() => buildCreatePlan(noLock, manifest, { art: placeholderArt() }), /locked Vally/);
    assert.throws(() => buildArtPlan(profile, manifest, placeholderArt()), /does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
