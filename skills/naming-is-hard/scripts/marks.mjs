/**
 * marks.mjs: the famous-marks screen.
 *
 * Matches a candidate name against a curated list of well-known global brands
 * and companies (`famous-marks.json`). A CONFIDENT hit (exact / compact /
 * whole-word) is the deterministic, zero-network source of the **Deal Breaker**
 * verdict: naming your startup "Spotify" or "Google Cloud X" is a non-starter,
 * and the engine should say so instantly. A near-miss is returned too, but the
 * caller (`availability.markChannels`) downgrades it to a soft caution rather
 * than a Deal Breaker.
 *
 * Matching is deliberately layered and conservative so it catches the obvious
 * collisions without nuking legitimately distinct names:
 *   - exact slug match          ("Spotify", "spot ify")     -> confident
 *   - compact (dehyphenated)    ("CocaCola" -> "Coca-Cola")  -> confident
 *   - whole-word containment    ("GoogleCloud" -> word "google") -> confident
 *   - near-miss (edit distance 1, length-guarded)  ("Gooogle") -> caution only
 *
 * Substring matching is intentionally NOT used ("metaverse" must not hit
 * "meta"); only whole normalized words count.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { slugify } from './net.mjs';
import { splitWords } from './features.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function loadMarks() {
  const raw = readFileSync(join(here, 'famous-marks.json'), 'utf-8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data.marks) ? data.marks : [];
  const index = new Map(); // hyphenated slug -> entry ("coca-cola")
  const compact = new Map(); // dehyphenated slug -> entry ("cocacola")
  for (const entry of list) {
    const slug = slugify(entry.name);
    if (!slug) continue;
    if (!index.has(slug)) index.set(slug, entry);
    const flat = slug.replace(/-/g, '');
    if (flat && !compact.has(flat)) compact.set(flat, entry);
  }
  return { list, index, compact };
}

const { list: MARKS, index: MARK_INDEX, compact: MARK_COMPACT } = loadMarks();

/** Number of marks loaded (handy for tests / diagnostics). */
export function markCount() {
  return MARK_INDEX.size;
}

/** True if `a` and `b` are within Levenshtein distance 1. Cheap, bounded. */
export function withinEditDistance1(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diffs = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i] && ++diffs > 1) return false;
    }
    return diffs === 1;
  }
  // lengths differ by exactly 1: check for a single insertion/deletion
  const [shorter, longer] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edited = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++;
      j++;
    } else {
      if (edited) return false;
      edited = true;
      j++; // skip one char in the longer string
    }
  }
  return true;
}

/**
 * @typedef {Object} MarkMatch
 * @property {boolean} hit
 * @property {string} [mark]        the famous brand that matched
 * @property {string} [category]
 * @property {'exact'|'word'|'near-miss'} [matchType]
 * @property {string} [reason]      human-readable, for override transparency
 */

/**
 * Screen a candidate name against the famous-marks list.
 * @param {string} name
 * @returns {MarkMatch}
 */
export function matchFamousMark(name) {
  const slug = slugify(name);
  if (!slug) return { hit: false };

  // 1. exact slug match
  if (MARK_INDEX.has(slug)) {
    const m = MARK_INDEX.get(slug);
    return {
      hit: true,
      mark: m.name,
      category: m.category,
      matchType: 'exact',
      reason: `"${name}" is an exact match for the ${m.category} brand ${m.name}.`,
    };
  }

  // 2. compact (dehyphenated) match: "CocaCola"/"RedBull"/"cocacola" -> "Coca-Cola"/"Red Bull".
  // Runs even when the candidate has no hyphens (flat === slug): step 1 already
  // ruled out an exact hyphenated-index match, so a MARK_COMPACT hit here is the
  // closed form of a multi-word brand and must be a confident collision.
  const flat = slug.replace(/-/g, '');
  if (flat && MARK_COMPACT.has(flat)) {
    const m = MARK_COMPACT.get(flat);
    return {
      hit: true,
      mark: m.name,
      category: m.category,
      matchType: 'exact',
      reason: `"${name}" matches the ${m.category} brand ${m.name}.`,
    };
  }

  // 3. whole-word containment (e.g. "GoogleCloud" -> "google")
  const words = splitWords(name).map(slugify).filter(Boolean);
  if (words.length > 1) {
    for (const w of words) {
      if (MARK_INDEX.has(w)) {
        const m = MARK_INDEX.get(w);
        return {
          hit: true,
          mark: m.name,
          category: m.category,
          matchType: 'word',
          reason: `"${name}" contains the ${m.category} brand ${m.name} as a word.`,
        };
      }
    }
  }

  // 4. near-miss on the whole slug, guarded to avoid nuking short distinct names
  if (slug.length >= 5) {
    for (const key of MARK_INDEX.keys()) {
      if (key.length < 5) continue;
      if (Math.abs(key.length - slug.length) > 1) continue;
      if (key[0] !== slug[0]) continue; // same initial: conservative
      if (withinEditDistance1(slug, key)) {
        const m = MARK_INDEX.get(key);
        return {
          hit: true,
          mark: m.name,
          category: m.category,
          matchType: 'near-miss',
          reason: `"${name}" is one character away from the ${m.category} brand ${m.name}.`,
        };
      }
    }
  }

  return { hit: false };
}
