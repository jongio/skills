// Match structured identities only. Rendered terminal strings are opaque.
export function repositoryKey(value) {
	if (typeof value !== "string") return null;
	const scp = /^(?:[^/@:]+@)?([^/:]+):([^/].*)$/.exec(value);
	const source = !value.includes("://") && scp ? `ssh://${scp[1]}/${scp[2]}` : value;
	try {
		const url = new URL(source);
		if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
		const path = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
		if (!/^\/[\w.-]+\/[\w.-]+$/.test(path)) return null;
		return `${url.hostname}${url.port ? `:${url.port}` : ""}${path}`.toLowerCase();
	} catch {
		return null;
	}
}

const unique = (keys) => {
	const values = new Set(keys);
	return values.size === 1 ? [...values][0] : null;
};

export function composeGroups(blocks, options = {}) {
	const separator = options.color === false ? " · " : " ";
	const checkoutBlock = blocks.find((block) => block.name === "worktree-statusline");
	const checkouts = checkoutBlock.entries.filter((entry) => entry.kind === "checkout");
	const rows = new Map(checkouts.filter((entry) => entry.text).map((entry) => [entry.key, [entry.text]]));
	const session = [];
	const prs = blocks.find((block) => block.name === "pr-statusline")?.entries ?? [];
	const agentBlock = blocks.find((block) => block.name === "subagent-statusline");
	const agentPaths = checkouts[0]?.agentCheckouts ?? {};
	const prKeys = new Map(prs.map((pr) => {
		const repository = repositoryKey(pr.headRepositoryUrl);
		const matches = repository && pr.headRefName ? checkouts.filter((checkout) =>
			checkout.branch === pr.headRefName &&
			checkout.remoteUrls.some((url) => repositoryKey(url) === repository)) : [];
		let key = unique(matches.map((checkout) => checkout.key));
		if (matches.length > 1 && pr.provenance?.root === false && pr.provenance?.unknown === false) {
			const agentIds = pr.provenance.agents ?? [];
			const agentKey = unique(agentIds.flatMap((id) => agentPaths[id]?.length ? agentPaths[id] : [null]));
			if (matches.some((checkout) => checkout.key === agentKey)) key = agentKey;
		}
		return [pr.url, key];
	}));
	const linkedKey = (urls) => unique(urls.map((url) => prKeys.get(url) ?? null));
	const append = (key, text) => {
		if (!text?.trim()) return;
		(rows.get(key) ?? session).push(text);
	};
	for (const block of blocks) {
		if (block === checkoutBlock) {
			for (const entry of block.entries) if (entry.kind !== "checkout") append(null, entry.text);
			continue;
		}
		if (block === agentBlock && typeof block.renderGroup === "function") {
			append(null, block.renderGroup(block.entries, options));
			continue;
		}
		for (const entry of block.entries) {
			let key = null;
			if (block.name === "pr-statusline") key = prKeys.get(entry.url);
			if (block.name === "issue-statusline") {
				const related = prs.filter((pr) => pr.issueUrls?.includes(entry.url)).map((pr) => pr.url);
				key = linkedKey([...new Set([...(entry.prUrls ?? []), ...related])]);
			}
			if (!entry.compact) append(key, entry.text);
		}
	}
	const output = [...rows.values()].map((parts) => parts.join(separator));
	if (session.length) output.push(session.join(separator));
	return output.join("\n");
}
