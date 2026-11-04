import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePrPollTick, extractBodyOnlyFindings, parsePrWatchArgs } from "../scripts/pr-watch-daemon.mjs";

const review = (databaseId, body, overrides = {}) => ({
  databaseId,
  state: "COMMENTED",
  submittedAt: `2026-10-22T20:${String(databaseId - 100).padStart(2, "0")}:00Z`,
  author: { login: "copilot-pull-request-reviewer" },
  commit: { oid: databaseId === 100 ? "old-head" : "current-head" },
  body,
  ...overrides,
});
const summary = text => `### 🔵 Needs a closer look\n\n${text}\n\n**No open issues**`;
const disposition = (id, body = "") => ({
  createdAt: "2026-10-22T20:00:30Z",
  body: `Review ${id}: addressed in the fixing commit. ${body}`,
});

test("advisory headings alone do not manufacture body findings", () => {
  for (const body of ["### 🔵 Needs a closer look", summary("")]) {
    assert.deepEqual(extractBodyOnlyFindings([review(100, body)], [], "current-head"), []);
  }
});

test("identical concerns across heads share one finding and retain source review IDs", () => {
  const findings = extractBodyOnlyFindings([
    review(100, summary("Check retained evidence before adopting journals.")),
    review(101, summary("Check retained evidence\nbefore adopting journals.")),
  ], [], "current-head");
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].relatedReviewIds, [100, 101]);
  assert.deepEqual(findings[0].unsettledConcerns, ["Check retained evidence before adopting journals."]);
});

test("a revalidated disposition covers identical repeats, not new evidence", () => {
  const first = review(100, summary("Check retained evidence before adopting journals."));
  const repeated = review(101, summary("Check retained evidence before adopting journals."));
  const revalidated = { ...disposition(100, "Revalidated review 101."), updatedAt: "2026-10-22T20:01:30Z" };
  assert.deepEqual(
    extractBodyOnlyFindings([repeated, first], [revalidated], "current-head"),
    [],
  );
  const findings = extractBodyOnlyFindings([
    first,
    repeated,
    review(102, summary("The new migration branch deletes retained evidence before verification.")),
  ], [revalidated], "current-head");
  assert.deepEqual(findings.map(finding => finding.reviewId), [102]);
});

test("an old disposition cannot silence a renewed concern in a later review", () => {
  const findings = extractBodyOnlyFindings([
    review(100, summary("Check retained evidence before adopting journals.")),
    review(101, summary("Check retained evidence before adopting journals.")),
  ], [disposition(100)], "current-head");
  assert.deepEqual(findings.map(finding => finding.reviewId), [101]);
});

test("editing another disposition cannot settle renewed feedback without its review ID", () => {
  const findings = extractBodyOnlyFindings([
    review(100, summary("Check retained evidence before adopting journals.")),
    review(101, summary("Check retained evidence before adopting journals.")),
    review(102, summary("Await shutdown before releasing process ownership.")),
  ], [{
    ...disposition(100, "Review 102: addressed process ownership."),
    updatedAt: "2026-10-22T20:03:00Z",
  }], "current-head");
  assert.deepEqual(findings.map(finding => finding.reviewId), [101]);
});

test("location headings keep identical wording at different paths distinct", () => {
  const findings = extractBodyOnlyFindings([
    review(100, "### src/alpha.mjs:10\nAwait shutdown before releasing ownership."),
    review(101, "### src/beta.mjs:20\nAwait shutdown before releasing ownership."),
  ], [], "current-head");
  assert.equal(findings.length, 2);
  const unresolved = extractBodyOnlyFindings([
    review(100, "### src/alpha.mjs:10\nAwait shutdown before releasing ownership."),
    review(101, "### src/beta.mjs:20\nAwait shutdown before releasing ownership."),
  ], [{ ...disposition(100), updatedAt: "2026-10-22T20:02:00Z" }], "current-head");
  assert.deepEqual(unresolved.map(finding => finding.reviewId), [101]);
});

