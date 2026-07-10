// canvas-kit/deeplinks.mjs
//
// Deep links INTO the Copilot desktop app (github-app), for canvases that need
// to open a session, jump to a surface, or otherwise integrate with the app they
// run inside. Pure JS (no Node, no DOM) so it imports from BOTH the browser view
// (web/app.mjs, via /kit/client.mjs) and the SDK-free server (canvas.mjs).
//
// Grounded in the app's public deep-link contract (github-app
// src/lib/deeplinks/{registry.ts,README.md}, ADR 0016) and its canvas webview
// link handling (src-tauri/src/extension_canvas_webview.rs):
//   * The official scheme is `ghapp://` (the app also accepts `github-app://`
//     and `gh://` as compatibility fallbacks).
//   * A canvas renders these as ordinary anchors with `target="_blank"`: the
//     webview intercepts the trusted click and routes an accepted-scheme URL
//     into the app's (confirmation-gated) deeplink pipeline. So a canvas needs
//     only to BUILD a correct URL (no OS launcher, no IPC, no SDK).
//   * Every builder validates its inputs to match the app's OWN parsing and
//     encodes params via URLSearchParams, so attacker-influenced text (a
//     decision title, a fetched value) can neither inject an extra query key
//     nor change the target route. Free-form prompt text additionally goes
//     through `quoteUntrusted` so it reads as data to the agent.

/** Official documented app scheme. Rendered links should use this one. */
export const APP_DEEP_LINK_SCHEME = "ghapp";

// The app also routes these compatibility schemes; `safeDeepLinkUrl` accepts them
// so a link copied from elsewhere still validates, but the builders emit ghapp://.
const ACCEPTED_SCHEMES = new Set(["ghapp:", "github-app:", "gh:"]);

const SESSION_MODES = new Set(["plan", "interactive", "autopilot"]);
const AUTOMATION_TRIGGERS = new Set(["manual", "hourly", "daily", "weekly"]);

// Mirror github-app's repository validation (src/lib/helpers/repositoryValidation.ts)
// so any link this kit builds passes the app's own parsing:
//   owner: <=39 chars, alphanumeric with internal hyphens (no leading/trailing hyphen)
//   repo:  <=100 chars, [A-Za-z0-9._-], not "." or ".."
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;
// A conservative safe token (ids). Prevents extra path segments or query keys.
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

function isOwner(v) {
  return typeof v === "string" && v.length > 0 && v.length <= 39 && OWNER_RE.test(v);
}

function isRepoName(v) {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= 100 &&
    v !== "." &&
    v !== ".." &&
    REPO_RE.test(v)
  );
}

// A safe session/workspace id: 1-256 chars of [A-Za-z0-9._-], excluding the dot
// segments "." and ".." (which WHATWG URL parsing would otherwise collapse into an
// id-less path). Shared by the `sessions/:sessionId` route and `session/new`'s
// `parent` param, which the app documents as taking that same id shape.
function isSafeSessionId(v) {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= 256 &&
    v !== "." &&
    v !== ".." &&
    SAFE_ID_RE.test(v)
  );
}

