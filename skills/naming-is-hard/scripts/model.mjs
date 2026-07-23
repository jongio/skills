/**
 * model.mjs: the "learn your type" engine.
 *
 * A transparent online preference model over the categorical feature tokens
 * that `features.mjs` emits. It is deliberately NOT machine learning in the
 * embedding sense: it keeps one weight per feature value, nudges those weights
 * on every swipe, and can therefore *explain itself* in plain language, which is
 * the whole point of a dating-app UX. It also converges fast: a handful of
 * swipes is enough signal.
 *
 * Pure functions over a serializable `weights` object so `store.mjs` can persist
 * the model and the whole thing stays deterministic and unit-testable.
 */

/** How hard each swipe moves the weights. Super-like counts double a like. */
export const LABEL_DELTA = Object.freeze({
  superlike: 2,
  like: 1,
  pass: -1,
  dislike: -1,
  skip: 0,
});

const WEIGHT_CAP = 6; // keep any single feature from dominating forever

function clamp(x, cap = WEIGHT_CAP) {
  return Math.max(-cap, Math.min(cap, x));
}

/** Raw preference score = sum of the candidate's feature weights. */
export function score(weights, tokens) {
  let s = 0;
  for (const t of tokens) s += weights[t] || 0;
  return s;
}

/** Squash a raw score into (0,1) for display. */
export function normalized(sum) {
  return 1 / (1 + Math.exp(-sum));
}

/**
 * Fold one swipe into the weights and return a NEW weights object.
 * @param {Record<string, number>} weights
 * @param {string[]} tokens
 * @param {keyof typeof LABEL_DELTA} label
 * @param {number} [lr] learning rate
 */
export function update(weights, tokens, label, lr = 1) {
  const delta = (LABEL_DELTA[label] ?? 0) * lr;
  const next = { ...weights };
  if (delta === 0) return next;
  for (const t of tokens) next[t] = clamp((next[t] || 0) + delta);
  return next;
}

/**
 * Reverse a previously applied swipe, so a re-swipe or a changed swipe does not
 * double-count. Subtracts the label's delta (the inverse of `update`). Clamping
 * makes this exact for the normal range of weights.
 * @param {Record<string, number>} weights
 * @param {string[]} tokens
 * @param {keyof typeof LABEL_DELTA} label
 */
export function revert(weights, tokens, label) {
  const delta = LABEL_DELTA[label] ?? 0;
  const next = { ...weights };
  if (delta === 0) return next;
  for (const t of tokens) next[t] = clamp((next[t] || 0) - delta);
  return next;
}

/**
 * Decision mode: fold one head-to-head result (winner beats loser) into the weights.
 * Only DISTINGUISHING features move (tokens the two do not share), so a duel teaches
 * the model what the user prefers when forced to choose. This is what helps a stuck
 * user converge instead of swiping forever.
 * @param {Record<string, number>} weights
 * @param {string[]} winnerTokens
 * @param {string[]} loserTokens
 * @param {number} [lr]
 */
export function duel(weights, winnerTokens, loserTokens, lr = 1) {
  const w = new Set(winnerTokens);
  const l = new Set(loserTokens);
  const next = { ...weights };
  for (const t of winnerTokens) if (!l.has(t)) next[t] = clamp((next[t] || 0) + lr);
  for (const t of loserTokens) if (!w.has(t)) next[t] = clamp((next[t] || 0) - lr);
  return next;
}

/**
 * Run a tournament: fold a list of head-to-head results into the weights, then rank
 * the candidates by the learned preference. Produces a decisive ranked order.
 * @param {Array<{id:string, tokens:string[]}>} candidates
 * @param {Array<{winnerTokens:string[], loserTokens:string[]}>} results
 * @param {Record<string, number>} [weights]
 */
export function tournament(candidates, results, weights = {}) {
  let w = { ...weights };
  for (const r of results || []) w = duel(w, r.winnerTokens, r.loserTokens);
  return { weights: w, ranked: rank(candidates, w) };
}

