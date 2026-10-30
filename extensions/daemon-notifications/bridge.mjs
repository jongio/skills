import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { withStateLock } from "../state-lock.mjs";

const valid = (value) => /^[\w-]{1,64}$/.test(value || "");
const clean = (value) => String(value || "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 500);
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

function readObject(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!object(value)) throw new Error("Invalid notification state");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function writeObject(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}

export function createNotificationBridge(session, {
  home, interval = 5000, now = Date.now, provider = "standalone",
} = {}) {
  if (!/^[\w-]{1,128}$/.test(session.sessionId || "")) throw new Error("Invalid session identity");
  if (!["full", "standalone"].includes(provider)) throw new Error("Invalid notification provider");
  const directory = join(home, "daemon-notifications", session.sessionId);
  const stateFile = join(directory, "subscriptions.json");
  const authorityFile = join(directory, "providers.json");
  const id = randomUUID();
  const leaseMs = Math.max(15000, interval * 3);
  let busy = false;
  let stopped = false;
  const locked = (action) => withStateLock(authorityFile, () => {
    const authority = readObject(authorityFile);
    authority.providers ??= {};
    if (!object(authority.providers)) throw new Error("Invalid notification provider state");
    return action(authority);
  });
  const subscriptions = () => {
    const state = Object.assign(Object.create(null), readObject(stateFile));
    for (const key of Object.keys(state)) {
      if (!valid(key) || !object(state[key])) throw new Error("Invalid notification subscription");
      if (state[key].streams !== undefined && !object(state[key].streams) ||
          state[key].targets !== undefined && !object(state[key].targets) ||
          state[key].generation !== undefined && !valid(state[key].generation)) {
        throw new Error("Invalid notification replay state");
      }
      state[key].streams = Object.assign(Object.create(null), state[key].streams || {});
      state[key].targets = Object.assign(Object.create(null),
        Object.fromEntries(Object.entries(state[key].targets || {}).slice(-128)));
    }
    return state;
  };
  const preferred = (authority, time) => {
    const live = Object.entries(authority.providers).filter(([, value]) => {
      if (!object(value) || !["full", "standalone"].includes(value.provider) || !Number.isFinite(value.until)) {
        throw new Error("Invalid notification provider lease");
      }
      return value.until > time;
    });
    const full = live.filter(([, value]) => value.provider === "full");
    return (full.length ? full : live).map(([key]) => key).sort()[0];
  };
  const heartbeat = () => locked((authority) => {
    const time = now();
    preferred(authority, time);
    for (const [key, value] of Object.entries(authority.providers)) {
      if (value.until <= time) delete authority.providers[key];
    }
    authority.providers[id] = { provider, until: time + leaseMs };
    if (authority.delivery?.owner === id) authority.delivery.until = time + leaseMs;
    writeObject(authorityFile, authority);
    return preferred(authority, time) === id;
  });
  const fileFor = (name) => join(directory, `watcher-${name}.jsonl`);
  const advance = (subscription, event, target, delivered) => {
    if (delivered && event.type === "STATUS") {
      delete subscription.targets[target];
      subscription.targets[target] = { lastStatusAt: now(), lastPhase: event.phase };
      for (const key of Object.keys(subscription.targets).slice(0, -128)) delete subscription.targets[key];
    }
    subscription.stream = event.stream;
    subscription.sequence = event.sequence;
    subscription.streams[event.stream] = event.sequence;
    for (const key of Object.keys(subscription.streams).slice(0, -128)) delete subscription.streams[key];
  };
  const claim = (name, event, target) => locked((authority) => {
    const time = now();
    if (stopped || preferred(authority, time) !== id) return null;
    if (authority.delivery) {
      if (!Number.isFinite(authority.delivery.until)) throw new Error("Invalid notification delivery lease");
      if (authority.delivery.until > time) return null;
      delete authority.delivery;
    }
    const state = subscriptions();
    const subscription = state[name];
    if (!subscription) return { absent: true };
    if (event.sequence <= (subscription.streams[event.stream] || 0)) return { skip: true };
    subscription.generation ??= randomUUID();
    const previous = subscription.targets[target];
    if (event.type === "STATUS" && Number.isFinite(previous?.lastStatusAt) &&
        time - previous.lastStatusAt < 60000 && event.phase === previous.lastPhase) {
      advance(subscription, event, target, false);
      writeObject(stateFile, state);
      return { skip: true };
    }
    const token = randomUUID();
    writeObject(stateFile, state);
    authority.delivery = { owner: id, token, until: time + leaseMs };
    writeObject(authorityFile, authority);
    return { token, generation: subscription.generation };
  });
  const finish = (claim, name, event, target, delivered) => locked((authority) => {
    if (authority.delivery?.token !== claim.token) return;
    const state = subscriptions();
    if (delivered && state[name]?.generation === claim.generation) {
      advance(state[name], event, target, true);
      writeObject(stateFile, state);
    }
    delete authority.delivery;
    writeObject(authorityFile, authority);
  });
  async function poll() {
    if (stopped || !heartbeat() || busy) return;
    busy = true;
    try {
      const names = locked(() => Object.keys(subscriptions()));
      for (const name of names) {
        let text;
        try {
          if (statSync(fileFor(name)).size > 512 * 1024) continue;
          text = readFileSync(fileFor(name), "utf8");
        } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
        for (const line of lines) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (!object(event) || typeof event.stream !== "string" || event.stream.length > 64 ||
              !Number.isSafeInteger(event.sequence) || event.sequence <= 0 ||
              !/^[A-Z_]{2,64}$/.test(event.type || "")) continue;
          const target = JSON.stringify([event.source || name, event.repo, event.pr, event.runId,
            event.headRefOid || event.sha].map(clean));
          const delivery = claim(name, event, target);
          if (!delivery) return;
          if (delivery.absent) break;
          if (delivery.skip) continue;
          let delivered = false;
          try {
            await session.log(`[${clean(event.source || name)}] ${clean(event.repo)}${event.pr ? `#${clean(event.pr)}` : ""} ${clean(event.type)} ${clean(event.summary || event.phase)}`.trim());
            delivered = true;
          } finally { finish(delivery, name, event, target, delivered); }
        }
      }
    } finally {
      busy = false;
      if (stopped) clearInterval(timer);
    }
  }
  heartbeat();
  const tick = async () => {
    if (stopped) {
      if (busy) locked((authority) => {
        if (authority.delivery?.owner !== id) return;
        authority.delivery.until = now() + leaseMs;
        writeObject(authorityFile, authority);
      });
      return;
    }
    await poll();
  };
  const timer = setInterval(() => tick().catch((error) =>
    console.error(`[daemon-notifications] ${error.message}`)), interval);
  timer.unref();
  return {
    poll,
    manage(action, name) {
      if (stopped) throw new Error("Notification provider is stopped");
      return locked(() => {
        const state = subscriptions();
        if (action === "status") return Object.keys(state).map((watcher) => ({ watcher, file: fileFor(watcher) }));
        if (!valid(name)) throw new Error("Watcher must contain 1-64 letters, numbers, underscores or hyphens.");
        if (action === "subscribe") {
          state[name] ??= {};
          state[name].generation ??= randomUUID();
        } else if (action === "unsubscribe") delete state[name];
        else throw new Error("Expected subscribe, unsubscribe or status");
        writeObject(stateFile, state);
        return { watcher: name, enabled: action === "subscribe", file: fileFor(name) };
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (!busy) clearInterval(timer);
      locked((authority) => {
        delete authority.providers[id];
        writeObject(authorityFile, authority);
      });
    },
  };
}
