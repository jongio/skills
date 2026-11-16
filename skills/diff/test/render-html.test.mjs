import assert from "node:assert/strict";
import test from "node:test";
import {
  CDN_ASSETS,
  renderDiffHtml,
  serializeJsonForScript,
} from "../scripts/render-html.mjs";

test("serializeJsonForScript neutralizes script-tag breakout, HTML comments, and line separators", () => {
  const payload = {
    title: "</script><script>alert('xss')</script><!--",
    sep: "a\u2028b\u2029c & d",
  };
  const encoded = serializeJsonForScript(payload);
  assert.doesNotMatch(encoded, /<\/script/i);
  assert.doesNotMatch(encoded, /<!--/);
  assert.doesNotMatch(encoded, /[\u2028\u2029]/);
  assert.deepEqual(JSON.parse(encoded), payload);
});

test("renderDiffHtml enforces nonce CSP, pinned SHA-384 SRI hashes, and zero innerHTML sinks", () => {
  const maliciousDiff = [
    "diff --git a/__proto__/pollute.js b/__proto__/pollute.js",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/__proto__/pollute.js",
    "@@ -0,0 +1,2 @@",
    "+const trap = '</script><img src=x onerror=alert(1)>';",
    "+export default trap;",
  ].join("\n");

  const { html, headerCsp, nonce } = renderDiffHtml({
    diff: maliciousDiff,
    title: "PR <img src=x onerror=alert(1)>",
    additions: "abc; color:red",
    deletions: 0,
    fileCount: 1,
    serveMode: true,
    csrfToken: "a".repeat(64),
  });

  assert.match(nonce, /^[A-Za-z0-9+/=_-]{16,}$/);
  const escapedNonce = nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(headerCsp, new RegExp(`script-src 'nonce-${escapedNonce}';`));
  assert.doesNotMatch(headerCsp, /script-src[^;]*cdn\.jsdelivr\.net/);
  assert.match(html, new RegExp(`script-src &#39;nonce-${escapedNonce}&#39;;`));
  assert.doesNotMatch(html, /unsafe-inline.*script-src|script-src[^;]*unsafe-inline/);
  assert.doesNotMatch(html, /unsafe-eval/);

  // Every CDN link/script carries verified sha384 integrity + crossorigin="anonymous"
  for (const asset of Object.values(CDN_ASSETS)) {
    assert.ok(html.includes(asset.url), `missing pinned URL ${asset.url}`);
    assert.ok(html.includes(asset.integrity), `missing SRI ${asset.integrity}`);
  }
  assert.equal((html.match(/crossorigin="anonymous"/g) || []).length, 5);

  // Escaped title & coerced integer stats
  assert.doesNotMatch(html, /<title>Diff: PR <img/);
  assert.match(html, /\+0<\/span>/);

  // Malicious </script> inside diff must never appear raw in HTML output
  const scriptCloseCount = (html.match(/<\/script>/gi) || []).length;
  assert.equal(scriptCloseCount, 4); // 3 external CDN scripts + 1 inline nonce script

  // Client script uses Map() for file tree, scrubs /s/<token> via history.replaceState, and never touches innerHTML
  assert.doesNotMatch(html, /\.innerHTML\b/);
  assert.match(html, /window\.history\.replaceState\(null,\s*"",\s*"\/"\)/);
  assert.match(html, /Submit Review/);
});

test("renderDiffHtml omits Submit Review button in static snapshot mode", () => {
  const { html } = renderDiffHtml({
    diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
    title: "static snapshot",
    additions: 1,
    deletions: 1,
    fileCount: 1,
    serveMode: false,
  });
  assert.doesNotMatch(html, /id="btn-done"/);
});
