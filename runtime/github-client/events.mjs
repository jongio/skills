import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export function createEventWriter(file, source, context = {}) {
  if (!file) return () => {};
  const target = resolve(file);
  const stream = randomUUID();
  let sequence = 0;
  let disabled = false;
  const clean = (value) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 400);
  return (payload) => {
    if (disabled) return;
    try {
      const records = [];
      for (const event of [
        ...(payload.events || []),
        ...(payload.statuses || (payload.status ? [payload.status] : [])).map((status) => ({ ...status, type: "STATUS" })),
      ]) {
        const record = { stream, sequence: ++sequence, source: clean(source),
          ...(context.repo ? { repo: clean(context.repo) } : {}),
          ...(context.pr ? { pr: clean(context.pr) } : {}),
          timestamp: new Date().toISOString() };
        for (const key of ["type", "repo", "pr", "runId", "jobId", "headRefOid", "sha", "phase", "summary"]) {
          if (event[key] !== undefined) record[key] = clean(event[key]);
        }
        records.push(JSON.stringify(record));
      }
      if (!records.length) return;
      mkdirSync(dirname(target), { recursive: true });
      let previous = "";
      try {
        if (statSync(target).size > 512 * 1024) throw new Error("Refusing oversized event file");
        previous = readFileSync(target, "utf8");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const complete = previous.slice(0, previous.lastIndexOf("\n") + 1);
      if (previous && !complete) throw new Error("Refusing to overwrite non-event data");
      for (const line of complete.split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        if (typeof event.stream !== "string" || !Number.isSafeInteger(event.sequence) || !event.type) {
          throw new Error("Refusing to overwrite non-event data");
        }
      }
      previous = previous.slice(0, previous.lastIndexOf("\n") + 1);
      const lines = (previous + records.join("\n") + "\n").split("\n").filter(Boolean).slice(-128);
      const text = lines.join("\n") + "\n";
      const temporary = `${target}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, text, { mode: 0o600 });
        renameSync(temporary, target);
      } finally {
        rmSync(temporary, { force: true });
      }
    } catch (error) {
      disabled = true;
      console.error(`[daemon-notifications] Event output disabled: ${error.message}`);
    }
  };
}
