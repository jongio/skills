// canvas-kit/format.mjs
//
// Tiny, dependency-free formatting + id helpers shared by canvas views and
// handlers. Pure JS (no Node, no DOM) so it is safe to import from BOTH the
// browser view (web/app.mjs, via /kit/client.mjs) and the SDK-free server
// (canvas.mjs). These exist because every real data canvas was reinventing the
// same number/percent/relative-time formatters and copy-pasting `nid` verbatim.

/**
 * Short, collision-resistant id. Verbatim the generator every shipped canvas
 * used: a base-36 timestamp plus 4 random base-36 chars.
 * @returns {string}
 */
export function nid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Accept an epoch-ms number, a Date, or an ISO/parseable date string.
function toMillis(when) {
  if (when == null) return null;
  if (typeof when === "number") return Number.isFinite(when) ? when : null;
  if (when instanceof Date) return when.getTime();
  const ms = Date.parse(String(when));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Human "time ago" string: "just now", "5m ago", "3h ago", "2d ago", then a
 * locale date. Mirrors the relTime helper data canvases kept reimplementing.
 * @param {number|string|Date} when  epoch ms, Date, or ISO string
 * @param {object} [opts]
 * @param {number|string|Date} [opts.now=Date.now()]  reference point (testable)
 * @param {string} [opts.fallback=""]  returned when `when` is missing/invalid
 * @returns {string}
 */
export function relativeTime(when, { now = Date.now(), fallback = "" } = {}) {
  const ms = toMillis(when);
  const ref = toMillis(now) ?? Date.now();
  if (ms == null) return fallback;
  const s = Math.max(0, Math.floor((ref - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Compact number: 1500 -> "1.5K", 2.3e9 -> "2.3B". Wraps Intl compact notation.
 * @param {number|null|undefined} v
 * @param {object} [opts]
 * @param {number} [opts.digits=2]   max fraction digits
 * @param {string} [opts.fallback="—"]
 * @returns {string}
 */
export function compactNumber(v, { digits = 2, fallback = "—" } = {}) {
  if (v == null || !Number.isFinite(Number(v))) return fallback;
  return Number(v).toLocaleString(undefined, {
    notation: "compact",
    maximumFractionDigits: digits,
  });
}

/**
 * Percent string: 1.2345 -> "+1.23%". Input is already a percentage value
 * (not a 0..1 ratio), matching the shipped fmtPct.
 * @param {number|null|undefined} v
 * @param {object} [opts]
 * @param {boolean} [opts.signed=true]  prefix "+" for non-negative values
 * @param {number} [opts.digits=2]
 * @param {string} [opts.fallback="—"]
 * @returns {string}
 */
export function percent(v, { signed = true, digits = 2, fallback = "—" } = {}) {
  if (v == null || !Number.isFinite(Number(v))) return fallback;
  const n = Number(v);
  const sign = signed && n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}