/**
 * True when `value` is a valid `owner/repo` full name, matching github-app's own
 * validation. Exposed so a canvas can check a repo before offering a link (and so
 * the demo's `set_repo` action validates the same way the app will).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRepoFullName(value) {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  return parts.length === 2 && isOwner(parts[0]) && isRepoName(parts[1]);
}

// A positive integer, or null. Accepts a number or a digit string; mirrors
// github-app's parsePositiveInteger (finite, integer, > 0).
function toPositiveInt(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Weekly day 0-6 (0 = Sunday), or null.
function toDay(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
}

// Free-text param (prompt). URLSearchParams percent-encodes the value, so it is
// URL-safe regardless; we only strip NUL + C0 control chars (KEEPING tab/newline,
// so a multi-line prompt survives) and cap length. Untrusted CONTENT should be
// wrapped by the caller with `quoteUntrusted` before it reaches here.
function cleanText(v, max = 4096) {
  if (v == null) return "";
  return String(v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, max)
    .trim();
}

// Structured single-line param (branch, automation name). Strips ALL control
// chars and caps length. Returns "" when nothing usable remains.
function cleanLine(v, max = 512) {
  if (v == null) return "";
  return String(v).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max).trim();
}

/**
 * Validate + normalize an app deep link. Returns the normalized URL string, or
 * null for anything that isn't an accepted-scheme (`ghapp:`/`github-app:`/`gh:`)
 * URL. Control chars and over-long input are rejected as defense-in-depth even
 * though the builders here never introduce them. Every builder funnels through
 * this, so a bad link surfaces as null rather than a broken href.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function safeDeepLinkUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!ACCEPTED_SCHEMES.has(u.protocol)) return null;
  return u.href;
}

/**
 * Wrap attacker-influenced free text in guillemets so it reads as DATA, not an
 * instruction, when embedded in a prompt handed to the agent. Existing guillemets
 * are stripped first so a hostile value can't forge the boundary. This is the same
 * helper the backlog launcher uses, keeping the untrusted-text boundary defined
 * one way across surfaces.
 * @param {unknown} value
 * @returns {string}
 */
export function quoteUntrusted(value) {
  return `\u00ab${String(value ?? "").replace(/[\u00ab\u00bb]/g, "")}\u00bb`;
}

/**
 * Build a `ghapp://session/new` deep link: the primary way a canvas opens a
 * session in the app. `repo` is required and validated as owner/repo. The three
 * branch selectors are mutually exclusive — at most one of `pr` (a positive
 * integer), `branch` (base ref for a freshly generated worktree branch), or
 * `sourceBranch` (open an EXISTING branch directly, e.g. a collaboration link).
 * `parent` nests the new session under an existing workspace id (same id shape as
 * buildSessionDetailDeepLink); it cannot combine with `pr` or `sourceBranch`, but
 * may combine with `branch`. `mode` must be one of plan|interactive|autopilot. All
 * values are URL-encoded via URLSearchParams, so untrusted text cannot inject a
 * query key. Returns null when the inputs can't form a valid link, so a caller can
 * withhold the control instead of rendering a dead one. Do NOT put secrets or
 * sensitive content in `prompt`.
 * @param {object} parts
 * @param {string} parts.repo            required "owner/repo"
 * @param {string} [parts.prompt]        kickoff prompt (wrap untrusted parts with quoteUntrusted)
 * @param {number|string} [parts.pr]     positive PR number (excludes branch / sourceBranch)
 * @param {string} [parts.branch]        base branch for a NEW worktree branch (excludes pr / sourceBranch)
 * @param {string} [parts.sourceBranch]  open an EXISTING branch directly (excludes pr / branch)
 * @param {string} [parts.parent]        workspace id to nest under (excludes pr / sourceBranch; may combine with branch)
 * @param {string} [parts.mode]          plan | interactive | autopilot
 * @returns {string|null}
 */
