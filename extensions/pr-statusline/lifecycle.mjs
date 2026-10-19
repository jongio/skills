import { mergePrProvenance } from "./provenance.mjs";

const revision = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
export const isMergedPr = (pr) => Number.isFinite(pr.mergedAt) || /(?:\uE727|\uF419|🟣|\bMerged\b)/i.test(pr.status ?? "");

export function normalizePrMergeState(state) {
	if (state.mergeStateVersion === 1) return state;
	return {
		...state,
		mergeStateVersion: 1,
		prs: state.prs.map((pr) => {
			if (pr.simulated || !isMergedPr(pr)) return pr;
			const recovered = { ...pr };
			// Older collectors inferred merges from tool success, including queued/running commands.
			delete recovered.mergedAt;
			delete recovered.mergedObservedAt;
			delete recovered.status;
			delete recovered.checkedAt;
			return recovered;
		}),
	};
}

export function observeMergedPr(pr, observedAt, mergedAt = observedAt) {
	let changed = false;
	if (!Number.isFinite(pr.mergedObservedAt)) {
		pr.mergedObservedAt = observedAt;
		changed = true;
	}
	if (!Number.isFinite(pr.mergedAt)) {
		pr.mergedAt = Number.isFinite(mergedAt) ? mergedAt : observedAt;
		changed = true;
	}
	return changed;
}

export function initializeMergedPrs(tracker, now) {
	let changed = false;
	for (const pr of tracker.state.prs) {
		if (!pr.simulated && isMergedPr(pr) &&
			observeMergedPr(pr, Math.max(now, tracker.lastUserInputAt), pr.mergedAt)) changed = true;
	}
	return changed;
}

export function dismissMergedPrs(tracker) {
	let changed = false;
	for (const pr of [...tracker.state.prs]) {
		if (!pr.simulated && isMergedPr(pr) && Number.isFinite(pr.mergedObservedAt) &&
			(tracker.lastUserInputAt > pr.mergedObservedAt ||
				tracker.lastUserInputAt > pr.mergedAt)) {
			tracker.manage("remove", pr.url);
			changed = true;
		}
	}
	return changed;
}

export function reconcilePrStates(tracker, disk) {
	if ((disk.clearedAt ?? 0) > (tracker.state.clearedAt ?? 0)) {
		Object.assign(tracker.state, disk);
		tracker.repository = disk.repository ?? null;
		tracker.host = disk.host ?? "github.com";
		tracker.lastUserInputAt = Number.isFinite(disk.lastUserInputAt) ? disk.lastUserInputAt : 0;
		tracker.userRepos = new Set(Array.isArray(disk.userRepos) ? disk.userRepos : []);
		tracker.calls = new Map(Object.entries(disk.calls ?? {}));
		tracker.pending = new Map(Object.entries(disk.pending ?? {}));
		tracker.background = new Set(disk.background ?? []);
		return;
	}
	if ((disk.clearedAt ?? 0) < (tracker.state.clearedAt ?? 0)) return;
	disk = normalizePrMergeState(disk);
	const ignored = { ...tracker.state.ignoredRevisions };
	for (const state of [tracker.state, disk]) {
		for (const [url, value] of Object.entries(state.ignoredRevisions ?? {})) {
			ignored[url] = Math.max(ignored[url] ?? -1, revision(value));
		}
		for (const url of state.ignored) ignored[url] = Math.max(ignored[url] ?? -1, 0);
	}
	const prs = new Map();
	for (const pr of [...tracker.state.prs, ...disk.prs]) {
		if (revision(pr.generation) <= (ignored[pr.url] ?? -1)) continue;
		const existing = prs.get(pr.url);
		if (!existing || revision(pr.generation) > revision(existing.generation)) {
			prs.set(pr.url, pr);
		} else if (revision(pr.generation) === revision(existing.generation)) {
			const newer = (pr.checkedAt ?? 0) > (existing.checkedAt ?? 0) ? pr : existing;
			const older = newer === pr ? existing : pr;
			const merged = { ...older, ...newer, provenance: mergePrProvenance(existing.provenance, pr.provenance) };
			if (newer.status && !isMergedPr(newer)) {
				delete merged.mergedAt;
				delete merged.mergedObservedAt;
			} else if (isMergedPr(merged)) {
				const observations = [existing.mergedObservedAt, pr.mergedObservedAt].filter(Number.isFinite);
				if (observations.length) merged.mergedObservedAt = Math.min(...observations);
				merged.status = "\uE727 Merged";
			}
			prs.set(pr.url, merged);
		}
	}
	tracker.state.prs = [...prs.values()];
	tracker.state.ignoredRevisions = ignored;
	tracker.state.ignored = Object.keys(ignored).filter((url) => !prs.has(url));
	tracker.lastUserInputAt = Math.max(tracker.lastUserInputAt, disk.lastUserInputAt ?? 0);
}
