const entityStates = new Set(["OPEN", "CLOSED", "MERGED", "UNKNOWN"]);
const ciStates = new Set(["unknown", "pending", "running", "passed", "failed"]);
const oid = (value) => {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) throw new Error("A verified full PR head OID is required");
  return value.toLowerCase();
};
const text = (value, label, max = 500) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
  return value.trim();
};
export const unknownCi = (headRefOid = null) => ({
  status: "unknown", headRefOid, passed: null, total: null, pendingChecks: [], failedChecks: [], observedAt: null,
});
export const emptyReferences = () => ({
  prs: [], issues: [],
  source: { status: "unknown", known: { prs: false, issues: false }, updatedAt: null, error: null },
});

export function normalizeTarget(value, kind, previous = [], membershipOnly = false) {
  if (!value || value.owned !== true) throw new Error("Only explicitly session-owned references may be displayed");
  let url = value.url ? new URL(text(value.url, "reference URL", 2000)) : null;
  const path = url?.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/([1-9]\d*)\/?$/);
  const reference = value.reference || (path ? `${path[1]}/${path[2]}#${path[4]}` : "");
  const match = text(reference, "qualified reference", 300).match(/^([a-z0-9][a-z0-9_.-]*)\/([a-z0-9_.-]+)#([1-9]\d*)$/i);
  if (!match || [".", ".."].includes(match[2]) || !Number.isSafeInteger(Number(match[3]))) throw new Error("Use a qualified owner/repo#number reference");
  const normalized = `${match[1]}/${match[2]}#${match[3]}`.toLowerCase();
  const expectedPath = `/${match[1]}/${match[2]}/${kind === "prs" ? "pull" : "issues"}/${match[3]}`.toLowerCase();
  url ||= new URL(`https://github.com${expectedPath}`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname.replace(/\/$/, "").toLowerCase() !== expectedPath) throw new Error("Reference URL must match its HTTPS PR/issue identity");
  const canonicalUrl = `${url.origin}${expectedPath}`;
  const old = previous.find((entry) => entry.url === canonicalUrl);
  const headRefOid = kind === "prs"
    ? (!membershipOnly && value.headRefOid !== undefined ? oid(value.headRefOid) : old?.headRefOid || null)
    : undefined;
  const state = !membershipOnly && value.state !== undefined ? value.state : old?.state || "UNKNOWN";
  if (!entityStates.has(state) || (kind === "issues" && state === "MERGED")) throw new Error("Invalid reference state");
  return {
    reference: normalized, url: canonicalUrl, owned: true,
    title: !membershipOnly && value.title !== undefined ? text(value.title, "reference title") : old?.title || normalized,
    state,
    ...(kind === "prs" ? {
      headRefOid,
      ci: old?.headRefOid === headRefOid && old?.ci ? old.ci : unknownCi(headRefOid),
    } : {}),
  };
}

export function normalizeTargets(values, kind, previous, membershipOnly = false) {
  if (!Array.isArray(values)) throw new Error("Tracking snapshot must be an array");
  const seen = new Set();
  return values.map((value) => normalizeTarget(value, kind, previous, membershipOnly))
    .filter((entry) => !seen.has(entry.url) && seen.add(entry.url));
}

export function updateCi(references, input) {
  const identity = text(input.reference, "PR reference", 2000);
  const normalizedUrl = identity.startsWith("https:")
    ? normalizeTarget({ url: identity, owned: true }, "prs").url : null;
  const matches = references.prs.filter((entry) => normalizedUrl ? entry.url === normalizedUrl : entry.reference === identity.toLowerCase());
  if (matches.length !== 1) throw new Error("CI updates require one already tracked PR; use its full URL if ambiguous");
  if (references.source.known.prs !== true) throw new Error("PR ownership is not verified; sync session tracking before CI");
  const target = matches[0];
  const headRefOid = oid(input.headRefOid);
  if (target.headRefOid !== headRefOid) throw new Error("CI head does not match the tracked PR head; sync verified reference metadata first");
  if (!ciStates.has(input.status)) throw new Error("Invalid CI status");
  const passed = input.passed ?? null;
  const total = input.total ?? null;
  if ((passed === null) !== (total === null) ||
      (total !== null && (!Number.isSafeInteger(total) || !Number.isSafeInteger(passed) || passed < 0 || total < passed))) {
    throw new Error("CI counts must be non-negative paired integers");
  }
  const names = (values) => {
    if (values === undefined) return [];
    if (!Array.isArray(values)) throw new Error("Invalid CI check names");
    return [...new Set(values.map((value) => text(value, "CI check name", 300)))].sort();
  };
  const pendingChecks = names(input.pendingChecks);
  const failedChecks = names(input.failedChecks);
  if (input.status === "passed" && (!(total > 0) || passed !== total || pendingChecks.length || failedChecks.length)) {
    throw new Error("Passed CI requires a complete non-empty verified check inventory");
  }
  const observed = typeof input.observedAt === "string" && input.observedAt.includes("T") ? Date.parse(input.observedAt) : NaN;
  if (!Number.isFinite(observed)) throw new Error("A verified ISO observation timestamp is required");
  const next = { status: input.status, headRefOid, passed, total, pendingChecks, failedChecks, observedAt: new Date(observed).toISOString() };
  const old = target.ci;
  if (old?.observedAt && observed < Date.parse(old.observedAt)) throw new Error("Stale CI observation");
  if (old?.observedAt && observed === Date.parse(old.observedAt) && JSON.stringify(next) !== JSON.stringify(old)) throw new Error("Conflicting CI observation");
  target.ci = next;
  const fields = (ci) => [ci?.status, ci?.headRefOid, ci?.passed, ci?.total, ci?.pendingChecks, ci?.failedChecks];
  return { reference: target.reference, meaningful: JSON.stringify(fields(old)) !== JSON.stringify(fields(next)) };
}

export function trackingResult(input) {
  const match = String(input.toolName || "").match(/^session_(prs|issues|statusline)$/);
  if (!match || !["list", "add", "remove", "clear"].includes(input.toolArgs?.action)) return null;
  if (input.toolResult?.resultType && input.toolResult.resultType !== "success") return null;
  const kind = match[1];
  const raw = typeof input.toolResult === "string" ? input.toolResult : input.toolResult?.textResultForLlm;
  try {
    if (kind === "statusline") {
      if (input.toolArgs.action !== "clear") return null;
      if (!String(raw).startsWith("Cleared this session's PR, issue, subagent, and worktree entries.")) throw new Error("Clear completion was not verified");
      return { clearAll: true };
    }
    const values = JSON.parse(raw);
    if (!Array.isArray(values) || values.some((entry) => typeof entry?.owned !== "boolean")) throw new Error("Tracking result lacks explicit ownership");
    return { kind, values: values.filter((entry) => entry.owned === true) };
  } catch (error) {
    return { kind: kind === "statusline" ? null : kind, error: String(error.message).slice(0, 500) };
  }
}