export function buildSessionDeepLink({ repo, prompt, pr, branch, sourceBranch, parent, mode } = {}) {
  if (!isRepoFullName(repo)) return null;

  const prNum = toPositiveInt(pr);
  if (pr != null && pr !== "" && prNum == null) return null; // pr given but invalid
  const branchStr = cleanLine(branch);
  const sourceBranchStr = cleanLine(sourceBranch);
  // The three branch selectors are mutually exclusive: at most one may be set.
  const selectors = (prNum != null ? 1 : 0) + (branchStr ? 1 : 0) + (sourceBranchStr ? 1 : 0);
  if (selectors > 1) return null;

  // `parent` nests the new session under an existing workspace id. Reject a
  // given-but-malformed id (fail closed), and enforce the contract: `parent`
  // cannot combine with `pr` or `source_branch` (it may combine with `branch`).
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

/**
 * `ghapp://sessions/:sessionId`: open an existing session/workspace by id.
 * Returns null for an id that isn't a safe token (so it can't smuggle extra path
 * segments or query keys), including the dot segments `.` and `..` which WHATWG
 * URL parsing would otherwise collapse into an id-less `ghapp://sessions/` link.
 * @param {string} sessionId
 * @returns {string|null}
 */
export function buildSessionDetailDeepLink(sessionId) {
  if (!isSafeSessionId(sessionId)) return null;
  return safeDeepLinkUrl(`${APP_DEEP_LINK_SCHEME}://sessions/${sessionId}`);
}

/** `ghapp://chats`: open the Chats surface. */
export function buildChatsDeepLink() {
  return safeDeepLinkUrl(`${APP_DEEP_LINK_SCHEME}://chats`);
}

/**
 * `ghapp://automations/new`: open the new-automation dialog with fields
 * pre-filled. The dialog is the confirmation step; this never auto-creates a
 * workflow. `trigger` is allowlisted, `time` must be HH:mm, `day` must be 0-6;
 * unknown values are dropped rather than failing the whole link.
 * @param {object} [parts]
 * @param {string} [parts.name]
 * @param {string} [parts.prompt]        wrap untrusted parts with quoteUntrusted
 * @param {string} [parts.trigger]       manual | hourly | daily | weekly
 * @param {string} [parts.time]          HH:mm (daily/weekly)
 * @param {number|string} [parts.day]    0-6, 0 = Sunday (weekly)
 * @returns {string|null}
 */
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
  const qs = params.toString();
  return safeDeepLinkUrl(`${APP_DEEP_LINK_SCHEME}://automations/new${qs ? `?${qs}` : ""}`);
}

/**
 * `ghapp://github.com/:owner/:repo/issues/:number`: open an issue (in Inbox when
 * the repo is already added as a project). Returns null for invalid parts.
 * @param {object} parts
 * @param {string} parts.owner
 * @param {string} parts.repo
 * @param {number|string} parts.number
 * @returns {string|null}
 */
export function buildIssueDeepLink({ owner, repo, number } = {}) {
  return buildGithubItemDeepLink("issues", owner, repo, number);
}

/**
 * `ghapp://github.com/:owner/:repo/pull/:number`: open a pull request.
 * @param {object} parts
 * @param {string} parts.owner
 * @param {string} parts.repo
 * @param {number|string} parts.number
 * @returns {string|null}
 */
export function buildPullRequestDeepLink({ owner, repo, number } = {}) {
  return buildGithubItemDeepLink("pull", owner, repo, number);
}

function buildGithubItemDeepLink(kind, owner, repo, number) {
  const num = toPositiveInt(number);
  if (!isOwner(owner) || !isRepoName(repo) || num == null) return null;
  return safeDeepLinkUrl(`${APP_DEEP_LINK_SCHEME}://github.com/${owner}/${repo}/${kind}/${num}`);
}

/**
 * Wrap an app deep link in the hosted dotcom launcher, the recommended form for a
 * WEB surface (it handles retry, fallback, and an app-missing install prompt). A
 * canvas running inside the app can link the raw `ghapp://` directly; use this
 * when the link may be opened from a browser instead. Returns null if `deepLink`
 * isn't a valid accepted-scheme URL. `entryPoint` is optional, non-sensitive
 * attribution only (sanitized to [A-Za-z0-9_]).
 * @param {string} deepLink
 * @param {object} [opts]
 * @param {string} [opts.entryPoint]
 * @returns {string|null}
 */
export function hostedLauncherUrl(deepLink, { entryPoint } = {}) {
  const safe = safeDeepLinkUrl(deepLink);
  if (!safe) return null;
  const params = new URLSearchParams();
  const ep = typeof entryPoint === "string" ? entryPoint.replace(/[^A-Za-z0-9_]/g, "") : "";
  if (ep) params.set("entry_point", ep);
  params.set("open", safe);
  return `https://github.com/copilot/app/launch?${params.toString()}`;
}
