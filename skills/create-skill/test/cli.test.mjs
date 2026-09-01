import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  manifestFromExistingSkill,
  loadFixture,
  parseArgs,
  parseFixture,
  run,
} from "../scripts/create-skill.mjs";
import { discoverRepository } from "../scripts/repository.mjs";
import { createRepositoryFixture } from "./helpers.mjs";

function capture() {
  let value = "";
  return {
    output: { write(chunk) { value += chunk; } },
    text() { return value; },
    json() { return JSON.parse(value); },
  };
}

const createArgs = [
  "release-notes-helper",
  "--summary",
  "Create accurate release notes from repository changes",
  "--use-for",
  "release notes, changelog draft",
  "--do-not-use-for",
  "publishing releases without approval",
  "--author",
  "Example Author",
];

const fixturePayload = {
  schemaVersion: 1,
  name: "example-skill",
  title: "Example Skill",
  description: "A functional example that verifies portable skill distribution.",
  routing: {
    type: "utility",
    useFor: ["run the example skill", "verify the skills repository"],
    doNotUseFor: ["authoring a new skill"],
  },
  behavior: {
    purpose: "Return a repository health confirmation based only on files that exist.",
    commands: ["check"],
  },
  thumbnail: {
    provider: "builtin",
    prompt: "A precise green check inside a repository outline on a warm neutral background",
  },
};

test("argument parser handles commands, values, dry-run, and errors", () => {
  const parsed = parseArgs(["art", "x", "--provider", "placeholder", "--dry-run"]);
  assert.deepEqual(parsed.positionals, ["art", "x"]);
  assert.equal(parsed.provider, "placeholder");
  assert.equal(parsed.dryRun, true);
  assert.throws(() => parseArgs(["x", "--unknown"]), /Unknown option/);
  assert.throws(() => parseArgs(["x", "--summary"]), /requires a value/);
});

