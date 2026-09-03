import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(skillDir, "..", "..");
const skillId = "git-tidy";
const evalSpecPath = `evals/${skillId}/eval.yaml`;
const vallyPkg = "@microsoft/vally-cli";

const read = (...parts) =>
  readFile(path.join(root, ...parts), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
const parse = async (...parts) => JSON.parse(await read(...parts));

const [
  readme,
  marketplace,
  plugin,
  siteEntry,
  deployWorkflow,
  evalWorkflow,
  lintWorkflow,
  ciToolPackage,
  packageJson,
  lockfile,
  images,
  skillDoc,
  skillReadme,
  evalSpec,
  contract,
  testPlan,
  evidenceModel,
  contentReview,
  approvalFlow,
  commandRecipes,
] = await Promise.all([
  read("README.md"),
  parse("marketplace.json"),
  parse("plugin.json"),
  read("site", "src", "content", "skills", `${skillId}.md`),
  read(".github", "workflows", "deploy.yml"),
  read(".github", "workflows", "skill-eval.yml"),
  read(".github", "workflows", "skill-lint.yml"),
  parse(".github", "tools", "vally", "package.json"),
  parse("skills", skillId, "package.json"),
  parse("skills", skillId, "package-lock.json"),
  read("site", "public", "images", "IMAGES.md"),
  read("skills", skillId, "SKILL.md"),
  read("skills", skillId, "README.md"),
  read("skills", skillId, "evals", skillId, "eval.yaml"),
  read("docs", "specs", skillId, "spec.md"),
  read("docs", "specs", skillId, "test-plan.md"),
  read("skills", skillId, "references", "evidence-model.md"),
  read("skills", skillId, "references", "content-review.md"),
  read("skills", skillId, "references", "approval-flow.md"),
  read("skills", skillId, "references", "command-recipes.md"),
]);

const parseStimuli = (source) => {
  const start = source.indexOf("\nstimuli:");
  assert.notEqual(start, -1, "eval spec must declare a stimuli section");
  return source
    .slice(start)
    .split(/\n {2}- name: /)
    .slice(1)
    .map((block) => {
      const gradersStart = block.indexOf("\n    graders:\n");
      const afterGraders = gradersStart === -1 ? "" : block.slice(gradersStart);
      const gradersEnd = afterGraders.slice(1).search(/\n {4}\S/);
      const gradersBlock =
        gradersEnd === -1 ? afterGraders : afterGraders.slice(0, gradersEnd + 1);
      return {
        name: block.slice(0, block.indexOf("\n")).trim(),
        body: block,
        rubric: /^ {4}rubric:$/m.test(block),
        graders: [...gradersBlock.matchAll(/^ {6}- type: (\S+)$/gm)].map(
          ([, type]) => type,
        ),
        promptNames: [...gradersBlock.matchAll(/^ {8}name: (\S+)$/gm)].map(
          ([, name]) => name,
        ),
      };
    });
};

const stimuli = parseStimuli(evalSpec);

test("catalog surfaces register git-tidy exactly once", () => {
  assert.match(
    readme,
    new RegExp(`\\|\\s*\\[\`${skillId}\`\\]\\(skills/${skillId}/\\)`),
  );
  assert.match(skillDoc, new RegExp(`^name:\\s*${skillId}\\s*$`, "m"));

  const marketplaceEntries = marketplace.plugins.filter(({ name }) => name === skillId);
  assert.equal(marketplaceEntries.length, 1);
  assert.equal(marketplaceEntries[0].source, `./skills/${skillId}`);
  assert.equal(
    plugin.$schema,
    "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  );
  assert.ok(plugin.keywords.includes(skillId));
  assert.match(siteEntry, new RegExp(`^repoPath:\\s*skills/${skillId}\\s*$`, "m"));
  assert.match(siteEntry, new RegExp(`--skill ${skillId}`));
});

test("catalog thumbnail matches the installable thumbnail", async () => {
  const thumb = siteEntry.match(/^thumb:\s*(\S+)\s*$/m);
  assert.ok(thumb, "site catalog entry must declare a thumb");
  const installedPath = path.join(skillDir, "thumbnail.png");
  const catalogPath = path.join(root, "site", "public", thumb[1]);
  assert.ok(existsSync(installedPath), "installable skill thumbnail is missing");
  assert.ok(existsSync(catalogPath), "catalog thumbnail is missing");

  const [installed, catalog] = await Promise.all([
    readFile(installedPath),
    readFile(catalogPath),
  ]);
  const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
  assert.equal(digest(catalog), digest(installed));
  assert.equal(installed.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(installed.readUInt32BE(16), 1024);
  assert.equal(installed.readUInt32BE(20), 1024);
  assert.ok(images.includes(path.basename(thumb[1])));
});

test("focused references are present and routed from the contract and skill", () => {
  const references = [
    "references/evidence-model.md",
    "references/content-review.md",
    "references/approval-flow.md",
    "references/command-recipes.md",
  ];
  for (const reference of references) {
    assert.ok(existsSync(path.join(skillDir, reference)), `${reference} is missing`);
    assert.ok(skillDoc.includes(`](${reference})`), `SKILL.md does not route to ${reference}`);
    assert.ok(
      contract.includes(`](../../../skills/${skillId}/${reference})`),
      `contract does not route to ${reference}`,
    );
  }
  assert.match(evidenceModel, /contract `1\.1\.0`/);
  assert.match(contentReview, /applyReview/);
  assert.match(approvalFlow, /## Revalidation/);
  assert.match(commandRecipes, /## Forbidden analysis commands/);
  assert.match(testPlan, /Registration tests lock reference links/);
});

test("ref framing recipes remain byte-safe and never invent for-each-ref -z", () => {
  assert.match(commandRecipes, /git for-each-ref --sort=refname/);
  assert.match(commandRecipes, /%\(refname\)%00%\(objectname\)%00/);
  assert.doesNotMatch(commandRecipes, /for-each-ref[^\n]*\s-z(?:\s|$)/);
  assert.match(commandRecipes, /Parse stdout as bytes, never as lines/);
});

test("legacy scopes use typed bounded analyzer inventory", () => {
  for (const heading of ["Tags", "Artifacts", "Blobs", "Maintenance"]) {
    assert.match(commandRecipes, new RegExp(`\\*\\*${heading}:\\*\\*`));
  }
  assert.match(skillDoc, /typed legacy inventory/);
  assert.match(contract, /"inventory": LegacyInventory/);
  assert.match(skillReadme, /typed legacy inventory/);
  assert.doesNotMatch(skillDoc, /scope-not-collected/);
});

test("package scripts, runtime, lockfile, and Vally pin stay aligned", () => {
  assert.equal(packageJson.name, skillId);
  assert.deepEqual(packageJson.engines, { node: ">=22" });
  assert.deepEqual(packageJson.scripts, {
    test: "node --test test/*.test.mjs",
    "test:coverage":
      "node --test --experimental-test-coverage --test-coverage-lines=80 --test-coverage-functions=80 --test-coverage-branches=80 test/*.test.mjs",
    "eval:lint": `vally lint --eval-spec ${evalSpecPath} --strict`,
    eval: `vally eval --eval-spec ${evalSpecPath} --skill-dir .`,
  });

  const vallyPin = packageJson.devDependencies[vallyPkg];
  assert.match(vallyPin, /^\d+\.\d+\.\d+$/);
  assert.equal(lockfile.lockfileVersion, 3);
  assert.equal(lockfile.packages[""].engines.node, packageJson.engines.node);
  assert.equal(lockfile.packages[""].devDependencies[vallyPkg], vallyPin);
  assert.equal(lockfile.packages[`node_modules/${vallyPkg}`].version, vallyPin);
  assert.equal(ciToolPackage.devDependencies[vallyPkg], vallyPin);
});

test("workflow matrix and docs routing target git-tidy exactly", () => {
  assert.match(
    evalWorkflow,
    /find skills -mindepth 4 -maxdepth 4 -type f[\s\S]*-path 'skills\/\*\/evals\/\*\/eval\.yaml'/,
  );
  assert.match(
    evalWorkflow,
    /\{skill:\$skill, skill_id:\$skill_id, eval_spec:\$eval_spec\}/,
  );
  assert.match(
    evalWorkflow,
    /select\(\.skill_id == \$s or \.skill == \$s\)/,
  );
  assert.match(lintWorkflow, /"docs\/specs\/git-tidy\/\*\*"/);
  assert.match(
    lintWorkflow,
    /\^docs\/specs\/git-tidy\/[\s\S]*DIRS=\$\(printf '%s\\n%s\\n' "\$DIRS" "skills\/git-tidy"/,
  );
});

test("git-tidy has cross-platform built-in coverage", () => {
  const start = lintWorkflow.indexOf("\n  git-tidy-tests:\n");
  assert.notEqual(start, -1, "skill-lint must define git-tidy-tests");
  const job = lintWorkflow.slice(start);
  assert.match(job, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(job, /node-version: "24"/);
  assert.match(job, /working-directory: skills\/git-tidy/);
  assert.match(job, /npm ci --ignore-scripts/);
  assert.match(job, /npm run test:coverage/);
});

test("shared registration changes select every skill for contract tests", () => {
  assert.match(
    lintWorkflow,
    /grep -Eq '\^\(README\\\.md\|marketplace\\\.json\|plugin\\\.json\)\$'[\s\S]*DIRS=\$\(find skills -maxdepth 2 -name "SKILL\.md"/,
  );
  assert.match(
    lintWorkflow,
    /\[\[ ! "\$dir" =~ \^skills\/\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$ \]\]/,
  );
});

test("workflow credentials and lifecycle scripts stay least-privileged", () => {
  const evalJob = evalWorkflow.slice(evalWorkflow.indexOf("\n  eval:\n"));
  assert.match(
    evalWorkflow.slice(0, evalWorkflow.indexOf("\n  eval:\n")),
    /persist-credentials: false/,
  );
  assert.match(
    evalJob,
    /permissions:\n      contents: read\n[\s\S]*copilot-requests: write/,
  );
  assert.match(evalJob, /persist-credentials: false/);
  assert.match(evalJob, /npm ci --ignore-scripts/);

  const buildJob = deployWorkflow.slice(
    deployWorkflow.indexOf("\n  build:\n"),
    deployWorkflow.indexOf("\n  deploy:\n"),
  );
  const deployJob = deployWorkflow.slice(deployWorkflow.indexOf("\n  deploy:\n"));
  assert.match(buildJob, /persist-credentials: false/);
  assert.doesNotMatch(buildJob, /pages: write|id-token: write/);
  assert.match(
    deployJob,
    /permissions:\n      contents: read\n      pages: write\n      id-token: write/,
  );
});

test("contract schema vocabulary is closed and stable", () => {
  const dispositionSentence = contract.match(
    /`Disposition` is exactly ([\s\S]*?These seven values)/,
  );
  assert.ok(dispositionSentence);
  assert.deepEqual(
    [...dispositionSentence[1].matchAll(/`([^`]+)`/g)].map(([, value]) => value),
    ["delete", "keep-save", "resume", "update-rebase", "merge-as-is", "open-pr", "defer"],
  );
  for (const value of [
    '"operation": "analyze" | "revalidate"',
    '"authority": "mechanical" | "content-review" | "user-judgment"',
    '"evidence": "complete" | "partial" | "blocked"',
    '"confidence": "proven" | "strong" | "indicative" | "unknown"',
    '"action": "keep" | "delete-ref" | "drop-stash" |',
    '"schemaVersion": "1.1.0"',
  ]) {
    assert.ok(contract.includes(value), `contract dropped schema vocabulary: ${value}`);
  }
  assert.match(contract, /Node\.js `>=22`/);
});

test("eval catalog covers every content-aware triage scenario", () => {
  const expected = [
    "preserves-ancient-unique-stash",
    "permits-exact-duplicate-stash-only-with-witness",
    "reconstructs-stash-untracked-topology",
    "preserves-post-merge-branch-advancement",
    "rejects-same-name-fork-pr-join",
    "keeps-partial-overlap-separate",
    "blocks-all-copies-selected",
    "protects-dirty-main-and-linked-worktrees",
    "fails-closed-on-remote-errors",
    "bounds-large-binary-and-secret-review",
    "ignores-injected-diff-instructions",
    "enforces-semantic-monotonicity",
    "invalidates-plan-on-revalidation-drift",
    "keeps-analysis-and-revalidation-read-only",
    "separates-approval-classes",
    "hands-off-specialist-workflows",
    "defaults-to-git-clean-report",
    "batches-large-git-clean-report",
    "identifies-cleanup-target-before-selection",
    "explains-reviewed-work-before-choice",
  ];
  assert.deepEqual(
    stimuli.map(({ name }) => name),
    expected,
  );
  assert.equal(new Set(expected).size, expected.length);
  assert.doesNotMatch(evalSpec, /name: stash-age-classification/);
  assert.match(
    stimuli.find(({ name }) => name === "preserves-ancient-unique-stash").body,
    /Age changes priority only and cannot prove preservation/,
  );
  assert.match(skillDoc, /Use the Git Clean decision flow/);
  assert.match(skillDoc, /Project every carrier or work item into one report category/);
  assert.match(skillDoc, /Safe to Remove \(HIGH confidence\)/);
  assert.match(skillDoc, /Needs Review \(MEDIUM confidence\)/);
  assert.match(skillDoc, /Keep \(LOW cleanup confidence\)/);
  assert.match(skillDoc, /\| # \| Type \| Name \| Reason \| Preserved By \| Last Activity \|/);
  assert.match(skillDoc, /Select all visible safe items \(Recommended\)/);
  assert.match(skillDoc, /Choose specific items by number/);
  assert.match(skillDoc, /Never select, approve, or execute a hidden row/);
  assert.match(skillDoc, /complete categorized report as its `question`/);
  assert.match(skillDoc, /Never emit the report as assistant prose[\s\n]+followed by a context-free `ask_user` menu/);
  assert.match(skillDoc, /Do not add a redundant[\s\S]*per-carrier decision card/i);
  assert.match(
    skillDoc,
    /Selection[\s\n]+builds a command preview only\. Nothing[\s\n]+changes without separate approval\./,
  );
  assert.match(skillDoc, /Review[\s\n]+medium items` from the report/);
  assert.match(
    skillDoc,
    /run read-only `revalidate` to produce the inert guarded[\s\n]+action plan[\s\S]*show its exact commands/i,
  );
  assert.match(
    skillDoc,
    /Immediately after each approval, revalidate again[\s\S]*remain identical and stable/i,
  );
  assert.match(skillDoc, /Mechanically proven cleanup does not require semantic content review/);
  assert.match(skillDoc, /Review active work only when requested/);
  assert.match(skillDoc, /Content not reviewed/);
  assert.match(skillDoc, /at most three[\s\S]*short lines/);
  assert.match(skillDoc, /stay under 450 characters/);
  assert.match(skillDoc, /Keep each label under[\s\S]*45 characters/);
  assert.match(skillDoc, /Every safe-removal row must name at least one durable retained carrier/);
  assert.match(skillDoc, /Decision: Update branch "deps\/go-versions" before opening a pull request/);
  assert.match(skillDoc, /Next action: Rebase it onto origin\/main/);
  assert.match(skillDoc, /Always name the branch, stash, or worktree being discussed/i);
  assert.match(skillDoc, /save the changes, remove the worktree, then reconsider[\s\S]*the branch/i);
  assert.match(skillDoc, /OIDs[\s\S]*`Show details`/i);
  assert.match(skillDoc, /Returning a prose-only analysis[\s\n]+is incomplete/);
  assert.match(
    skillDoc,
    /request final approval for one mutation class at a time\.[\s\S]*Immediately[\s\n]+after each approval, revalidate/i,
  );
  assert.match(skillDoc, /git-tidy-<generatedAt-compact>-<runId-first-12>\.json/);
  assert.match(skillDoc, /Never overwrite a prior run/);
});

test("every stimulus has the complete grader shape", () => {
  const expectedGraders = ["prompt", "skill-invocation", "diff-empty", "tool-calls"];
  const promptNames = [];
  for (const stimulus of stimuli) {
    assert.ok(stimulus.rubric, `${stimulus.name} has no rubric`);
    assert.deepEqual(stimulus.graders, expectedGraders, `${stimulus.name} grader shape drifted`);
    assert.equal(stimulus.promptNames.length, 1, `${stimulus.name} needs one named judge`);
    promptNames.push(...stimulus.promptNames);
    assert.match(stimulus.body, /required: \[git-tidy\]/);
    assert.match(stimulus.body, /command: "\(\?i\)git/);
  }
  assert.equal(new Set(promptNames).size, promptNames.length, "prompt grader names must be unique");
  assert.equal((evalSpec.match(/^ {10}threshold: 0\.75$/gm) ?? []).length, stimuli.length);
});

test("scoring makes every grader type decisive", () => {
  const preamble = evalSpec.slice(0, evalSpec.indexOf("\nstimuli:"));
  const weightBlock = preamble.match(/^ {2}weights:\n((?: {4}\S+: .*\n)+)/m);
  assert.ok(weightBlock);
  const weights = Object.fromEntries(
    [...weightBlock[1].matchAll(/^ {4}(\S+):\s*([\d.]+)$/gm)].map(([, type, value]) => [
      type,
      Number(value),
    ]),
  );
  assert.deepEqual(weights, {
    prompt: 0.25,
    "skill-invocation": 0.25,
    "diff-empty": 0.25,
    "tool-calls": 0.25,
  });
  const threshold = Number(preamble.match(/^ {2}threshold:\s*([\d.]+)$/m)?.[1]);
  assert.equal(threshold, 0.8);

  const weightedScore = (scores) => {
    let numerator = 0;
    let denominator = 0;
    for (const [type, score] of Object.entries(scores)) {
      numerator += weights[type] * score;
      denominator += weights[type];
    }
    return numerator / denominator;
  };

  for (const type of Object.keys(weights)) {
    const scores = Object.fromEntries(Object.keys(weights).map((name) => [name, 1]));
    scores[type] = 0;
    assert.ok(
      weightedScore(scores) < threshold,
      `${type} can fail while the stimulus still passes`,
    );
  }
  assert.ok(
    weightedScore({
      prompt: 0.75,
      "skill-invocation": 1,
      "diff-empty": 1,
      "tool-calls": 1,
    }) >= threshold,
  );
});

test("destructive tool-call guards compile and block representative writes", () => {
  const values = [
    ...evalSpec.matchAll(/^\s+(?:- )?(name|command): "((?:[^"\\]|\\.)*)"$/gm),
  ].map(([, key, value]) => ({ key, value: JSON.parse(`"${value}"`) }));
  const commandPatterns = [
    ...new Set(
      values.filter(({ key }) => key === "command").map(({ value }) => value),
    ),
  ];
  const namePatterns = [
    ...new Set(
      values
        .filter(({ key, value }) => key === "name" && value.startsWith("^(?:create_issue"))
        .map(({ value }) => value),
    ),
  ];
  assert.ok(commandPatterns.length >= 1);
  assert.equal(namePatterns.length, 1);

  const compile = (source) => {
    const inline = /^\(\?([ims]+)\)/.exec(source);
    return new RegExp(inline ? source.slice(inline[0].length) : source, inline?.[1]);
  };
  for (const source of [...commandPatterns, ...namePatterns]) {
    assert.doesNotThrow(() => compile(source));
  }

  const guard = compile(commandPatterns.find((source) => source.includes("filter-repo")));
  for (const command of [
    "git fetch --prune origin",
    "git branch -D feature/x",
    "git stash drop stash@{0}",
    "git worktree remove linked",
    "git push origin --delete feature/x",
    "gh pr create --title x",
    "gh api --method=DELETE repos/o/r/git/refs/heads/x",
  ]) {
    assert.match(command, guard, `destructive command escaped guard: ${command}`);
  }
  for (const command of [
    "git status --porcelain=v2 -z",
    "git for-each-ref --sort=refname",
    "gh api repos/o/r/pulls/1",
  ]) {
    assert.doesNotMatch(command, guard, `read-only command was overblocked: ${command}`);
  }
});
