/**
 * similarity.mjs: confusability detection.
 *
 * Availability answers "is this exact name taken?". Confusability answers a
 * different question that matters just as much: "is this too close to something that
 * already exists?" (a name one edit away from an existing project, or two names that
 * are reorderings of the same parts). The engine cannot know the whole world of
 * existing names, so the agent supplies a corpus (from its live web search + the
 * famous-marks list) and this module scores each candidate against it.
 *
 * Pure, deterministic, no I/O. Confusability is a CAUTION signal, never an automatic
 * Deal Breaker (that is reserved for real famous-mark collisions).
 */

import { slugify } from './net.mjs';
import { splitWords } from './features.mjs';

/** Full Levenshtein distance (strings are short). */
export function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** A light phonetic key: first letter + consonant skeleton (c/k/q -> k, s/z -> s). */
export function phoneticKey(name) {
  const s = slugify(name).replace(/[^a-z]/g, '');
  if (!s) return '';
  const mapped = s
    .replace(/ck/g, 'k')
    .replace(/ph/g, 'f')
    .replace(/[ckq]/g, 'k')
    .replace(/[sz]/g, 's');
  const first = mapped[0];
  const rest = mapped.slice(1).replace(/[aeiou]/g, ''); // drop non-leading vowels
  return (first + rest).replace(/(.)\1+/g, '$1'); // collapse doubles
}

/** True if the two names are anagrams (same multiset of letters). */
function isAnagram(a, b) {
  const key = (x) => slugify(x).replace(/[^a-z]/g, '').split('').sort().join('');
  const ka = key(a);
  return ka.length > 0 && ka === key(b);
}

/** True if some split of `a` swapped end-for-end equals `b` (front and back halves reversed). */
function isSegmentSwap(a, b) {
  const s = slugify(a).replace(/[^a-z0-9]/g, '');
  const t = slugify(b).replace(/[^a-z0-9]/g, '');
  if (s.length < 4 || s.length !== t.length || s === t) return false;
  for (let i = 1; i < s.length; i++) {
    if (s.slice(i) + s.slice(0, i) === t) return true; // rotation (covers half-swap)
  }
  return false;
}

/** True if both are multi-word and share the same word multiset in a different order. */
function isTokenReorder(a, b) {
  const wa = splitWords(a).map((w) => slugify(w)).filter(Boolean);
  const wb = splitWords(b).map((w) => slugify(w)).filter(Boolean);
  if (wa.length < 2 || wa.length !== wb.length) return false;
  const sortJoin = (arr) => [...arr].sort().join('|');
  return wa.join('|') !== wb.join('|') && sortJoin(wa) === sortJoin(wb);
}

/**
 * Score how confusable two names are.
 * @returns {{ level: 'high'|'medium'|'none', editDistance: number, flags: string[], reason: string }}
 */
export function similarity(a, b) {
  const sa = slugify(a).replace(/[^a-z0-9]/g, '');
  const sb = slugify(b).replace(/[^a-z0-9]/g, '');
  if (!sa || !sb) return { level: 'none', editDistance: Infinity, flags: [], reason: '' };
  if (sa === sb) {
    return { level: 'high', editDistance: 0, flags: ['identical'], reason: `identical to "${b}"` };
  }
  const dist = editDistance(sa, sb);
  const flags = [];
  if (isSegmentSwap(a, b)) flags.push('segment-swap');
  if (isTokenReorder(a, b)) flags.push('token-reorder');
  if (dist <= 2) flags.push(`edit-distance-${dist}`);
  if (isAnagram(a, b) && sa.length >= 5) flags.push('anagram');
  const phoneticMatch = phoneticKey(a) === phoneticKey(b) && Math.abs(sa.length - sb.length) <= 2;
  if (phoneticMatch) flags.push('phonetic');

  const minLen = Math.min(sa.length, sb.length);
  const high =
    flags.includes('segment-swap') ||
    flags.includes('token-reorder') ||
    (dist <= 1 && minLen >= 3);
  const medium =
    !high &&
    (dist === 2 ||
      flags.includes('anagram') ||
      (flags.includes('phonetic') && dist <= 3));

  const level = high ? 'high' : medium ? 'medium' : 'none';
  const reason = level === 'none' ? '' : `"${a}" is ${flags.join(', ')} vs "${b}"`;
  return { level, editDistance: dist, flags, reason };
}

/**
 * Compare a candidate against a corpus of existing names; return the confusable ones,
 * strongest first.
 * @param {string} name
 * @param {string[]} corpus
 * @returns {Array<{ other: string, level: string, editDistance: number, flags: string[], reason: string }>}
 */
export function confusableAgainst(name, corpus) {
  const rank = { high: 0, medium: 1, none: 2 };
  return (corpus || [])
    .map((other) => ({ other, ...similarity(name, other) }))
    .filter((r) => r.level !== 'none')
    .sort((x, y) => rank[x.level] - rank[y.level] || x.editDistance - y.editDistance);
}