test("CLI previews, applies, checks, and previews art without network", async () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-cli-"));
  try {
    createRepositoryFixture(root, { managed: true });
    const previewOutput = capture();
    assert.equal(
      await run([...createArgs, "--dry-run"], { cwd: root, output: previewOutput.output }),
      0,
    );
    const preview = previewOutput.json();
    assert.equal(preview.applied, false);
    assert.ok(preview.hash);

    const applyOutput = capture();
    assert.equal(
      await run([...createArgs, "--approve", preview.hash], { cwd: root, output: applyOutput.output }),
      0,
    );
    assert.equal(applyOutput.json().applied, true);

    const profile = discoverRepository(root);
    const manifest = manifestFromExistingSkill(profile, "release-notes-helper");
    assert.equal(manifest.name, "release-notes-helper");
    assert.match(manifest.useFor, /release notes/);

    const catalogEntry = join(
      root,
      "site",
      "src",
      "content",
      "skills",
      "release-notes-helper.md",
    );
    rmSync(catalogEntry);
    const registerPreviewOutput = capture();
    assert.equal(
      await run(
        ["register", "release-notes-helper", "--dry-run"],
        { cwd: root, output: registerPreviewOutput.output },
      ),
      0,
    );
    const registerPreview = registerPreviewOutput.json();
    assert.equal(
      registerPreview.changes.some((change) =>
        change.path.endsWith("release-notes-helper.md")
      ),
      true,
    );
    const registerApplyOutput = capture();
    assert.equal(
      await run(
        ["register", "release-notes-helper", "--approve", registerPreview.hash],
        { cwd: root, output: registerApplyOutput.output },
      ),
      0,
    );
    assert.equal(existsSync(catalogEntry), true);

    const checkOutput = capture();
    assert.equal(
      await run(["check", "release-notes-helper"], { cwd: root, output: checkOutput.output }),
      0,
    );
    assert.equal(checkOutput.json().ok, true);

    const artOutput = capture();
    assert.equal(
      await run(
        ["art", "release-notes-helper", "--provider", "openai", "--dry-run"],
        { cwd: root, output: artOutput.output },
      ),
      0,
    );
    const artPreview = artOutput.json();
    assert.equal(artPreview.provider, "openai");
    assert.equal(artPreview.attempts, 1);
    assert.ok(artPreview.approvalHash);

    const customOutput = capture();
    assert.equal(
      await run(
        [
          "art",
          "release-notes-helper",
          "--provider",
          "custom",
          "--custom-description",
          "Use the approved design service and deliver one PNG attachment",
          "--custom-provider",
          "approved-design-service",
          "--delivery",
          "repository attachment",
          "--input",
          "skills/release-notes-helper/thumbnail.png",
          "--dry-run",
        ],
        { cwd: root, output: customOutput.output },
      ),
      0,
    );
    assert.match(customOutput.json().customAction, /design service/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI help and failing check return stable exit codes", async () => {
  const help = capture();
  assert.equal(await run(["--help"], { output: help.output }), 0);
  assert.match(help.text(), /Usage:/);

  const root = mkdtempSync(join(tmpdir(), "create-skill-cli-check-"));
  try {
    createRepositoryFixture(root);
    const output = capture();
    assert.equal(await run(["check", "missing-skill"], { cwd: root, output: output.output }), 2);
    assert.equal(output.json().ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing manifest parser accepts portable scalar descriptions", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-scalar-"));
  try {
    createRepositoryFixture(root);
    const manifest = manifestFromExistingSkill(discoverRepository(root), "existing");
    assert.equal(manifest.name, "existing");
    assert.equal(manifest.summary, "Existing skill description.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing manifest parser collapses escaped newlines", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-multiline-scalar-"));
  try {
    createRepositoryFixture(root);
    writeFileSync(
      join(root, "skills", "existing", "SKILL.md"),
      "---\nname: existing\ndescription: \"Existing skill\\nwith safe spacing.\"\n---\n",
    );
    const manifest = manifestFromExistingSkill(discoverRepository(root), "existing");
    assert.equal(manifest.summary, "Existing skill with safe spacing.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("folded descriptions stop before later frontmatter fields", () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-folded-description-"));
  try {
    createRepositoryFixture(root);
    writeFileSync(
      join(root, "skills", "existing", "SKILL.md"),
      "---\nname: existing\ndescription: >-\n  Existing skill description.\nlicense: MIT\n---\n",
    );
    const manifest = manifestFromExistingSkill(discoverRepository(root), "existing");
    assert.equal(manifest.summary, "Existing skill description.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare Node check path does not require image SDK installation", () => {
  const work = mkdtempSync(join(tmpdir(), "create-skill-portable-"));
  try {
    const scriptSource = new URL("../scripts", import.meta.url);
    const standalone = join(work, "standalone");
    const repository = join(work, "repository");
    cpSync(scriptSource, standalone, { recursive: true });
    createRepositoryFixture(repository);
    const result = spawnSync(
      process.execPath,
      [join(standalone, "create-skill.mjs"), "check", "missing-skill"],
      { cwd: repository, encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("fixture parser validates the stable version 1 contract", () => {
  const parsed = parseFixture(fixturePayload);
  assert.equal(parsed.name, "example-skill");
  assert.equal(parsed.type, "utility");
  assert.equal(parsed.useFor, "run the example skill, verify the skills repository");
  assert.deepEqual(parsed.commands, ["check"]);
  assert.throws(() => parseFixture({ ...fixturePayload, schemaVersion: 2 }), /schemaVersion 1/);
  assert.throws(() => parseFixture({ ...fixturePayload, extra: true }), /unsupported fields/);
  assert.throws(
    () => parseFixture({ ...fixturePayload, thumbnail: { provider: "openai", prompt: "valid prompt" } }),
    /must be builtin/,
  );
  assert.throws(
    () => parseFixture({ ...fixturePayload, behavior: { ...fixturePayload.behavior, commands: ["Bad"] } }),
    /Skill name/,
  );
});

test("fixture CLI previews and applies through the normal planner", async () => {
  const root = mkdtempSync(join(tmpdir(), "create-skill-fixture-mode-"));
  const repository = join(root, "repository");
  const fixturePath = join(root, "example-skill.fixture.json");
  try {
    createRepositoryFixture(repository, { managed: true });
    writeFileSync(fixturePath, `${JSON.stringify(fixturePayload, null, 2)}\n`);
    assert.equal(loadFixture(fixturePath).name, "example-skill");

    const previewOutput = capture();
    assert.equal(
      await run(
        [
          "fixture",
          "--input",
          fixturePath,
          "--repo-root",
          repository,
          "--dry-run",
        ],
        { cwd: root, output: previewOutput.output },
      ),
      0,
    );
    const preview = previewOutput.json();
    assert.match(preview.hash, /^[a-f0-9]{64}$/);
    assert.equal(existsSync(join(repository, "skills", "example-skill")), false);

    const applyOutput = capture();
    assert.equal(
      await run(
        [
          "fixture",
          "--input",
          fixturePath,
          "--repo-root",
          repository,
          "--approve",
          preview.hash,
        ],
        { cwd: root, output: applyOutput.output },
      ),
      0,
    );
    assert.equal(applyOutput.json().applied, true);
    const skill = readFileSync(
      join(repository, "skills", "example-skill", "SKILL.md"),
      "utf8",
    );
    assert.match(skill, /\*\*UTILITY SKILL\*\*/);
    assert.match(skill, /Return a repository health confirmation/);
    assert.match(skill, /`check`/);
    assert.throws(
      () => loadFixture(join(root, "missing.json")),
      /Cannot read fixture input/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
