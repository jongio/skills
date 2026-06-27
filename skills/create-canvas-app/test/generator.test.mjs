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
    assert.match(fmt.compactNumber(1500), /1\.5\s?K/i);
    assert.match(fmt.compactNumber(2.3e9), /2\.3\s?B/i);
    assert.equal(fmt.compactNumber(null), "—");
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
    await sleep(80);
    assert.ok(n >= 2, `expected >=2 ticks, got ${n}`);
    stop();
    const after = n;
    await sleep(80);
    assert.equal(n, after, "no ticks should fire after cleanup");
  });

  await test("pollWhileVisible: a throwing/rejecting tick keeps the interval alive", async () => {
    let n = 0;
    const stop = pollWhileVisible(() => { n++; return Promise.reject(new Error("boom")); }, 0.03);
    await sleep(80);
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
  await test("client.mjs exports pollWhileVisible + re-exports format helpers", async () => {
    const src = await read(join(ROOT, "kit", "client.mjs"));
    assert.match(src, /export function pollWhileVisible/);
    assert.match(src, /document\.visibilityState/);
    assert.match(src, /nid, relativeTime, compactNumber, percent/);
    assert.match(src, /poll\b/); // mountCanvas accepts a poll option
  });

  await test("theme.css ships loading/error primitives + reduced-motion guard", async () => {
    const css = await read(join(ROOT, "kit", "theme.css"));
    for (const cls of ["ck-spinner", "ck-skeleton", "ck-callout", "ck-error"]) {
      assert.ok(css.includes(`.${cls}`), `missing .${cls}`);
    }
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
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

  // ---- generator: both templates -------------------------------------------
  const work = await mkdtemp(join(tmpdir(), "ck-gen-test-"));
  try {
    const cases = [
      { name: "gen-list", template: "list", dir: join(work, "gen-list") },
      { name: "gen-feed", template: "data", dir: join(work, "gen-feed") },
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
        assert.match(readme, c.template === "data" ? /external-data/i : /list\b/i);
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

    // data-template-specific contract: fetch-in-handler + refresh + poll helper
    await test("data canvas.mjs fetches in a handler with a timeout + refresh action", async () => {
      const canvas = await read(join(work, "gen-feed", "canvas.mjs"));
      assert.match(canvas, /await fetch\(/);
      assert.match(canvas, /AbortSignal\.timeout\(/);
      assert.match(canvas, /refresh:\s*\{/);
    });

    await test("data app.mjs uses the visibility-gated poll helper", async () => {
      const app = await read(join(work, "gen-feed", "web", "app.mjs"));
      assert.match(app, /pollWhileVisible/);
      assert.match(app, /useEffect/);
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
