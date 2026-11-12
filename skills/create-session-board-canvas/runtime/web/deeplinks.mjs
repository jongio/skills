// Safe deep-link builders for Copilot desktop host navigation and confirmation-gated actions.
// Pure ES module (no Node or DOM imports) shared by both the canvas browser UI and server tests.

export const APP_DEEP_LINK_SCHEME = "ghapp";

const ACCEPTED_SCHEMES = new Set(["ghapp:", "gh:"]);
const SESSION_MODES = new Set(["plan", "interactive", "autopilot"]);
const AUTOMATION_TRIGGERS = new Set(["manual", "hourly", "daily", "weekly"]);

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

function isOwner(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 39 && OWNER_RE.test(value);
}

function isRepoName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100 &&
    value !== "." &&
    value !== ".." &&
    REPO_RE.test(value)
  );
}

export function isSafeSessionId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value !== "." &&
    value !== ".." &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype" &&
    SAFE_ID_RE.test(value)
  );
}

export function isRepoFullName(value) {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  return parts.length === 2 && isOwner(parts[0]) && isRepoName(parts[1]);
}

function toPositiveInt(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toDay(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 6 ? parsed : null;
}

function cleanText(value, max = 4096) {
  if (value == null) return "";
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, max)
    .trim();
}

function cleanLine(value, max = 512) {
  if (value == null) return "";
  return String(value).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max).trim();
}

export function safeDeepLinkUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!ACCEPTED_SCHEMES.has(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function quoteUntrusted(value) {
  return `\u00ab${String(value ?? "").replace(/[\u00ab\u00bb]/g, "")}\u00bb`;
}

export function buildSessionDeepLink({ repo, prompt, pr, branch, sourceBranch, parent, mode } = {}) {
  if (!isRepoFullName(repo)) return null;

  const prNum = toPositiveInt(pr);
  if (pr != null && pr !== "" && prNum == null) return null;
  const branchStr = cleanLine(branch);
  const sourceBranchStr = cleanLine(sourceBranch);
  const selectors = (prNum != null ? 1 : 0) + (branchStr ? 1 : 0) + (sourceBranchStr ? 1 : 0);
  if (selectors > 1) return null;

  let parentId = null;
  if (parent != null && parent !== "") {
    if (!isSafeSessionId(parent)) return null;
    if (prNum != null || sourceBranchStr) return null;
    parentId = parent;
  }

  if (mode != null && mode !== "" && !SESSION_MODES.has(mode)) return null;

  const params = new URLSearchParams();
  params.set("repo", repo);
  if (prNum != null) params.set("pr", String(prNum));
  else if (branchStr) params.set("branch", branchStr);
  else if (sourceBranchStr) params.set("source_branch", sourceBranchStr);
  if (parentId) params.set("parent", parentId);
  const promptStr = cleanText(prompt);
  if (promptStr) params.set("prompt", promptStr);
  if (mode && SESSION_MODES.has(mode)) params.set("mode", mode);

  return safeDeepLinkUrl(`${APP_DEEP_LINK_SCHEME}://session/new?${params.toString()}`);
}

export function buildSessionDetailDeepLink(sessionId) {
  if (!isSafeSessionId(sessionId)) return null;
  return safeDeepLinkUrl(`${APP_DEEP_LINK_SCHEME}://sessions/${sessionId}`);
}

export function buildSessionRestartDeepLink(sessionId) {
  if (!isSafeSessionId(sessionId)) return null;
  return safeDeepLinkUrl(`${APP_DEEP_LINK_SCHEME}://sessions/${sessionId}/restart`);
}

export function buildChatsDeepLink() {
  return safeDeepLinkUrl(`${APP_DEEP_LINK_SCHEME}://chats`);
}

export function buildNewChatDeepLink({ prompt } = {}) {
  const promptStr = cleanText(prompt);
  if (!promptStr) return null;
  const params = new URLSearchParams();
  params.set("prompt", promptStr);
  return safeDeepLinkUrl(`${APP_DEEP_LINK_SCHEME}://chats/new?${params.toString()}`);
}

export function buildNewAutomationDeepLink({ name, prompt, trigger, time, day } = {}) {
  const params = new URLSearchParams();
  const nameStr = cleanLine(name, 200);
  if (nameStr) params.set("name", nameStr);
  const promptStr = cleanText(prompt);
  if (promptStr) params.set("prompt", promptStr);
  if (typeof trigger === "string" && AUTOMATION_TRIGGERS.has(trigger)) params.set("trigger", trigger);
  if (typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) params.set("time", time);
  const dayNum = toDay(day);
  if (dayNum != null) params.set("day", String(dayNum));
  const query = params.toString();
  return safeDeepLinkUrl(`${APP_DEEP_LINK_SCHEME}://automations/new${query ? `?${query}` : ""}`);
}

function buildGithubItemDeepLink(kind, owner, repo, number) {
  const num = toPositiveInt(number);
  if (!isOwner(owner) || !isRepoName(repo) || num == null) return null;
  return safeDeepLinkUrl(`${APP_DEEP_LINK_SCHEME}://github.com/${owner}/${repo}/${kind}/${num}`);
}

export function buildIssueDeepLink({ owner, repo, number } = {}) {
  return buildGithubItemDeepLink("issues", owner, repo, number);
}

export function buildPullRequestDeepLink({ owner, repo, number } = {}) {
  return buildGithubItemDeepLink("pull", owner, repo, number);
}
