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

  function cleanupWorker(instance, message) {
    for (const [reqId, entry] of pending.entries()) {
      if (entry.instance === instance) {
        pending.delete(reqId);
        entry.reject(message instanceof Error ? message : new Error(String(message)));
      }
    }
    if (worker === instance) {
      worker = null;
    }
  }

  function ensureWorker() {
    if (worker) return worker;
    const instance = new Worker(new URL("./fleet-worker.mjs", import.meta.url));
    instance.unref();
    instance.on("message", (msg) => {
      const entry = pending.get(msg?.id);
      if (!entry || entry.instance !== instance) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || "Fleet worker scan failed"));
    });
    instance.on("error", (error) => {
      cleanupWorker(instance, error);
    });
    instance.on("exit", () => {
      cleanupWorker(instance, "Fleet worker exited");
    });
    worker = instance;
    return instance;
  }

  function scan() {
    if (inFlight) return inFlight;
    inFlight = new Promise((resolve, reject) => {
      const id = nextId++;
      const instance = ensureWorker();
      pending.set(id, { resolve, reject, instance });
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
    cleanupWorker(current, "Fleet worker stopped");
    await current.terminate();
  }

  return {
    scan,
    stop,
    isRunning: () => worker !== null,
  };
}
