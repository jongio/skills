import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_DEEP_LINK_SCHEME,
  buildChatsDeepLink,
  buildIssueDeepLink,
  buildNewAutomationDeepLink,
  buildNewChatDeepLink,
  buildPullRequestDeepLink,
  buildSessionDeepLink,
  buildSessionDetailDeepLink,
  buildSessionRestartDeepLink,
  isRepoFullName,
  quoteUntrusted,
  safeDeepLinkUrl,
} from "../runtime/web/deeplinks.mjs";

test("deep-link validators enforce scheme allowlists, safe session IDs, and guillemet boundaries", () => {
  assert.equal(APP_DEEP_LINK_SCHEME, "ghapp");
  assert.equal(isRepoFullName("jongio/skills"), true);
  assert.equal(isRepoFullName("-bad/repo"), false);
  assert.equal(isRepoFullName("jongio/.."), false);
  assert.equal(isRepoFullName("jongio/skills/extra"), false);

  assert.equal(safeDeepLinkUrl("ghapp://sessions/abc-123"), "ghapp://sessions/abc-123");
  assert.equal(safeDeepLinkUrl("gh://chats"), "gh://chats");
  assert.equal(safeDeepLinkUrl("javascript:alert(1)"), null);
  assert.equal(safeDeepLinkUrl("https://evil.example/sessions/1"), null);
  assert.equal(safeDeepLinkUrl("ghapp://sessions/abc\u0000def"), null);

  assert.equal(quoteUntrusted("Fix «injected» title"), "«Fix injected title»");
});

test("session detail, restart, and creation deep links reject path smuggling and conflicting selectors", () => {
  assert.equal(buildSessionDetailDeepLink("sess_01-abc.def"), "ghapp://sessions/sess_01-abc.def");
  assert.equal(buildSessionRestartDeepLink("sess_01-abc.def"), "ghapp://sessions/sess_01-abc.def/restart");

  for (const invalid of ["", ".", "..", "a/b", "a?mode=autopilot", "a#hash", "a b"]) {
    assert.equal(buildSessionDetailDeepLink(invalid), null, `expected null for ${invalid}`);
    assert.equal(buildSessionRestartDeepLink(invalid), null, `expected null for ${invalid}`);
  }

  const created = buildSessionDeepLink({
    repo: "jongio/skills",
    branch: "main",
    parent: "parent-ws-1",
    mode: "autopilot",
    prompt: `Investigate ${quoteUntrusted("flaky test & retry=true")}`,
  });
  assert.ok(created?.startsWith("ghapp://session/new?"));
  const parsed = new URL(created);
  assert.equal(parsed.searchParams.get("repo"), "jongio/skills");
  assert.equal(parsed.searchParams.get("branch"), "main");
  assert.equal(parsed.searchParams.get("parent"), "parent-ws-1");
  assert.equal(parsed.searchParams.get("mode"), "autopilot");
  assert.match(parsed.searchParams.get("prompt"), /«flaky test & retry=true»/);

  // Conflicting selectors fail closed.
  assert.equal(buildSessionDeepLink({ repo: "jongio/skills", pr: 12, branch: "main" }), null);
  assert.equal(buildSessionDeepLink({ repo: "jongio/skills", pr: 12, parent: "ws-1" }), null);
  assert.equal(buildSessionDeepLink({ repo: "jongio/skills", mode: "sudo" }), null);
});

test("chat, automation, PR, and issue deep links validate parameters cleanly", () => {
  assert.equal(buildChatsDeepLink(), "ghapp://chats");
  assert.equal(buildNewChatDeepLink({ prompt: "   " }), null);
  assert.equal(
    buildNewChatDeepLink({ prompt: "Open fleet overview" }),
    "ghapp://chats/new?prompt=Open+fleet+overview",
  );
  assert.equal(
    buildNewAutomationDeepLink({ name: "Nightly check", trigger: "daily", time: "08:30" }),
    "ghapp://automations/new?name=Nightly+check&trigger=daily&time=08%3A30",
  );
  assert.equal(
    buildPullRequestDeepLink({ owner: "jongio", repo: "skills", number: 42 }),
    "ghapp://github.com/jongio/skills/pull/42",
  );
  assert.equal(
    buildIssueDeepLink({ owner: "jongio", repo: "skills", number: "7" }),
    "ghapp://github.com/jongio/skills/issues/7",
  );
  assert.equal(buildPullRequestDeepLink({ owner: "jongio", repo: "skills", number: 0 }), null);
});
