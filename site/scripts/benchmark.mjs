import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverThumbnailMappings } from "./sync-thumbnails.mjs";
import { checkPerformance } from "./check-performance.mjs";

const timings = [];
discoverThumbnailMappings();
for (let i = 0; i < 25; i++) {
  const start = performance.now();
  discoverThumbnailMappings();
  timings.push(performance.now() - start);
}
timings.sort((a, b) => a - b);
console.log(JSON.stringify({
  catalogDiscovery: { samples: timings.length, p50Ms: timings[12], p95Ms: timings[23] },
  assets: checkPerformance(resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist")),
}, null, 2));
