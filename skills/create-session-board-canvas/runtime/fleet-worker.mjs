import { parentPort } from "node:worker_threads";
import { createLocalFleetCache, readLocalFleetSnapshot } from "./fleet-local-reader.mjs";

const cache = createLocalFleetCache();

if (parentPort) {
  parentPort.on("message", (msg) => {
    if (!msg || typeof msg.id !== "number") return;
    try {
      const result = readLocalFleetSnapshot({
        copilotHome: msg.copilotHome,
        maxSessions: msg.maxSessions,
        sqliteTimeoutMs: msg.sqliteTimeoutMs,
        cache,
      });
      parentPort.postMessage({ id: msg.id, ok: true, result });
    } catch (error) {
      parentPort.postMessage({
        id: msg.id,
        ok: false,
        error: String(error?.message || error).slice(0, 400),
      });
    }
  });
}
