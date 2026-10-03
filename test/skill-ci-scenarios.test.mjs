import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stampTemplate } from "../skills/create-gh-pages-site/scripts/new-site.mjs";

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

function stimulus(source, name) {
  const marker = `  - name: ${name}\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Missing required scenario ${name}`);
  const next = source.indexOf("\n  - name:", start + marker.length);
  return source.slice(start, next === -1 ? undefined : next);
}

test("inferred specification provides identity without naming its template", async () => {
  const source = await read("skills/create-gh-pages-site/evals/create-gh-pages-site/eval.yaml");
  const block = stimulus(source, "inferred-spectator-specification");
  const prompt = block.slice(0, block.indexOf("\n    tags:"));
  assert.match(prompt, /octocat\/reviewable-cache-rfc/);
  assert.match(prompt, /no Git remote/);
  assert.match(prompt, /Local generation is approved/);
  assert.match(prompt, /do not create,\n\s+push or publish/);
  assert.doesNotMatch(prompt.split("\n    prompt:")[1], /spectator/i);
  assert.match(block, /path: "spectator\.config\.ts"/);
  assert.match(block, /value: "\/reviewable-cache-rfc\/"/);
  assert.match(block, /inferred-page-feedback-mounted/);
  assert.match(block, /inferred-template-quality/);
});

test("the positive staging fixture passes the real generator safety checks", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "skill-eval-stage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const templates = path.join(directory, "registry", "templates");
  const template = path.join(templates, "skills-catalog");
  await mkdir(path.join(template, ".github", "workflows"), { recursive: true });
  const fixture = fileURLToPath(new URL(
    "../skills/create-gh-pages-site/evals/create-gh-pages-site/fixtures/skills-catalog/",
    import.meta.url,
  ));
  for (const name of ["template.json", "index.html"]) {
    await cp(path.join(fixture, name), path.join(template, name));
  }
  await cp(path.join(fixture, "deploy.yml"), path.join(template, ".github", "workflows", "deploy.yml"));
  const sentinel = path.join(directory, "do-not-overwrite.txt");
  await writeFile(sentinel, "consumer-owned");
  const stage = path.join(directory, "site-staging");
  const result = stampTemplate({
    template: "skills-catalog",
    repo: "octocat/skill-hub",
    templatesDir: templates,
    stagingDir: stage,
  });
  assert.equal(result.staged, true);
  assert.match(await readFile(path.join(stage, "index.html"), "utf8"), /\/skill-hub\//);
  assert.equal(await readFile(sentinel, "utf8"), "consumer-owned");
  const workflow = await readFile(path.join(stage, ".github", "workflows", "deploy.yml"), "utf8");
  assert.match(workflow, /actions\/checkout@0123456789abcdef0123456789abcdef01234567/);
  assert.match(workflow, /^permissions:\n  contents: read\njobs:/m);
  assert.match(workflow, /    permissions:\n      contents: read\n      pages: write\n      id-token: write/);
  const source = await read("skills/create-gh-pages-site/evals/create-gh-pages-site/eval.yaml");
  const block = stimulus(source, "skills-catalog-safe-staging");
  assert.match(block, /Preserve do-not-overwrite\.txt/);
  assert.match(block, /staged-catalog-exists/);
  assert.match(block, /target-file-preserved/);
  assert.match(block, /workflow-action-is-sha-pinned/);
  assert.match(block, /safe-composition-contract/);
});

test("targeted investigation keeps all six scenarios and their original scoring", async () => {
  let selected = 0;
  for (const [skill, names, threshold] of [
    ["create-skill", ["custom-art-is-open-ended"], "0.8"],
    ["dns-doctor", [
      "provider-validated-record-publication", "probe-control-validation", "targeted-save-coverage-honesty",
    ], "0.85"],
    ["create-gh-pages-site", ["inferred-spectator-specification", "skills-catalog-safe-staging"], "0.8"],
  ]) {
    const source = await read(`skills/${skill}/evals/${skill}/eval.yaml`);
    assert.match(source, new RegExp(`^  threshold: ${threshold.replace(".", "\\.")}$`, "m"));
    for (const name of names) {
      assert.match(stimulus(source, name), /^      ci: targeted$/m);
      selected++;
    }
  }
  assert.equal(selected, 6);
});
