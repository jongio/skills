import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export function checkPerformance(directory) {
  const metrics = { jsGzipBytes: 0, cssGzipBytes: 0, webpBytes: 0, webpCount: 0 };
  function inspect(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        inspect(path);
        continue;
      }
      if (!/\.(?:js|css|webp|html)$/.test(entry.name)) continue;
      const bytes = readFileSync(path);
      if (entry.name.endsWith(".js")) {
        const size = gzipSync(bytes).length;
        assert.ok(size <= 100 * 1024, `${path}: JS chunk exceeds 100 KiB gzip`);
        metrics.jsGzipBytes += size;
      } else if (entry.name.endsWith(".css")) {
        metrics.cssGzipBytes += gzipSync(bytes).length;
      } else if (entry.name.endsWith(".webp")) {
        assert.ok(bytes.length <= 200 * 1024, `${path}: image exceeds 200 KiB`);
        metrics.webpBytes += bytes.length;
        metrics.webpCount++;
      } else {
        assert.doesNotMatch(bytes.toString("utf8"), /<img\b[^>]*\bsrc="[^"]*\/thumb-[^"]*\.png"/,
          `${path}: thumbnail must use an optimized derivative`);
      }
    }
  }
  inspect(directory);
  assert.ok(metrics.jsGzipBytes <= 300 * 1024, "Total JS exceeds 300 KiB gzip");
  assert.ok(metrics.cssGzipBytes <= 50 * 1024, "Total CSS exceeds 50 KiB gzip");
  assert.ok(metrics.webpCount > 0, "No optimized thumbnail images found; build the site first");
  return metrics;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
  console.log(JSON.stringify(checkPerformance(directory), null, 2));
}