/** Count how often each token has already been shown (for novelty/exploration). */
export function seenTokenCounts(swipedCandidates) {
  const counts = {};
  for (const c of swipedCandidates || []) {
    for (const t of c.tokens || []) counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

/** Novelty of a candidate = how unseen its features are. Higher = fresher. */
export function novelty(tokens, counts) {
  let n = 0;
  for (const t of tokens) n += 1 / (1 + (counts[t] || 0));
  return n;
}

/**
 * Pick the next card to show, blending exploitation (score) with exploration
 * (novelty). The exploration bonus decays as swipes accumulate, so early cards
 * are diverse (no filter bubble) and later cards home in on the learned taste.
 * Never returns an already-swiped candidate. Fully deterministic.
 *
 * @param {Array<{id:string, tokens:string[]}>} candidates
 * @param {Object} opts
 * @param {Record<string,number>} [opts.weights]
 * @param {string[]} [opts.swipedIds]
 * @param {Array<{id:string, tokens:string[]}>} [opts.swipedCandidates]
 * @param {number} [opts.warmupSwipes]
 * @param {number} [opts.baseBonus]
 * @returns {{id:string, tokens:string[]} | null}
 */
export function pickNext(candidates, opts = {}) {
  const {
    weights = {},
    swipedIds = [],
    swipedCandidates = [],
    warmupSwipes = 6,
    baseBonus = 2,
  } = opts;
  const swiped = new Set(swipedIds.map(String));
  const unseen = candidates.filter((c) => !swiped.has(String(c.id)));
  if (unseen.length === 0) return null;

  const swipeCount = swipedIds.length;
  const counts = seenTokenCounts(swipedCandidates);
  const bonus = baseBonus * Math.max(0, 1 - swipeCount / warmupSwipes);

  let best = null;
  let bestSel = -Infinity;
  for (const c of unseen) {
    const sel = score(weights, c.tokens) + bonus * novelty(c.tokens, counts);
    if (
      sel > bestSel ||
      (sel === bestSel && best && String(c.id) < String(best.id))
    ) {
      bestSel = sel;
      best = c;
    }
  }
  return best;
}

/**
 * Rank candidates by learned preference, best first. Stable, deterministic.
 * @param {Array<{id:string, name?:string, tokens:string[]}>} candidates
 * @param {Record<string,number>} weights
 */
export function rank(candidates, weights) {
  return candidates
    .map((c) => {
      const raw = score(weights, c.tokens);
      return { ...c, score: raw, fit: normalized(raw) };
    })
    .sort(
      (a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)),
    );
}

// Plain-language phrases for the NOTABLE feature values only: the ones worth
// putting in a taste profile. Boring default states (starts:consonant,
// double:no, len:medium, ...) are intentionally absent so `profile` never
// headlines "no" or a filler default. Scoring still uses every token; this map
// only governs what the profile SHOWS.
const PHRASES = {
  'len:short': 'short names',
  'len:long': 'longer names',
  'syl:1': 'one-syllable names',
  'syl:4+': 'long, multi-syllable names',
  'starts:vowel': 'names that start with a vowel',
  'ends:vowel': 'names that end in a vowel',
  'double:yes': 'names with a doubled letter',
  'sound:hard': 'hard, techy sounds (k/x/z/q)',
  'sound:soft': 'soft, smooth sounds',
  'sibilance:yes': 'hissing “s/sh/z” sounds',
  'style:coined': 'invented / coined words',
  'style:compound': 'compound (two-word) names',
  'style:realish': 'real dictionary words',
  'vowels:vowel-heavy': 'vowel-rich, open names',
  'vowels:consonant-heavy': 'consonant-dense names',
  'words:multi': 'multi-word names',
  'allit:yes': 'alliterative names',
  'say:easy': 'easy-to-say names',
  'say:hard': 'hard-to-say names',
  'suffix:ly': 'names ending in “-ly”',
  'suffix:ify': 'names ending in “-ify”',
  'suffix:io': 'names ending in “-io”',
  'suffix:ai': 'names ending in “-ai”',
  'suffix:hub': 'names ending in “-hub”',
  'suffix:labs': 'names ending in “-labs”',
  'suffix:r-drop': 'vowel-dropped names (Flickr-style)',
};

/** Is this token worth showing in a taste profile? */
function isNotable(token) {
  return (
    Object.prototype.hasOwnProperty.call(PHRASES, token) ||
    token.startsWith('tag:') ||
    token.startsWith('strategy:')
  );
}

function phrase(token) {
  if (PHRASES[token]) return PHRASES[token];
  if (token.startsWith('tag:')) return `${token.slice(4).replace(/-/g, ' ')} vibes`;
  if (token.startsWith('strategy:')) return `${token.slice(9).replace(/-/g, ' ')} names`;
  return token.replace(/^[a-z]+:/, '').replace(/-/g, ' ');
}

/**
 * Describe the learned taste in plain language: what the user gravitates to and
 * what they reject. Only notable features are surfaced (see `isNotable`).
 * @param {Record<string,number>} weights
 * @param {Object} [opts]
 * @param {number} [opts.limit]
 */
export function profile(weights, opts = {}) {
  const { limit = 5 } = opts;
  const entries = Object.entries(weights)
    .filter(([t, w]) => w !== 0 && isNotable(t))
    .sort((a, b) => b[1] - a[1]);
  const likes = entries
    .filter(([, w]) => w > 0)
    .slice(0, limit)
    .map(([t, w]) => ({ token: t, weight: w, phrase: phrase(t) }));
  const dislikes = entries
    .filter(([, w]) => w < 0)
    .slice(-limit)
    .reverse()
    .map(([t, w]) => ({ token: t, weight: w, phrase: phrase(t) }));
  return {
    likes,
    dislikes,
    hasSignal: entries.length > 0,
    summary: likes.length
      ? `You lean toward ${likes.map((l) => l.phrase).join(', ')}.`
      : 'Not enough swipes yet to read your type.',
  };
}

const VARIANT_SUFFIXES = ['ly', 'ify', 'io', 'ai', 'hub', 'labs', 'r', 'o'];

/**
 * Generate deterministic morphological variants of a liked name, so the deck can
 * be refilled with "more like this". Creative generation is the agent's job;
 * this is the cheap, safe expansion the engine can guarantee.
 * @param {string} name
 * @param {number} [limit]
 * @returns {string[]}
 */
export function suggestVariants(name, limit = 8) {
  const base = String(name).replace(/[^A-Za-z0-9]/g, '');
  if (!base) return [];
  const stem = base.replace(/(ly|ify|io|ai|hub|labs|r|o)$/i, '') || base;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const out = new Set();
  for (const suf of VARIANT_SUFFIXES) out.add(cap(stem) + suf);
  out.add(cap(base) + base.slice(-1).toLowerCase()); // double the last letter
  out.delete(cap(base));
  return [...out].filter(Boolean).slice(0, limit);
}