test("summary cards have one disposition identity while explanation changes remain evidence", () => {
  const card = explanation => `<summary><picture><img></picture>Timeout</summary>${explanation}`;
  for (const body of [card("The worker can outlive cancellation."),
    `<details>${card("The worker can outlive cancellation.")}</details>`]) {
    const findings = extractBodyOnlyFindings([review(100, body)], [], "current-head");
    assert.deepEqual(findings[0].unsettledConcerns, ["Timeout"]);
    assert.deepEqual(extractBodyOnlyFindings([review(100, body)], [disposition(100, "Timeout fixed.")], "current-head"), []);
  }
  const findings = extractBodyOnlyFindings([
    review(100, `<details>${card("The worker can outlive cancellation.")}</details>`),
    review(101, `<details>${card("A new retry branch releases ownership before shutdown.")}</details>`),
  ], [], "current-head");
  assert.equal(findings.length, 2);
});

test("nested cards, standalone cards, and following Markdown sections retain independent concerns", () => {
  const card = (title, explanation) => `<summary><picture><img></picture>${title}</summary>${explanation}`;
  const timeout = card("Timeout", "The worker can outlive cancellation.");
  const ownership = card("Ownership", "The retry releases ownership before shutdown.");
  for (const body of [
    `<details>${timeout}<details>${ownership}</details>More timeout evidence.</details>`,
    `${timeout}\n${ownership}`,
    `${timeout}\n### Ownership\nThe retry releases ownership before shutdown.`,
  ]) {
    const findings = extractBodyOnlyFindings([review(100, body)], [disposition(100, "Timeout fixed.")], "current-head");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].unsettledConcerns.length, 1);
    assert.match(findings[0].unsettledConcerns[0], /Ownership|retry releases ownership/);
  }
});

test("new evidence attached to an existing inline link still requires disposition", () => {
  const body = title => `### Findings\n- [${title}](https://github.com/example/repo/pull/1#discussion_r42)`;
  const findings = extractBodyOnlyFindings([
    review(100, body("Check retained evidence")),
    review(101, body("The new migration path deletes retained evidence")),
  ], [{ ...disposition(100), updatedAt: "2026-10-22T20:02:00Z" }], "current-head");
  assert.deepEqual(findings.map(finding => finding.reviewId), [101]);
});

test("headings inside balanced cards remain evidence, unlike following standalone sections", () => {
  const card = `<summary><picture><img></picture>Timeout</summary>\n### Reproduction\nThe worker outlives cancellation.`;
  const balanced = `<details>${card}</details>`;
  const findings = extractBodyOnlyFindings([review(100, balanced)], [], "current-head");
  assert.deepEqual(findings[0].unsettledConcerns, ["Timeout"]);
  assert.deepEqual(extractBodyOnlyFindings([review(100, balanced)], [disposition(100, "Timeout fixed.")], "current-head"), []);
  const standalone = extractBodyOnlyFindings([review(100, card)], [disposition(100, "Timeout fixed.")], "current-head");
  assert.equal(standalone.length, 1);
  assert.match(standalone[0].unsettledConcerns[0], /worker outlives/);
});

test("each card retains its own location when reviews swap cards under the same headings", () => {
  const card = title => `<details><summary><picture><img></picture>${title}</summary>Check cancellation.</details>`;
  const body = (first, second) => `### src/alpha.mjs:10\n${card(first)}\n### src/beta.mjs:20\n${card(second)}`;
  const findings = extractBodyOnlyFindings([
    review(100, body("Timeout", "Validation")),
    review(101, body("Validation", "Timeout")),
  ], [], "current-head");
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map(finding => finding.relatedReviewIds), [[100], [101]]);
  const details = findings.flatMap(finding => finding.unsettledConcernDetails);
  assert.equal(new Set(details.map(concern => concern.id)).size, 4);
  const duplicateTitles = review(100, body("Timeout", "Timeout"));
  const duplicateFindings = extractBodyOnlyFindings([duplicateTitles], [disposition(100, "Timeout fixed.")], "current-head");
  assert.equal(duplicateFindings[0].unsettledConcerns.length, 2);
  const firstId = duplicateFindings[0].unsettledConcernDetails[0].id;
  const partial = extractBodyOnlyFindings([duplicateTitles], [disposition(100, `${firstId} fixed.`)], "current-head");
  assert.equal(partial[0].unsettledConcerns.length, 1);
  assert.match(partial[0].unsettledConcernDetails[0].context, /beta/);
});

