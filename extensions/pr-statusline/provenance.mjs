export function normalizePrProvenance(value) {
	if (!value || typeof value.root !== "boolean" || typeof value.unknown !== "boolean" || !Array.isArray(value.agents)) {
		return { root: false, unknown: true, agents: [] };
	}
	return {
		root: value.root, unknown: value.unknown,
		agents: [...new Set(value.agents.filter((id) => typeof id === "string" && id))],
	};
}

export function mergePrProvenance(left, right) {
	const first = normalizePrProvenance(left);
	const second = normalizePrProvenance(right);
	return {
		root: first.root || second.root, unknown: first.unknown || second.unknown,
		agents: [...new Set([...first.agents, ...second.agents])],
	};
}

export function sourceProvenance(source) {
	return source ? {
		root: source.root === true, unknown: false,
		agents: source.agentId ? [source.agentId] : [],
	} : normalizePrProvenance(null);
}
