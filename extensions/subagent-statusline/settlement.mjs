export function observeSettlement(agent, now) {
	const merged = agent.prs?.length > 0 && agent.prs.every((url) => agent.mergedPrs?.includes(url));
	const terminal = !agent.prs?.length && ["completed", "failed", "cancelled"].includes(agent.status);
	if ((!merged && !terminal) || Number.isFinite(agent.settlementObservedAt)) return false;
	agent.settlementObservedAt = now;
	return true;
}

export function dismissSettledAgents(tracker, messageTime) {
	if (tracker.simulated) return;
	for (const agent of tracker.agents.values()) {
		observeSettlement(agent, messageTime);
		if (Number.isFinite(agent.settlementObservedAt) && messageTime > agent.settlementObservedAt) {
			agent.settlementDismissed = true;
		}
	}
	tracker.dismissed = tracker.counts().total === 0;
}
