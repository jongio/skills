import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createConfig,
  validateConfig,
  validateRelativeTemplatePath,
  validateTargetPath,
} from "../scripts/config.mjs";
import { createGitHubPlan } from "../scripts/github-plan.mjs";
import { readSkillFrontmatter } from "../scripts/render.mjs";
import { execute } from "../scripts/cli.mjs";
import {
  assertOutsideRoot,
  assertRepositoryRoot,
  desiredFromCurrentState,
  mergeMaps,
} from "../scripts/repository-files.mjs";

test("configuration derives exact trusted GitHub URLs", () => {
  const config = createConfig({
    ownerLogin: "octocat",
    ownerName: "Octo Cat",
    repositoryName: "skills",
  });
  assert.equal(config.owner.url, "https://github.com/octocat");
  assert.equal(config.repository.url, "https://github.com/octocat/skills");
  assert.equal(config.catalog.template, "skills-catalog");
});

test("configuration rejects unknown fields and forged URLs", () => {
  const config = createConfig({
    ownerLogin: "octocat",
    repositoryName: "skills",
  });
  assert.throws(
    () => validateConfig({ ...config, unexpected: true }),
    /unsupported fields/,
  );
  for (const section of ["owner", "repository", "github", "features", "catalog"]) {
    assert.throws(
      () =>
        validateConfig({
          ...config,
          [section]: { ...config[section], unexpected: true },
        }),
      /unsupported fields/,
    );
  }
  assert.throws(
    () => validateConfig({
      ...config,
      repository: { ...config.repository, url: "https://example.com/x" },
    }),
    /repository.url must be/,
  );
});

test("identity and path validation rejects unsafe input", () => {
  assert.throws(
    () => createConfig({ ownerLogin: "-flag", repositoryName: "skills" }),
    /invalid format/,
  );
  assert.throws(
    () => createConfig({ ownerLogin: "octocat", repositoryName: "CON" }),
    /reserved Windows name/,
  );
  assert.throws(
    () => createConfig({
      ownerLogin: "octocat",
      repositoryName: "skills",
      description: "bad\u2014dash",
    }),
    /Unicode dash punctuation/,
  );
  assert.throws(
    () => validateRelativeTemplatePath("../outside"),
    /stay inside/,
  );
  for (const value of ["/absolute", "nested\\path", "-option", "CON/file", "file."]) {
    assert.throws(
      () => validateRelativeTemplatePath(value),
      /normalized relative path|stay inside/,
    );
  }
  assert.throws(() => validateTargetPath(pathRoot()), /filesystem root/);
});

function pathRoot() {
  return process.platform === "win32" ? "C:\\" : "/";
}

test("frontmatter reader validates canonical skill identity", () => {
  const source = `---
name: sample-skill
description: >-
  First line
  and second line.
---
`;
  assert.deepEqual(readSkillFrontmatter(source, "sample-skill"), {
    name: "sample-skill",
    description: "First line and second line.",
  });
  assert.equal(
    readSkillFrontmatter(
      '---\nname: sample-skill\ndescription: "A \\"quoted\\" summary."\n---\n',
      "sample-skill",
    ).description,
    'A "quoted" summary.',
  );
  assert.equal(
    readSkillFrontmatter(
      '---\nname: sample-skill\ndescription: "First line\\nsecond line."\n---\n',
      "sample-skill",
    ).description,
    "First line second line.",
  );
  assert.equal(
    readSkillFrontmatter(
      '---\nname: sample-skill\ndescription: "A summary." # rationale\n---\n',
      "sample-skill",
    ).description,
    "A summary.",
  );
  assert.equal(
    readSkillFrontmatter(
      "---\nname: sample-skill\ndescription: 'An ''escaped'' summary.'\n---\n",
      "sample-skill",
    ).description,
    "An 'escaped' summary.",
  );
  assert.throws(
    () => readSkillFrontmatter(
      '---\nname: sample-skill\ndescription: "mismatched\n---\n',
      "sample-skill",
    ),
    /mismatched YAML scalar quotes/,
  );
  assert.throws(
    () => readSkillFrontmatter(source, "other-skill"),
    /must match its directory/,
  );
  assert.throws(
    () => readSkillFrontmatter(
      source.replaceAll("sample-skill", "Bad Skill"),
      "Bad Skill",
    ),
    /lowercase dash-separated name/,
  );
  assert.throws(
    () => readSkillFrontmatter(
      source.replaceAll("sample-skill", "1bad-skill"),
      "1bad-skill",
    ),
    /lowercase dash-separated name/,
  );
  const longName = "a".repeat(65);
  assert.throws(
    () => readSkillFrontmatter(
      source.replaceAll("sample-skill", longName),
      longName,
    ),
    /lowercase dash-separated name/,
  );
});

test("GitHub plan contains only inert argument arrays", () => {
  const config = createConfig({
    ownerLogin: "octocat",
    repositoryName: "skills",
    visibility: "private",
  });

  const plan = createGitHubPlan(config, "./skills-output");
  assert.equal(plan.approvalRequired, true);
  assert.equal(plan.approved, false);
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    plan.commands.find((entry) => entry.program === "gh").args,
    [
      "repo",
      "create",
      "octocat/skills",
      "--private",
      "--source",
      ".",
      "--remote",
      "origin",
    ],
  );
  assert.ok(plan.commands.every((entry) => Array.isArray(entry.args)));
});

test("commands reject options that do not apply", async () => {
  await assert.rejects(
    execute(["sync", "./repo", "--visibility", "public"]),
    /sync does not support: visibility/,
  );
});

test("repository filesystem boundaries reject missing, non-directory, and nested targets", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "repository-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "repository");
  const file = path.join(root, "file.txt");
  await mkdir(directory);
  await writeFile(file, "file\n");

  await assert.doesNotReject(assertRepositoryRoot(directory));
  await assert.rejects(
    assertRepositoryRoot(path.join(root, "missing")),
    /Repository does not exist/,
  );
  await assert.rejects(
    assertRepositoryRoot(file),
    /must be a regular directory/,
  );
  assert.throws(() => assertOutsideRoot(directory, directory), /must be outside/);
  assert.throws(
    () => assertOutsideRoot(path.join(directory, "child"), directory),
    /must be outside/,
  );
  assert.doesNotThrow(
    () => assertOutsideRoot(path.join(root, "sibling"), directory),
  );
});

test("managed map helpers preserve precedence and missing-file placeholders", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "repository-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "present.txt"), "present\n");

  const merged = mergeMaps(
    new Map([["a", "first"], ["b", "kept"]]),
    new Map([["a", "second"]]),
  );
  assert.deepEqual([...merged], [["a", "second"], ["b", "kept"]]);

  const desired = await desiredFromCurrentState(root, {
    files: {
      "present.txt": {},
      "missing.txt": {},
    },
  });
  assert.equal(desired.get("present.txt").toString("utf8"), "present\n");
  assert.equal(desired.get("missing.txt").length, 0);
});
