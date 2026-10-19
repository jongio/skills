import { mkdirSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

const wait = new Int32Array(new SharedArrayBuffer(4));

export function withStateLock(file, action, { timeoutMs = 5000 } = {}) {
	mkdirSync(dirname(file), { recursive: true });
	const lock = `${file}.lock`;
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			break;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			if (performance.now() >= deadline) {
				throw new Error(`Timed out waiting for statusline state lock: ${lock}`);
			}
			Atomics.wait(wait, 0, 0, 10);
		}
	}
	try {
		return action();
	} finally {
		rmdirSync(lock);
	}
}
