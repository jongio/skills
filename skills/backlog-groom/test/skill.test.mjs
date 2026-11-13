import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (relative) =>
  (await readFile(new URL(`../${relative}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const skill = await read("SKILL.md");

test("portable skill frontmatter contains name, description, and version metadata", () => {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const keys = [...frontmatter[1].matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
  assert.deepEqual(keys, ["name", "description", "metadata"]);
  assert.match(frontmatter[1], /^  version: "[^"\r\n]+"$/m);
  assert.match(frontmatter[1], /^name: backlog-groom$/m);
});

test("skill includes workflow, safety, and exit criteria", () => {
  assert.match(skill, /^## Workflow$/m);
  assert.match(skill, /^## Safety$/m);
  assert.match(skill, /^## Exit Criteria$/m);
});

test("instructions are bounded, portable, ASCII-clean, and all relative links resolve", async () => {
  assert.ok(skill.split("\n").length <= 500);
  const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)];
  assert.deepEqual(new Set(links.map(([, link]) => link)), new Set([
    "references/evidence-ledger.md",
    "references/organization.md",
    "references/safe-operations.md",
    "references/unattended-policy.md",
  ]));
  for (const doc of ["SKILL.md", ...new Set(links.map(([, link]) => link))]) {
    const content = await read(doc);
    assert.ok(content.length > 100, doc);
    assert.doesNotMatch(content, /DEVX_WS|_shared[\\/]|C:\\Users\\|\/Users\/|installed-plugins/, doc);
    assert.doesNotMatch(content, /[\u2013\u2014]/, `${doc} must use ASCII '-' instead of Unicode en/em dashes`);
  }
});

const contracts = [
  ["independent source discovery and issues-only access", "SKILL.md", [
    /many-to-many/i, /authoritative/i, /branches\/tags/, /subdirectories/,
    /Do not assume.*current checkout/, /declin.*Project/i,
    /Audit mode is read-only/, /fully qualified reference, title, short scope/i,
  ]],
  ["completion evidence cannot collapse acceptance boundaries", "references/evidence-ledger.md", [
    /selected source revision/, /merged PR.*not.*proof/i, /actually executed/,
    /installed-host qualification/i, /live evaluation/i, /released\/publication-approved/i,
    /partial implementation/, /earlier grooming or audit comment/i,
    /research.*duplicate.*not.planned/i,
    /open parent.*closed children/i, /unavailable.*unknown/i,
  ]],
  ["workflow and ownership are preserved instead of guessed", "references/organization.md", [
    /parentage.*scope.*dependency.*ordering/i, /cycles/,
    /Preserve all.*Assignees/, /PR author.*not.*owner/i,
    /definitions and populated values/, /Now\/Next\/Later/,
    /Global Status/, /Blank health.*unassessed/,
    /target.*commitment/i, /nested.*children/i, /person slicing/,
  ]],
  ["mutation authority and uncertain results fail closed", "references/safe-operations.md", [
    /Audit mode.*read-only/, /distinct approval/,
    /empty replacement collection/, /card.*Done.*close/i, /Item reopened/,
    /backfill/, /case-sensitive/, /raw.*html/,
    /Enterprise Managed User/i, /GH_PROMPT_DISABLED=1/, /GH_PAGER=cat/,
    /pagination/, /Content already exists in this project/,
    /partial mutation/, /rate limit/,
    /direct.*record/, /aggregate.*lag/i, /re-read/i,
    /changed source heads/, /newer.*edits/i,
    /three.*attempts/, /Do not terminate.*browser/i,
    /getBoundingClientRect/, /Save changes to new view/, /\?visibleFields=/,
  ]],
];

for (const [name, file, clauses] of contracts) {
  test(`instruction contract: ${name}`, async () => {
    const content = (await read(file)).replace(/\s+/g, " ");
    for (const clause of clauses) assert.match(content, clause, `${file}: ${clause}`);
  });
}
