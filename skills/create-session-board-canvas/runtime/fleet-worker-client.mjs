import { Worker } from "node:worker_threads";

export function createFleetWorkerClient({
  copilotHome,
  maxSessions = 50,
  sqliteTimeoutMs = 50,
} = {}) {
  let worker = null;
  let nextId = 1;
  let inFlight = null;
  const pending = new Map();

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL("./fleet-worker.mjs", import.meta.url));
    worker.unref();
    worker.on("message", (msg) => {
      const entry = pending.get(msg?.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || "Fleet worker scan failed"));
    });
    worker.on("error", (error) => {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      worker = null;
    });
    worker.on("exit", () => {
      for (const entry of pending.values()) entry.reject(new Error("Fleet worker exited"));
      pending.clear();
      worker = null;
    });
    return worker;
  }

  function scan() {
    if (inFlight) return inFlight;
    inFlight = new Promise((resolve, reject) => {
      const id = nextId++;
      const instance = ensureWorker();
      pending.set(id, { resolve, reject });
      instance.postMessage({ id, copilotHome, maxSessions, sqliteTimeoutMs });
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function stop() {
    if (!worker) return;
    const current = worker;
    worker = null;
    for (const entry of pending.values()) entry.reject(new Error("Fleet worker stopped"));
    pending.clear();
    await current.terminate();
  }

  return {
    scan,
    stop,
    isRunning: () => worker !== null,
  };
}
