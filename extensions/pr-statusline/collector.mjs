import { pullRequest, readState, RELEVANT_EVENT_TYPE, SessionTracker, statePath, writeState } from "./tracker.mjs";
import { renameSync, rmSync, statSync } from "node:fs";
import { dismissMergedPrs, initializeMergedPrs, reconcilePrStates } from "./lifecycle.mjs";

function serializeComparable(snap) {
	const { updatedAt: _ignored, ...rest } = snap;
	return JSON.stringify(rest);
}

export async function collect(session, { home, interval = 15000, report = console.error, attention = null } = {}) {
	const file = statePath(session.sessionId, home);
	let previous = null;
	let lastDiskMtimeMs = 0;
	try {
		previous = readState(session.sessionId, home);
		if (previous) {
			try {
				lastDiskMtimeMs = statSync(file).mtimeMs;
			} catch {
				lastDiskMtimeMs = 0;
			}
		}
	} catch (error) {
		report(`[pr-statusline] Resetting unreadable state cache: ${error.message}`);
		try {
			renameSync(file, `${file}.corrupt`);
		} catch {
			rmSync(file, { force: true });
		}
	}
	const tracker = new SessionTracker(session.sessionId, previous?.activeTrackingVersion === 2 ? previous : previous && {
		...previous, prs: previous.prs.filter((pr) => pr.owned === true || pr.simulated), calls: {}, transcriptOffset: 0,
	});
	initializeMergedPrs(tracker, Date.now());
	const queued = [];
	let loading = true;
	let stopped = false;
	let polling = false;
	let lastComparable = previous ? serializeComparable(tracker.snapshot()) : null;
	const reload = () => {
		const disk = readState(session.sessionId, home);
		if (disk) reconcilePrStates(tracker, disk);
	};
	const save = (activity, { force = false } = {}) => {
		let diskComparable = null;
		try {
			let currentMtimeMs = 0;
			try {
				currentMtimeMs = statSync(file).mtimeMs;
			} catch {
				currentMtimeMs = 0;
			}
			const disk = currentMtimeMs >= lastDiskMtimeMs && currentMtimeMs > 0 ? readState(session.sessionId, home) : null;
			if (disk) {
				diskComparable = serializeComparable(disk);
				lastDiskMtimeMs = currentMtimeMs;
				if (Number.isInteger(disk.transcriptOffset) && disk.transcriptOffset > tracker.state.transcriptOffset) {
					tracker.state.transcriptOffset = disk.transcriptOffset;
				}
				if (Array.isArray(disk.simulate)) {
					tracker.state.simulate = [...disk.simulate];
				}
				reconcilePrStates(tracker, disk);
			}
		} catch {
			// Ignore transient disk read errors before saving.
		}
		initializeMergedPrs(tracker, Date.now());
		dismissMergedPrs(tracker);
		const snap = tracker.snapshot(activity);
		const comparable = serializeComparable(snap);
		if (!force && comparable === lastComparable && (diskComparable === null || diskComparable === comparable)) return;
		lastComparable = comparable;
		writeState(snap, home);
		try {
			lastDiskMtimeMs = statSync(file).mtimeMs;
		} catch {
			// Ignore stat failure after write.
		}
	};
	const unsubscribe = session.on((event) => {
		if (!RELEVANT_EVENT_TYPE.test(String(event?.type ?? ""))) return;
		if (loading) queued.push(event);
		else {
			try {
				reload();
				tracker.observe(event);
				attention?.observe(event);
				save();
			} catch (error) {
				report(`[pr-statusline] ${error.message}`);
			}
		}
	});
	try {
		const events = await session.getEvents();
		reload();
		for (const event of events) {
			if (RELEVANT_EVENT_TYPE.test(String(event?.type ?? ""))) {
				tracker.observe(event, true);
			}
		}
		loading = false;
		for (const event of queued) {
			tracker.observe(event);
			attention?.observe(event);
		}
		save(null, { force: true });
	} catch (error) {
		unsubscribe();
		attention?.stop();
		throw error;
	}
	async function poll() {
		if (polling || stopped) return;
		polling = true;
		try {
			const activity = await session.rpc.metadata.activity();
			if (!stopped) save(activity);
		} catch (error) {
			report(`[pr-statusline] Could not read session activity: ${error.message}`);
		} finally {
			polling = false;
		}
	}
	await poll();
	const timer = setInterval(poll, interval);
	timer.unref();
	return {
		tracker,
		manage(action, reference, toolCallId = null) {
			reload();
			const call = toolCallId ? tracker.calls.get(toolCallId) : null;
			const source = toolCallId && action === "add"
				? (call?.reference === pullRequest(reference).url ? call.source : null)
				: { root: true };
			const prs = tracker.manage(action, reference, source);
			save(null, { force: true });
			return prs;
		},
		reload,
		stop() {
			stopped = true;
			clearInterval(timer);
			unsubscribe();
			attention?.stop();
		},
	};
}
