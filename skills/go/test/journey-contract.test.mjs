import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSkill = async (name) =>
  (await readFile(new URL(`../../${name}/SKILL.md`, import.meta.url), "utf8")).replace(/\s+/g, " ");
const [go, doctor, pr, refactor] = await Promise.all(
  ["go", "test-doctor", "pr", "refactor"].map(readSkill),
);

// These synthetic scenarios protect instruction wiring, not observed agent behavior.
test("two green entry points with incompatible approval order require one intended contract", () => {
  assert.match(go, /Before defining touched scope, map affected user journeys, equivalent entry points, and the canonical behavior owner/);
  assert.match(go, /smallest coherent product change, not the fewest files/);
  assert.match(go, /shared sequence, approval information, cancellation, retries\/recovery, and outcome semantics/);
  assert.match(go, /including durable effects and continuations/);
  assert.match(go, /Centralize shared sequencing rather than duplicating host logic/);
  assert.match(doctor, /one independently established intended contract, not separate expectations copied from each implementation/);
  assert.match(doctor, /approval ordering and information/);
  assert.match(pr, /Green tests and reviews alone do not establish parity/);
});

test("justified native UI and authentication differences do not require identical surfaces", () => {
  assert.match(go, /Justify capability or presentation differences/);
  assert.match(go, /disclose capability gaps rather than silently substituting a different journey/);
  assert.match(doctor, /Allow justified capability, native UI, and authentication-adapter differences/);
  assert.match(doctor, /do not require identical pixels or duplicate every E2E/);
});

test("a narrow audit reports an unverified sibling gap without authorizing edits", () => {
  assert.match(doctor, /Impacted sibling paths outside the authorized audit scope remain unverified gaps/);
  assert.match(doctor, /report them without expanding edits or claiming parity/);
  assert.match(go, /Do not turn this into a whole-repository audit or silently expand authorized edits/);
});

test("direct PR invocation checks applicable evidence without requiring a go handoff", () => {
  assert.match(pr, /including direct `pr` invocation without `go`/);
  assert.match(pr, /affected surfaces, journey contract, and exception evidence/);
  assert.match(pr, /explicitly justified scoped exception\/decision/);
  assert.match(pr, /same worktree, base, changeset, and scope/);
  assert.match(pr, /full current head OID/);
});

test("refactor distinguishes observed divergence from an approved behavior correction", () => {
  assert.match(refactor, /Journey divergence is a product-behavior decision/);
  assert.match(refactor, /neither silently harmonize it nor call accidental drift an established product contract/);
  assert.match(refactor, /Record it separately for behavior correction/);
  assert.match(refactor, /without making unrelated fixes prerequisites/);
});

test("go, Test Doctor, and PR retain distinct discovery, verification, and delivery ownership", () => {
  assert.ok(go.indexOf("Before defining touched scope") < go.indexOf("Invoke `test-doctor fix`"));
  assert.match(go, /affected behavioral scope/);
  assert.match(go, /journey contract, affected surfaces, exception evidence/);
  assert.match(go, /introduced duplication and state complexity/);
  assert.match(doctor, /real adapter integration seams/);
  assert.match(doctor, /denial\/cancel, retries\/idempotency\/recovery, and durable or partial results/);
  assert.match(doctor, /Do not mock the behavior under test/);
  assert.match(pr, /Reuse .*`go`\/`test-doctor` evidence under the identity rule/);
  assert.match(pr, /Missing applicable evidence is a gap for scoped verification, not a duplicate discovery procedure/);
});
