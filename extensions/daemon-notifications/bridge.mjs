import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const valid = (value) => /^[\w-]{1,64}$/.test(value || "");
const clean = (value) => String(value || "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 500);

export function createNotificationBridge(session, { home, interval = 5000, now = Date.now } = {}) {
  if (!/^[\w-]{1,128}$/.test(session.sessionId || "")) throw new Error("Invalid session identity");
  const directory = join(home, "daemon-notifications", session.sessionId);
  const stateFile = join(directory, "subscriptions.json");
  let subscriptions = {};
  try { subscriptions = JSON.parse(readFileSync(stateFile, "utf8")); } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  if (!subscriptions || typeof subscriptions !== "object" || Array.isArray(subscriptions)) subscriptions = {};
  subscriptions = Object.assign(Object.create(null), subscriptions);
  for (const key of Object.keys(subscriptions)) {
    if (!valid(key) || !subscriptions[key] || typeof subscriptions[key] !== "object") delete subscriptions[key];
    else {
      subscriptions[key].streams = Object.assign(Object.create(null), subscriptions[key].streams || {});
      subscriptions[key].targets = Object.assign(Object.create(null),
        Object.fromEntries(Object.entries(subscriptions[key].targets || {}).slice(-128)));
    }
  }
  let timer;
  let busy = false;
  let stopped = false;
  const save = () => {
    mkdirSync(directory, { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(subscriptions), { mode: 0o600 });
      renameSync(tmp, stateFile);
    } finally { rmSync(tmp, { force: true }); }
  };
  const fileFor = (name) => join(directory, `watcher-${name}.jsonl`);
  async function poll() {
    if (busy || stopped) return;
    busy = true;
    try {
      for (const [name, subscription] of Object.entries(subscriptions)) {
        let text;
        try {
          if (statSync(fileFor(name)).size > 512 * 1024) continue;
          text = readFileSync(fileFor(name), "utf8");
        } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
        for (const line of lines) {
          if (stopped || !subscriptions[name]) break;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (!event || typeof event !== "object" || Array.isArray(event)) continue;
          if (typeof event.stream !== "string" || event.stream.length > 64 ||
              !Number.isSafeInteger(event.sequence) || event.sequence <= 0 ||
              !/^[A-Z_]{2,64}$/.test(event.type || "")) continue;
          subscription.streams ??= Object.create(null);
          if (event.sequence <= (subscription.streams[event.stream] || 0)) continue;
          subscription.targets ??= Object.create(null);
          const target = JSON.stringify([event.source || name, event.repo, event.pr, event.runId,
            event.headRefOid || event.sha].map(clean));
          const previous = subscription.targets[target];
          if (event.type !== "STATUS" || !Number.isFinite(previous?.lastStatusAt) ||
              now() - previous.lastStatusAt >= 60000 || event.phase !== previous.lastPhase) {
            await session.log(`[${clean(event.source || name)}] ${clean(event.repo)}${event.pr ? `#${clean(event.pr)}` : ""} ${clean(event.type)} ${clean(event.summary || event.phase)}`.trim());
            if (event.type === "STATUS") {
              delete subscription.targets[target];
              subscription.targets[target] = { lastStatusAt: now(), lastPhase: event.phase };
              for (const key of Object.keys(subscription.targets).slice(0, -128)) delete subscription.targets[key];
            }
          }
          subscription.stream = event.stream;
          subscription.sequence = event.sequence;
          subscription.streams[event.stream] = event.sequence;
          for (const key of Object.keys(subscription.streams).slice(0, -128)) delete subscription.streams[key];
          save();
        }
      }
    } finally { busy = false; }
  }
  const arm = () => {
    if (!timer && Object.keys(subscriptions).length) {
      timer = setInterval(() => poll().catch((error) => console.error(`[daemon-notifications] ${error.message}`)), interval);
      timer.unref();
    }
  };
  arm();
  return {
    poll,
    manage(action, name) {
      if (action === "status") return Object.keys(subscriptions).map((watcher) => ({ watcher, file: fileFor(watcher) }));
      if (!valid(name)) throw new Error("Watcher must contain 1-64 letters, numbers, underscores or hyphens.");
      if (action === "subscribe") subscriptions[name] ??= {};
      else if (action === "unsubscribe") delete subscriptions[name];
      else throw new Error("Expected subscribe, unsubscribe or status");
      save();
      arm();
      if (!Object.keys(subscriptions).length && timer) { clearInterval(timer); timer = undefined; }
      return { watcher: name, enabled: action === "subscribe", file: fileFor(name) };
    },
    stop() { stopped = true; clearInterval(timer); timer = undefined; },
  };
}
