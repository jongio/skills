import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkPerformance } from "../scripts/check-performance.mjs";

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "site-performance-"));
  try {
    writeFileSync(join(root, "thumbnail.webp"), Buffer.alloc(1024));
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("measures nested production assets and accepts optimized thumbnail HTML", () => fixture((root) => {
  mkdirSync(join(root, "_astro"));
  writeFileSync(join(root, "_astro", "client.js"), "console.log('small');");
  writeFileSync(join(root, "_astro", "style.css"), "body{margin:0}");
  writeFileSync(join(root, "index.html"), '<img src="/skills/_astro/thumbnail.webp" srcset="thumbnail.webp 512w">');
  const metrics = checkPerformance(root);
  assert.ok(metrics.jsGzipBytes > 0);
  assert.ok(metrics.cssGzipBytes > 0);
  assert.equal(metrics.webpCount, 1);
  assert.equal(metrics.webpBytes, 1024);
}));

test("rejects raw PNG thumbnails in served HTML", () => fixture((root) => {
  writeFileSync(join(root, "index.html"), '<img class="skill-thumb" src="/skills/images/thumb-example.png">');
  assert.throws(() => checkPerformance(root), /thumbnail must use an optimized derivative/);
}));

test("enforces the exact image size boundary", () => fixture((root) => {
  writeFileSync(join(root, "thumbnail.webp"), Buffer.alloc(200 * 1024));
  checkPerformance(root);
  writeFileSync(join(root, "thumbnail.webp"), Buffer.alloc(200 * 1024 + 1));
  assert.throws(() => checkPerformance(root), /image exceeds 200 KiB/);
}));

test("rejects an oversized JavaScript chunk", () => fixture((root) => {
  writeFileSync(join(root, "client.js"), randomBytes(110 * 1024));
  assert.throws(() => checkPerformance(root), /JS chunk exceeds 100 KiB gzip/);
}));

test("enforces aggregate JavaScript and CSS budgets", () => fixture((root) => {
  for (let i = 0; i < 4; i++) writeFileSync(join(root, `chunk-${i}.js`), randomBytes(90 * 1024));
  assert.throws(() => checkPerformance(root), /Total JS exceeds 300 KiB gzip/);
  for (let i = 0; i < 4; i++) rmSync(join(root, `chunk-${i}.js`));
  writeFileSync(join(root, "style.css"), randomBytes(60 * 1024));
  assert.throws(() => checkPerformance(root), /Total CSS exceeds 50 KiB gzip/);
}));

test("fails rather than reporting success when optimized output is missing", () => fixture((root) => {
  rmSync(join(root, "thumbnail.webp"));
  assert.throws(() => checkPerformance(root), /No optimized thumbnail images found/);
}));