test("prose has a concise explicit identity without copying evidence or clearing other concerns", () => {
  const prose = "The cancellation worker releases ownership before the child process has fully stopped, allowing another worker to adopt the same running process.";
  const card = `<details><summary><picture><img></picture>Timeout</summary>Wait for shutdown.</details>`;
  const first = review(100, `${summary(prose)}\n${card}`);
  const findings = extractBodyOnlyFindings([first], [], "current-head");
  const detail = findings[0].unsettledConcernDetails.find(concern => concern.evidence.includes(prose));
  assert.match(detail.id, /^concern:[a-f0-9]{16}$/);
  const partial = extractBodyOnlyFindings([first], [disposition(100, `${detail.id} fixed.`)], "current-head");
  assert.deepEqual(partial[0].unsettledConcerns, ["Timeout"]);
  assert.deepEqual(extractBodyOnlyFindings([first], [disposition(100, `${detail.id} and Timeout fixed.`)], "current-head"), []);
  const renewed = extractBodyOnlyFindings([first, review(101, `${summary(prose)}\n${card}`)],
    [disposition(100, `${detail.id} and Timeout fixed.`)], "current-head");
  assert.deepEqual(renewed.map(finding => finding.reviewId), [101]);
  const changed = extractBodyOnlyFindings([review(100, `${summary(`${prose} A new retry also loses ownership.`)}\n${card}`)],
    [disposition(100, `${detail.id} and Timeout fixed.`)], "current-head");
  assert.equal(changed[0].unsettledConcernDetails.length, 1);
  assert.notEqual(changed[0].unsettledConcernDetails[0].id, detail.id);
});

test("same headline, different authors, or an early comment cannot settle distinct findings", () => {
  const findings = extractBodyOnlyFindings([
    review(100, summary("Check retained evidence before adopting journals.")),
    review(101, summary("Check retained evidence before adopting journals."), { author: { login: "alice" } }),
    review(102, summary("The timeout can leave an owned process running.")),
  ], [disposition(102)], "current-head");
  assert.deepEqual(findings.map(finding => finding.reviewId), [100, 101, 102]);
});

test("deduplication never clears an active changes-requested decision", () => {
  const findings = extractBodyOnlyFindings([
    review(100, summary("Check retained evidence before adopting journals.")),
    review(101, summary("Check retained evidence before adopting journals."), { state: "CHANGES_REQUESTED" }),
  ], [disposition(100)], "current-head");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].state, "CHANGES_REQUESTED");
  assert.equal(findings[0].reviewId, 101);
  const emptyDecision = extractBodyOnlyFindings([
    review(100, "", { state: "CHANGES_REQUESTED" }),
  ], [disposition(100)], "current-head");
  assert.equal(emptyDecision.length, 1);
});

test("resolved inline links do not hide nested or same-line body-only evidence", () => {
  const link = "- [Fixed timeout](https://github.com/example/repo/pull/1#discussion_r42)";
  for (const body of [
    `${summary("")}\n${link}\n<details><summary>Previously missed</summary>The cancellation path still releases ownership too early.</details>`,
    `${summary("")}\n${link} The cancellation path still releases ownership too early.`,
  ]) {
    const findings = extractBodyOnlyFindings([review(100, body)], [], "current-head", new Set([42]));
    assert.equal(findings.length, 1);
    assert.match(findings[0].unsettledConcerns[0], /cancellation path/);
  }
});

