import { readState, SessionTracker, statePath, writeState } from "./tracker.mjs";
import { renameSync, rmSync } from "node:fs";

export async function collect(session, { home, interval = 2000, report = console.error } = {}) {
	let previous = null;
	try {
		previous = readState(session.sessionId, home);
	} catch (error) {
		report(`[pr-statusline] Resetting unreadable state cache: ${error.message}`);
		const path = statePath(session.sessionId, home);
		try {
			renameSync(path, `${path}.corrupt`);
		} catch {
			rmSync(path, { force: true });
		}
	}
	const tracker = new SessionTracker(session.sessionId, previous);
	const queued = [];
	let loading = true;
	let stopped = false;
	let polling = false;
	let lastSavedAt = previous?.updatedAt ?? 0;
	const save = (activity, { preferMemoryIgnore = false } = {}) => {
		try {
			const disk = readState(session.sessionId, home);
			if (disk) {
				if (Number.isInteger(disk.transcriptOffset) && disk.transcriptOffset > tracker.state.transcriptOffset) {
					tracker.state.transcriptOffset = disk.transcriptOffset;
				}
				if (Number.isFinite(disk.lastUserInputAt) && disk.lastUserInputAt > tracker.lastUserInputAt) {
					tracker.lastUserInputAt = disk.lastUserInputAt;
				}
				if (Array.isArray(disk.simulate)) {
					tracker.state.simulate = [...disk.simulate];
				}
				if (!preferMemoryIgnore && disk.updatedAt > lastSavedAt) {
					const diskPrUrls = new Set(disk.prs.map((pr) => pr.url));
					tracker.state.ignored = tracker.state.ignored.filter((url) => !diskPrUrls.has(url));
				}
				for (const ignoredUrl of disk.ignored) {
					if (!tracker.state.ignored.includes(ignoredUrl)) tracker.state.ignored.push(ignoredUrl);
				}
				tracker.state.prs = tracker.state.prs.filter((pr) => !tracker.state.ignored.includes(pr.url));
				for (const diskPr of disk.prs) {
					const existing = tracker.state.prs.find((pr) => pr.url === diskPr.url);
					if (existing) {
						if (diskPr.title) existing.title = diskPr.title;
						if (diskPr.status) existing.status = diskPr.status;
						if (Number.isFinite(diskPr.checkedAt)) existing.checkedAt = diskPr.checkedAt;
						if (Number.isFinite(diskPr.mergedAt)) existing.mergedAt = diskPr.mergedAt;
						if (diskPr.simulated) existing.simulated = true;
					} else if (!tracker.state.ignored.includes(diskPr.url)) {
						tracker.state.prs.push(diskPr);
					}
				}
			}
		} catch {
			// Ignore transient disk read errors before saving.
		}
		const snap = tracker.snapshot(activity);
		lastSavedAt = snap.updatedAt;
		writeState(snap, home);
	};
	const unsubscribe = session.on((event) => {
		if (loading) queued.push(event);
		else {
			try {
				tracker.observe(event);
				save();
			} catch (error) {
				report(`[pr-statusline] ${error.message}`);
			}
		}
	});
	try {
		for (const event of await session.getEvents()) tracker.observe(event, true);
		loading = false;
		for (const event of queued) tracker.observe(event);
		save();
	} catch (error) {
		unsubscribe();
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
		manage(action, reference) {
			const prs = tracker.manage(action, reference);
			save(null, { preferMemoryIgnore: true });
			return prs;
		},
		stop() {
			stopped = true;
			clearInterval(timer);
			unsubscribe();
		},
	};
}

