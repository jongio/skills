// test/generator.test.mjs — exercises the generator, the stamped smoke tests,
// the new kit API surface (format helpers, the poll helper), and the theme
// primitives. No deps; Node 18+.  Run: node test/generator.test.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GEN = join(ROOT, "scripts", "new-canvas.mjs");
const FRESH = join(ROOT, "scripts", "check-kit-freshness.mjs");

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

function run(args, cwd) {
  return spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
}
async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}
const read = (p) => readFile(p, "utf8");

async function main() {
  console.log("create-canvas-app generator + kit API tests");

  // ---- format.mjs behavior (the reinvented utilities, now shared) ----------
  const fmt = await import("../kit/format.mjs");

  await test("nid() returns distinct base-36 ids", () => {
    const a = fmt.nid();
    const b = fmt.nid();
    assert.equal(typeof a, "string");
    assert.ok(a.length >= 6);
    assert.notEqual(a, b);
  });

  await test("relativeTime buckets with an explicit now", () => {
    const base = 1_700_000_000_000;
    assert.equal(fmt.relativeTime(base - 5_000, { now: base }), "just now");
    assert.equal(fmt.relativeTime(base - 5 * 60_000, { now: base }), "5m ago");
    assert.equal(fmt.relativeTime(base - 3 * 3_600_000, { now: base }), "3h ago");
    assert.equal(fmt.relativeTime(base - 2 * 86_400_000, { now: base }), "2d ago");
    assert.equal(fmt.relativeTime(null), "");
    assert.equal(fmt.relativeTime(undefined, { fallback: "—" }), "—");
  });

  await test("compactNumber + percent format as expected", () => {
    // compactNumber delegates to Intl compact notation, which is locale-aware,
    // so assert it produces what the host locale would (not a hardcoded en-US
    // "K"/"B" that fails under e.g. de-DE "Tsd.") — and that it actually compacts.
    const compact = (n) =>
      Number(n).toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 2 });
    assert.equal(fmt.compactNumber(1500), compact(1500));
    assert.equal(fmt.compactNumber(2.3e9), compact(2.3e9));
    assert.notEqual(fmt.compactNumber(1500), "1500"); // proves it compacted
    assert.equal(fmt.compactNumber(null), "—");
    // percent() uses Number.toFixed -> always ASCII "." + digits, locale-independent.
    assert.equal(fmt.percent(1.2345), "+1.23%");
    assert.equal(fmt.percent(-2), "-2.00%");
    assert.equal(fmt.percent(null), "—");
  });

  // ---- pollWhileVisible behavior (the auto-refresh primitive) --------------
  const { pollWhileVisible } = await import("../kit/client.mjs");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await test("pollWhileVisible: seconds<=0 is a no-op", () => {
    let n = 0;
    const stop = pollWhileVisible(() => n++, 0);
    assert.equal(typeof stop, "function");
    assert.equal(n, 0);
    stop();
  });

  await test("pollWhileVisible: immediate fires one tick synchronously", () => {
    let n = 0;
    const stop = pollWhileVisible(() => n++, 100, { immediate: true });
    assert.equal(n, 1);
    stop();
  });

  await test("pollWhileVisible: ticks on the interval and the cleanup stops it", async () => {
    let n = 0;
    const stop = pollWhileVisible(() => n++, 0.03); // 30ms
    await sleep(150);
    assert.ok(n >= 2, `expected >=2 ticks, got ${n}`);
    stop();
    const after = n;
    await sleep(80);
    assert.equal(n, after, "no ticks should fire after cleanup");
  });

  await test("pollWhileVisible: a throwing/rejecting tick keeps the interval alive", async () => {
    let n = 0;
    const stop = pollWhileVisible(() => { n++; return Promise.reject(new Error("boom")); }, 0.03);
    await sleep(150);
    assert.ok(n >= 2, `interval should survive rejections, got ${n}`);
    stop();
  });

  await test("pollWhileVisible: does not overlap a slow async tick", async () => {
    let started = 0;
    const stop = pollWhileVisible(() => { started++; return sleep(200); }, 0.03); // 30ms interval, 200ms work
    await sleep(120); // ~4 intervals would fire, but the first tick is still in flight
    assert.equal(started, 1, `slow tick must not stack, got ${started}`);
    stop();
    await sleep(220); // let the in-flight tick settle
  });

  // ---- kit API surface -----------------------------------------------------
  await test("client.mjs exports pollWhileVisible + connectCanvas + re-exports format helpers", async () => {
    const client = await import("../kit/client.mjs");
    assert.equal(typeof client.pollWhileVisible, "function");
    assert.equal(typeof client.mountCanvas, "function");
    assert.equal(typeof client.connectCanvas, "function", "the DOM-free transport is exported");
    const src = await read(join(ROOT, "kit", "client.mjs"));
    assert.match(src, /export function pollWhileVisible/);
    assert.match(src, /document\.visibilityState/);
    assert.match(src, /nid, relativeTime, compactNumber, percent/);
    assert.match(src, /poll\b/); // mountCanvas accepts a poll option
  });

  await test("client.mjs re-exports the deep-link builders (one import site for views)", async () => {
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
      assert.equal(typeof client[name], name === "APP_DEEP_LINK_SCHEME" ? "string" : "function", `client.mjs must re-export ${name}`);
    }
    // A built link is validated + encoded (untrusted "/" in repo is escaped).
    assert.equal(client.buildSessionDeepLink({ repo: "a/b" }), "ghapp://session/new?repo=a%2Fb");
    assert.equal(client.buildSessionDeepLink({ repo: "bad" }), null);
  });

  // ---- host-model capability (ai / askAgent) -------------------------------
  await test("server.mjs stays SDK-free and exposes setHost", async () => {
    const src = await read(join(ROOT, "kit", "server.mjs"));
    assert.ok(!/@github\/copilot-sdk/.test(src), "server.mjs must not import the SDK");
    assert.match(src, /function setHost/);
  });

  await test("runtime guards ai()/askAgent() until a host is wired, then forwards", async () => {
    const { createCanvasRuntime } = await import("../kit/server.mjs");
    const rt = createCanvasRuntime({
      id: "t",
      displayName: "T",
      description: "t",
      assetsDir: ROOT,
      actions: {
        sum: { handler: async ({ ai }) => ({ answer: await ai("q") }) },
        act: { handler: async ({ askAgent }) => ({ r: await askAgent("p") }) },
      },
    });
    assert.equal(typeof rt.setHost, "function");

    // No host wired -> documented error codes (handlers reach the host model
    // only when the canvas runs under the Copilot app, not in a plain test).
    await assert.rejects(() => rt.invoke("sum", {}, {}), (e) => e.code === "ai_unavailable");
    await assert.rejects(() => rt.invoke("act", {}, {}), (e) => e.code === "agent_unavailable");

    // Wired -> the handler api forwards to the host stub.
    const calls = [];
    rt.setHost({
      ai: async (qn) => { calls.push(["ai", qn]); return "ANSWER:" + qn; },
      askAgent: async (pr) => { calls.push(["askAgent", pr]); return "SENT:" + pr; },
    });
    assert.equal((await rt.invoke("sum", {}, {})).answer, "ANSWER:q");
    assert.equal((await rt.invoke("act", {}, {})).r, "SENT:p");
    assert.deepEqual(calls, [["ai", "q"], ["askAgent", "p"]]);
  });

  await test("theme.css ships loading/error primitives + reduced-motion guard", async () => {
    const css = await read(join(ROOT, "kit", "theme.css"));
    for (const cls of ["ck-spinner", "ck-skeleton", "ck-callout", "ck-error"]) {
      assert.ok(css.includes(`.${cls}`), `missing .${cls}`);
    }
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  });

  await test("theme.css sets font-smoothing to match the host canvas defaults", async () => {
    const css = await read(join(ROOT, "kit", "theme.css"));
    assert.match(css, /-webkit-font-smoothing:\s*antialiased/);
    assert.match(css, /-moz-osx-font-smoothing:\s*grayscale/);
  });

  await test("theme.css badges are generic, not decision-log-specific", async () => {
    const css = await read(join(ROOT, "kit", "theme.css"));
    for (const cls of ["ck-badge-success", "ck-badge-accent", "ck-badge-muted", "ck-badge-danger", "ck-badge-attention"]) {
      assert.ok(css.includes(`.${cls}`), `missing .${cls}`);
    }
    for (const leaked of ["ck-badge-open", "ck-badge-decided", "ck-badge-parked"]) {
      assert.ok(!css.includes(`.${leaked}`), `leaked app-specific class .${leaked}`);
    }
  });

  await test("format.mjs is byte-mirrored into the reference canvas-kit", async () => {
    const [a, b] = await Promise.all([
      readFile(join(ROOT, "kit", "format.mjs")),
      readFile(join(ROOT, "reference", "decision-log", "canvas-kit", "format.mjs")),
    ]);
    assert.ok(a.equals(b), "kit/format.mjs and reference copy differ");
  });

  await test("deeplinks.mjs is byte-mirrored into the reference canvas-kit", async () => {
    const [a, b] = await Promise.all([
      readFile(join(ROOT, "kit", "deeplinks.mjs")),
      readFile(join(ROOT, "reference", "decision-log", "canvas-kit", "deeplinks.mjs")),
    ]);
    assert.ok(a.equals(b), "kit/deeplinks.mjs and reference copy differ (run scripts/sync-kit.mjs)");
  });

  // ---- generator: all templates --------------------------------------------
  const work = await mkdtemp(join(tmpdir(), "ck-gen-test-"));
  try {
    const cases = [
      { name: "gen-list", template: "list", dir: join(work, "gen-list") },
      { name: "gen-feed", template: "data", dir: join(work, "gen-feed") },
      { name: "gen-ai", template: "ai", dir: join(work, "gen-ai") },
    ];

    for (const c of cases) {
      const args = [GEN, c.name, "--dir", c.dir, "--title", "Gen Test"];
      if (c.template !== "list") args.push("--template", c.template);
      const gen = run(args, work);

      await test(`generator stamps the ${c.template} template`, () => {
        assert.equal(gen.status, 0, gen.stderr || gen.stdout);
      });

      await test(`${c.template}: expected files exist (incl. stamped smoke test)`, async () => {
        for (const f of ["canvas.mjs", "extension.mjs", "copilot-extension.json", "README.md", "web/app.mjs", "web/index.html", "test/smoke.test.mjs"]) {
          assert.ok(await exists(join(c.dir, f)), `missing ${f}`);
        }
      });

      await test(`${c.template}: stamped README documents the canvas`, async () => {
        const readme = await read(join(c.dir, "README.md"));
        assert.match(readme, /^# Gen Test/m);
        assert.match(readme, /canvas-kit\//);
        assert.match(readme, /node test\/smoke\.test\.mjs/);
        // template-specific note is injected
        const noteRe = { list: /list\b/i, data: /external-data/i, ai: /host-AI/i }[c.template];
        assert.match(readme, noteRe);
      });

      await test(`${c.template}: generated canvas passes check-kit-freshness`, () => {
        const out = run([FRESH, c.dir], work);
        assert.equal(out.status, 0, out.stderr || out.stdout);
      });

      await test(`${c.template}: stamped canvas.mjs imports nid from the kit`, async () => {
        const canvas = await read(join(c.dir, "canvas.mjs"));
        assert.match(canvas, /import \{ nid \} from "\.\/canvas-kit\/format\.mjs"/);
        assert.ok(!/function nid\(\)/.test(canvas), "should not redefine nid locally");
      });

      await test(`${c.template}: node --check passes on stamped sources`, async () => {
        for (const f of ["canvas.mjs", "extension.mjs", "web/app.mjs", "test/smoke.test.mjs"]) {
          const chk = run(["--check", join(c.dir, f)], c.dir);
          assert.equal(chk.status, 0, `${f}: ${chk.stderr}`);
        }
      });

      await test(`${c.template}: stamped smoke test boots the runtime and passes`, async () => {
        const smoke = run(["test/smoke.test.mjs"], c.dir);
        assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
        assert.match(smoke.stdout, /checks passed/);
      });
    }

    // data-template-specific contract: fetch-in-handler via the kit's guarded
    // safeFetch + refresh + poll helper
    await test("data canvas.mjs fetches via the kit's safeFetch (guarded + timeout) + refresh action", async () => {
      const canvas = await read(join(work, "gen-feed", "canvas.mjs"));
      assert.match(canvas, /from "\.\/canvas-kit\/net\.mjs"/);
      assert.match(canvas, /await safeFetch\(/);
      assert.match(canvas, /refresh:\s*\{/);
    });

    await test("kit net.mjs guards the server-side fetch against SSRF (vendored into the canvas)", async () => {
      const net = await read(join(work, "gen-feed", "canvas-kit", "net.mjs"));
      assert.match(net, /a === 169 && b === 254/); // link-local / cloud metadata blocked
      assert.match(net, /Blocked private\/loopback address/);
      assert.match(net, /AbortSignal\.timeout\(/); // safeFetch applies a hard timeout
    });

    await test("data app.mjs uses the visibility-gated poll helper", async () => {
      const app = await read(join(work, "gen-feed", "web", "app.mjs"));
      assert.match(app, /pollWhileVisible/);
      assert.match(app, /useEffect/);
    });

    // ai-template-specific contract: calls the host model from a handler, hands
    // off to the main agent, and captures model errors into shared state.
    await test("ai canvas.mjs calls ctx.ai and ctx.askAgent from handlers", async () => {
      const canvas = await read(join(work, "gen-ai", "canvas.mjs"));
      assert.match(canvas, /handler: async \(\{ set, input, ai \}\)/);
      assert.match(canvas, /await ai\(/);
      assert.match(canvas, /handler: async \(\{ set, input, askAgent \}\)/);
      assert.match(canvas, /await askAgent\(/);
      // model errors are captured into state, not thrown past the action
      assert.match(canvas, /set\(\(current\) => \(\{ \.\.\.current, error \}\)\)/);
    });

    await test("ai smoke test exercises both the offline path and a wired host", async () => {
      const smoke = await read(join(work, "gen-ai", "test", "smoke.test.mjs"));
      assert.match(smoke, /no host wired captures a friendly error/);
      assert.match(smoke, /runtime\.setHost\(/);
      assert.match(smoke, /hand_to_agent forwards the prompt to the main agent/);
    });

    await test("generated extension.mjs wires the host-model capabilities", async () => {
      const ext = await read(join(work, "gen-list", "extension.mjs"));
      assert.match(ext, /const session = await joinSession\(/);
      assert.match(ext, /runtime\.setHost\(/);
      assert.match(ext, /ephemeralQuery/);
      assert.match(ext, /askAgent/);
    });

    await test("data smoke test exercises relativeTime against lastRefresh", async () => {
      const smoke = await read(join(work, "gen-feed", "test", "smoke.test.mjs"));
      assert.match(smoke, /relativeTime/);
      assert.match(smoke, /canvas-kit\/format\.mjs/);
    });

    // Regression: a title with quotes / backtick / ${...} must still stamp a
    // VALID, working canvas (escaping, not broken source).
    await test("hostile --title still stamps a valid, runnable canvas", async () => {
      const nastyTitle = 'Danger " ' + "`" + " " + "${x}" + " <b>tag</b>";
      const dir = join(work, "gen-nasty");
      const gen = run([GEN, "gen-nasty", "--dir", dir, "--title", nastyTitle], work);
      assert.equal(gen.status, 0, gen.stderr || gen.stdout);
      for (const f of ["canvas.mjs", "web/app.mjs"]) {
        const chk = run(["--check", join(dir, f)], dir);
        assert.equal(chk.status, 0, `${f} should parse: ${chk.stderr}`);
      }
      const smoke = run(["test/smoke.test.mjs"], dir);
      assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