test("status summaries cannot hide unlinked evidence or prove an inline concern resolved", () => {
  for (const status of ["1 open issue", "1 resolved since last review"]) {
    const wrap = text => `### Findings\n<details><summary><strong>${status}</strong></summary>\n${text}\n</details>`;
    const concrete = extractBodyOnlyFindings([
      review(100, wrap("The cancellation path releases ownership before shutdown completes.")),
    ], [], "current-head");
    assert.equal(concrete.length, 1);
    assert.match(concrete[0].unsettledConcerns[0], /cancellation path/);
    const linked = review(100, wrap("- [Check cancellation](https://github.com/example/repo/pull/1#discussion_r42)"));
    assert.equal(extractBodyOnlyFindings([linked], [], "current-head").length, 1);
    assert.deepEqual(extractBodyOnlyFindings([linked], [], "current-head", new Set([42])), []);
  }
});

test("the production poll honors edited consolidated dispositions without waiving later feedback", async () => {
  const args = parsePrWatchArgs(["once", "--repo", "example/repo", "--pr", "1", "--head", "current-head", "--since-comment-id", "500"]);
  const body = summary("Check retained evidence before adopting journals.");
  for (const [updatedAt, ready] of [
    [undefined, false],
    ["2026-10-22T20:01:30Z", true],
  ]) {
    const result = await evaluatePrPollTick(args, request => {
      if (request.kind !== "graphql") {
        return { ok: true, status: 200, headers: {}, data: { workflow_runs: [] } };
      }
      assert.match(request.query, /createdAt\s+updatedAt/);
      return {
        ok: true,
        status: 200,
        headers: {},
        data: { data: { repository: { pullRequest: {
          state: "OPEN",
          headRefOid: "current-head",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: null,
          reviewRequests: { nodes: [] },
          reviews: { nodes: [review(100, body), review(101, body)] },
          reviewThreads: { nodes: [] },
          comments: { nodes: [{ ...disposition(100, updatedAt ? "Revalidated review 101." : ""), databaseId: 500, updatedAt }] },
          commits: { nodes: [{ commit: { statusCheckRollup: {
            state: "SUCCESS",
            contexts: { nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] },
          } } }] },
        } } } },
      };
    });

    test("the production poll exposes concise identities and keeps partially addressed prose blocking", async () => {
      const args = parsePrWatchArgs(["once", "--repo", "example/repo", "--pr", "1", "--head", "current-head", "--since-comment-id", "500"]);
      const body = "### src/alpha.mjs:10\nThe cancellation path releases ownership before shutdown.\n" +
        "<details><summary><picture><img></picture>Timeout</summary>\n### Reproduction\nThe worker outlives cancellation.</details>";
      let response = "";
      const poll = () => evaluatePrPollTick(args, request => ({
        ok: true, status: 200, headers: {},
        data: request.kind !== "graphql" ? { workflow_runs: [] } : { data: { repository: { pullRequest: {
          state: "OPEN", headRefOid: "current-head", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
          reviewRequests: { nodes: [] }, reviews: { nodes: [review(101, body)] }, reviewThreads: { nodes: [] },
          comments: { nodes: response ? [{ databaseId: 500, body: response, createdAt: "2026-10-22T20:02:00Z" }] : [] },
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: {
            nodes: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
          } } } }] },
        } } } },
      }));
      const first = await poll();
      const details = first.events[0].bodyFindings[0].unsettledConcernDetails;
      assert.equal(details.length, 2);
      const prose = details.find(concern => concern.evidence.includes("releases ownership"));
      response = `Review 101: ${prose.id} fixed.`;
      const partial = await poll();
      assert.equal(partial.events[0].type, "FEEDBACK_ACTION_NEEDED");
      assert.deepEqual(partial.events[0].bodyFindings[0].unsettledConcerns, ["Timeout"]);
      response += " Timeout fixed.";
      assert.equal((await poll()).events[0].type, "PR_READY_TO_MERGE");
    });
    assert.equal(result.events.some(event => event.type === "PR_READY_TO_MERGE"), ready, JSON.stringify(result.events));
    assert.equal(result.events.some(event => event.type === "FEEDBACK_ACTION_NEEDED"), !ready, JSON.stringify(result.events));
  }
});
