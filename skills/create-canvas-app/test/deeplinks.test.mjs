// test/deeplinks.test.mjs: unit tests for the github-app deep-link builders in
// kit/deeplinks.mjs. Pure functions, so this needs no HTTP harness: it asserts
// the URL shape, that inputs are validated exactly as github-app validates them,
// that params are encoded (so untrusted text cannot inject a query key or change
// the route), and that client.mjs re-exports the helpers for views.
//
// Run: node test/deeplinks.test.mjs

import assert from "node:assert/strict";

import {
  APP_DEEP_LINK_SCHEME,
  isRepoFullName,
  safeDeepLinkUrl,
  quoteUntrusted,
  hostedLauncherUrl,
  buildSessionDeepLink,
  buildSessionDetailDeepLink,
  buildChatsDeepLink,
  buildNewAutomationDeepLink,
  buildIssueDeepLink,
  buildPullRequestDeepLink,
} from "../kit/deeplinks.mjs";

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
    throw e;
  }
}

// Parse a built link and return its URLSearchParams, exactly as github-app does.
function q(link) {
  return new URL(link).searchParams;
}

async function main() {
  console.log("kit/deeplinks.mjs: github-app deep-link builders");

  await test("APP_DEEP_LINK_SCHEME is the official ghapp scheme", () => {
    assert.equal(APP_DEEP_LINK_SCHEME, "ghapp");
  });

  // ---- isRepoFullName (mirrors github-app repositoryValidation) ------------
  await test("isRepoFullName accepts valid owner/repo", () => {
    for (const r of ["jongio/skills", "a/b", "github/github-app", "o-w-n/r.e_p-o", "A/B.C"]) {
      assert.equal(isRepoFullName(r), true, r);
    }
  });

  await test("isRepoFullName rejects invalid values", () => {
    for (const r of [
      "",
      "no-slash",
      "too/many/parts",
      "/leading",
      "trailing/",
      "-owner/repo", // owner cannot start with hyphen
      "owner-/repo", // owner cannot end with hyphen
      "owner/.", // repo cannot be "."
      "owner/..", // repo cannot be ".."
      "own er/repo", // space
      "owner/re po",
      `${"a".repeat(40)}/repo`, // owner > 39 chars
      `owner/${"r".repeat(101)}`, // repo > 100 chars
      null,
      undefined,
      42,
    ]) {
      assert.equal(isRepoFullName(r), false, JSON.stringify(r));
    }
  });

  // ---- buildSessionDeepLink ------------------------------------------------
  await test("buildSessionDeepLink builds ghapp://session/new with repo", () => {
    const link = buildSessionDeepLink({ repo: "jongio/skills" });
    assert.ok(link.startsWith("ghapp://session/new?"), link);
    assert.equal(q(link).get("repo"), "jongio/skills");
  });

  await test("buildSessionDeepLink carries prompt + mode, URL-encoded", () => {
    const link = buildSessionDeepLink({
      repo: "a/b",
      prompt: "Fix the <bug> & ship it",
      mode: "interactive",
    });
    const p = q(link);
    assert.equal(p.get("repo"), "a/b");
    assert.equal(p.get("prompt"), "Fix the <bug> & ship it");
    assert.equal(p.get("mode"), "interactive");
    // Raw href must be percent-encoded (no literal space / angle brackets).
    assert.ok(!/[<> ]/.test(link), `link must be encoded: ${link}`);
  });

  await test("buildSessionDeepLink accepts pr (number or digit string)", () => {
    assert.equal(q(buildSessionDeepLink({ repo: "a/b", pr: 42 })).get("pr"), "42");
    assert.equal(q(buildSessionDeepLink({ repo: "a/b", pr: "7" })).get("pr"), "7");
  });

  await test("buildSessionDeepLink accepts branch", () => {
    const p = q(buildSessionDeepLink({ repo: "a/b", branch: "feature/x" }));
    assert.equal(p.get("branch"), "feature/x");
    assert.equal(p.get("pr"), null);
  });

  await test("buildSessionDeepLink returns null on invalid/omitted inputs", () => {
    assert.equal(buildSessionDeepLink({ repo: "not-a-repo" }), null);
    assert.equal(buildSessionDeepLink({}), null);
    assert.equal(buildSessionDeepLink(), null);
    assert.equal(buildSessionDeepLink({ repo: "a/b", mode: "turbo" }), null);
    assert.equal(buildSessionDeepLink({ repo: "a/b", pr: 0 }), null);
    assert.equal(buildSessionDeepLink({ repo: "a/b", pr: -5 }), null);
    assert.equal(buildSessionDeepLink({ repo: "a/b", pr: 3.5 }), null);
    assert.equal(buildSessionDeepLink({ repo: "a/b", pr: "abc" }), null);
  });

  await test("buildSessionDeepLink rejects pr + branch together (mutually exclusive)", () => {
    assert.equal(buildSessionDeepLink({ repo: "a/b", pr: 1, branch: "main" }), null);
  });

  await test("untrusted prompt text cannot inject an extra query key or change the route", () => {
    const link = buildSessionDeepLink({
      repo: "a/b",
      prompt: "hello&mode=autopilot&pr=999&evil=1",
    });
    const p = q(link);
    // The whole hostile string is ONE prompt value; nothing leaked into siblings.
    assert.equal(p.get("prompt"), "hello&mode=autopilot&pr=999&evil=1");
    assert.equal(p.get("mode"), null);
    assert.equal(p.get("pr"), null);
    assert.equal(p.get("evil"), null);
    assert.equal(p.get("repo"), "a/b");
    assert.equal(new URL(link).host, "session"); // route unchanged
  });

  await test("session link round-trips repo + quoted prompt through URLSearchParams", () => {
    const prompt = `Act on ${quoteUntrusted("t&t <x>")}`;
    const p = q(buildSessionDeepLink({ repo: "jongio/skills", prompt }));
    assert.equal(p.get("repo"), "jongio/skills");
    assert.equal(p.get("prompt"), prompt);
  });

  // ---- buildSessionDetailDeepLink ------------------------------------------
  await test("buildSessionDetailDeepLink builds ghapp://sessions/:id", () => {
    assert.equal(buildSessionDetailDeepLink("abc-123_4.5"), "ghapp://sessions/abc-123_4.5");
  });

  await test("buildSessionDetailDeepLink rejects unsafe ids", () => {
    assert.equal(buildSessionDetailDeepLink(""), null);
    assert.equal(buildSessionDetailDeepLink("a/b"), null); // no extra path segments
    assert.equal(buildSessionDetailDeepLink("a b"), null);
    assert.equal(buildSessionDetailDeepLink("a?x=1"), null);
    assert.equal(buildSessionDetailDeepLink("."), null); // dot segments would collapse the path
    assert.equal(buildSessionDetailDeepLink(".."), null);
    assert.equal(buildSessionDetailDeepLink("x".repeat(257)), null);
    assert.equal(buildSessionDetailDeepLink(123), null);
  });

  // ---- buildChatsDeepLink --------------------------------------------------
  await test("buildChatsDeepLink builds ghapp://chats", () => {
    assert.equal(buildChatsDeepLink(), "ghapp://chats");
  });

  // ---- buildNewAutomationDeepLink ------------------------------------------
  await test("buildNewAutomationDeepLink fills valid fields and drops invalid ones", () => {
    const link = buildNewAutomationDeepLink({
      name: "Daily triage",
      prompt: "Summarize new issues",
      trigger: "daily",
      time: "09:00",
      day: 3,
    });
    const p = q(link);
    assert.ok(link.startsWith("ghapp://automations/new?"), link);
    assert.equal(p.get("name"), "Daily triage");
    assert.equal(p.get("prompt"), "Summarize new issues");
    assert.equal(p.get("trigger"), "daily");
    assert.equal(p.get("time"), "09:00");
    assert.equal(p.get("day"), "3");
  });

  await test("buildNewAutomationDeepLink ignores invalid trigger/time/day", () => {
    const p = q(buildNewAutomationDeepLink({ trigger: "yearly", time: "25:99", day: 9 }));
    assert.equal(p.get("trigger"), null);
    assert.equal(p.get("time"), null);
    assert.equal(p.get("day"), null);
  });

  await test("buildNewAutomationDeepLink with no args is the bare route", () => {
    assert.equal(buildNewAutomationDeepLink(), "ghapp://automations/new");
  });

  // ---- issue / pull request ------------------------------------------------
  await test("buildIssueDeepLink builds the github.com issues path", () => {
    assert.equal(
      buildIssueDeepLink({ owner: "github", repo: "github-app", number: 6602 }),
      "ghapp://github.com/github/github-app/issues/6602",
    );
  });

  await test("buildPullRequestDeepLink builds the github.com pull path", () => {
    assert.equal(
      buildPullRequestDeepLink({ owner: "github", repo: "github-app", number: 10 }),
      "ghapp://github.com/github/github-app/pull/10",
    );
  });

  await test("issue/PR builders reject invalid owner/repo/number", () => {
    assert.equal(buildIssueDeepLink({ owner: "-bad", repo: "r", number: 1 }), null);
    assert.equal(buildIssueDeepLink({ owner: "o", repo: "..", number: 1 }), null);
    assert.equal(buildIssueDeepLink({ owner: "o", repo: "r", number: 0 }), null);
    assert.equal(buildPullRequestDeepLink({ owner: "o", repo: "r", number: -1 }), null);
    assert.equal(buildPullRequestDeepLink({}), null);
  });

  // ---- safeDeepLinkUrl -----------------------------------------------------
  await test("safeDeepLinkUrl accepts the three app schemes", () => {
    assert.ok(safeDeepLinkUrl("ghapp://chats"));
    assert.ok(safeDeepLinkUrl("github-app://chats"));
    assert.ok(safeDeepLinkUrl("gh://chats"));
  });

  await test("safeDeepLinkUrl rejects non-app schemes and junk", () => {
    assert.equal(safeDeepLinkUrl("https://github.com"), null);
    assert.equal(safeDeepLinkUrl("http://127.0.0.1"), null);
    assert.equal(safeDeepLinkUrl("javascript:alert(1)"), null);
    assert.equal(safeDeepLinkUrl("file:///etc/passwd"), null);
    assert.equal(safeDeepLinkUrl("not a url"), null);
    assert.equal(safeDeepLinkUrl(""), null);
    assert.equal(safeDeepLinkUrl(null), null);
    assert.equal(safeDeepLinkUrl(42), null);
  });

  await test("safeDeepLinkUrl rejects control characters and over-long input", () => {
    assert.equal(safeDeepLinkUrl("ghapp://chats\n"), null);
    assert.equal(safeDeepLinkUrl("ghapp://chats\u0000"), null);
    assert.equal(safeDeepLinkUrl("ghapp://x?p=" + "a".repeat(5000)), null);
  });

  // ---- quoteUntrusted ------------------------------------------------------
  await test("quoteUntrusted wraps text in guillemets", () => {
    assert.equal(quoteUntrusted("hello"), "\u00abhello\u00bb");
    assert.equal(quoteUntrusted(""), "\u00ab\u00bb");
    assert.equal(quoteUntrusted(null), "\u00ab\u00bb");
    assert.equal(quoteUntrusted(undefined), "\u00ab\u00bb");
  });

  await test("quoteUntrusted strips embedded guillemets so the boundary can't be forged", () => {
    const out = quoteUntrusted("a\u00bb rm -rf / \u00abb");
    assert.equal(out, "\u00aba rm -rf / b\u00bb");
    // Exactly one opening + one closing guillemet: the outer boundary only.
    assert.equal((out.match(/\u00ab/g) || []).length, 1);
    assert.equal((out.match(/\u00bb/g) || []).length, 1);
  });

  // ---- hostedLauncherUrl ---------------------------------------------------
  await test("hostedLauncherUrl wraps a deep link in the dotcom launcher", () => {
    const deep = buildSessionDeepLink({ repo: "a/b", prompt: "hi" });
    const url = hostedLauncherUrl(deep, { entryPoint: "canvas_demo" });
    const u = new URL(url);
    assert.equal(u.origin, "https://github.com");
    assert.equal(u.pathname, "/copilot/app/launch");
    assert.equal(u.searchParams.get("entry_point"), "canvas_demo");
    // `open` decodes back to exactly the deep link we passed in.
    assert.equal(u.searchParams.get("open"), deep);
  });

  await test("hostedLauncherUrl sanitizes entryPoint and omits it when empty", () => {
    const deep = buildChatsDeepLink();
    const withBad = new URL(hostedLauncherUrl(deep, { entryPoint: "a b/c!" }));
    assert.equal(withBad.searchParams.get("entry_point"), "abc");
    const none = new URL(hostedLauncherUrl(deep));
    assert.equal(none.searchParams.get("entry_point"), null);
    assert.equal(none.searchParams.get("open"), deep);
  });

  await test("hostedLauncherUrl returns null for an invalid deep link", () => {
    assert.equal(hostedLauncherUrl("https://github.com"), null);
    assert.equal(hostedLauncherUrl(null), null);
  });

  // ---- client.mjs re-export (views import from one site) -------------------
  await test("client.mjs re-exports the deep-link helpers", async () => {
    const client = await import("../kit/client.mjs");
    for (const name of [
      "APP_DEEP_LINK_SCHEME",
      "isRepoFullName",
      "safeDeepLinkUrl",
      "quoteUntrusted",
      "hostedLauncherUrl",
      "buildSessionDeepLink",
      "buildSessionDetailDeepLink",
      "buildChatsDeepLink",
      "buildNewAutomationDeepLink",
      "buildIssueDeepLink",
      "buildPullRequestDeepLink",
    ]) {
      assert.ok(name in client, `client.mjs must re-export ${name}`);
    }
    assert.equal(
      client.buildSessionDeepLink({ repo: "a/b" }),
      "ghapp://session/new?repo=a%2Fb",
    );
  });

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(`FAIL  ${e.message}`);
  process.exit(1);
});
