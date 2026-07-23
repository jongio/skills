/**
 * verdict.mjs: roll a name's availability scorecard up into ONE of three tiers,
 * so "can I actually use this?" reads at a glance. Pure functions, no I/O.
 *
 *   🚫 Deal Breaker: a famous trademark/company owns it. Walk away.
 *   💛 It's Complicated: no legal blocker, but a key channel is contested.
 *   💚 Perfect Match: trademark-clear and every key channel is free. Grab it.
 *
 * A famous-marks hit always forces Deal Breaker, and a Deal Breaker is never
 * crowned the winner in `rankByVerdict`.
 */

export const TIERS = Object.freeze({
  'deal-breaker': {
    tier: 'deal-breaker',
    label: 'Deal Breaker',
    emoji: '🚫',
    blurb: 'A famous trademark or company owns this. Walk away.',
    rank: 2,
  },
  complicated: {
    tier: 'complicated',
    label: "It's Complicated",
    emoji: '💛',
    blurb: 'Chemistry with baggage. Usable only with a compromise.',
    rank: 1,
  },
  'perfect-match': {
    tier: 'perfect-match',
    label: 'Perfect Match',
    emoji: '💚',
    blurb: 'No famous-mark collision and the channels that matter are free. Swipe right.',
    rank: 0,
  },
});

/** The channels that decide Perfect Match by default. Overridable via opts.keys. */
// Named key-channel priority sets. The verdict's Perfect Match requires every key
// channel to be free; the ORDER encodes priority (most important first) for the report.
// Default is `cli-first`, matching the observed user priority: the npm/CLI name first,
// then the launch domain (`.dev`, not the always-parked `.com`), then the GitHub org
// (which can be decorated when taken).
export const KEY_PRESETS = Object.freeze({
  'cli-first': [
    { group: 'registries', key: 'npm', label: 'npm package' },
    { group: 'domains', key: 'dev', label: '.dev domain' },
    { group: 'github', key: 'org', label: 'GitHub org' },
  ],
  'domain-first': [
    { group: 'domains', key: 'dev', label: '.dev domain' },
    { group: 'registries', key: 'npm', label: 'npm package' },
    { group: 'github', key: 'org', label: 'GitHub org' },
  ],
  'website-first': [
    { group: 'domains', key: 'com', label: '.com domain' },
    { group: 'domains', key: 'dev', label: '.dev domain' },
    { group: 'registries', key: 'npm', label: 'npm package' },
  ],
  'brand-first': [
    { group: 'domains', key: 'com', label: '.com domain' },
    { group: 'social', key: 'x', label: 'X handle' },
    { group: 'domains', key: 'dev', label: '.dev domain' },
  ],
  'social-first': [
    { group: 'social', key: 'x', label: 'X handle' },
    { group: 'domains', key: 'dev', label: '.dev domain' },
    { group: 'registries', key: 'npm', label: 'npm package' },
  ],
  balanced: [
    { group: 'domains', key: 'dev', label: '.dev domain' },
    { group: 'github', key: 'org', label: 'GitHub org' },
    { group: 'registries', key: 'npm', label: 'npm package' },
  ],
});

export const DEFAULT_PRESET = 'cli-first';

/** The default key set, used when no preset name matches. */
export const DEFAULT_KEYS = KEY_PRESETS[DEFAULT_PRESET];

/** Resolve a preset name or an explicit key array into a key list. */
export function resolveKeys(presetOrKeys) {
  if (Array.isArray(presetOrKeys)) return presetOrKeys;
  if (typeof presetOrKeys === 'string' && KEY_PRESETS[presetOrKeys]) {
    return KEY_PRESETS[presetOrKeys];
  }
  return DEFAULT_KEYS;
}

/** Read a leaf status from a scorecard, tolerating object-valued entries (social/npm). */
export function getStatus(scorecard, desc) {
  const group = scorecard?.channels?.[desc.group];
  if (!group) return 'unknown';
  let v = group[desc.key];
  if (v && typeof v === 'object') v = v.status;
  return v || 'unknown';
}

/**
 * Compute the verdict for one scorecard.
 * @param {Object} scorecard
 * @param {Object} [opts]
 * @param {Array<{group:string,key:string,label:string}>} [opts.keys] explicit key list
 * @param {string} [opts.preset] a KEY_PRESETS name (default `cli-first`)
 */
export function computeVerdict(scorecard, opts = {}) {
  const keys = opts.keys ? resolveKeys(opts.keys) : resolveKeys(opts.preset);
  const tm = scorecard?.channels?.trademark || {};
  const biz = scorecard?.channels?.business || {};

  // Deal Breaker: famous-marks hit or a confident collision.
  if (tm.famous || biz.famous || tm.status === 'collision' || biz.status === 'collision') {
    const mark = tm.mark || biz.mark;
    const reason =
      tm.reason ||
      biz.reason ||
      (mark ? `Collides with ${mark}.` : 'Trademark or business collision.');
    return make('deal-breaker', reason, { famousMark: mark, keyChannels: keyStatuses(scorecard, keys) });
  }

  const keyChannels = keyStatuses(scorecard, keys);
  const allFree = keyChannels.every((k) => k.status === 'available');
  const trademarkClear = tm.status !== 'collision'; // clear, caution, or unknown
  // A near-miss to a famous brand is a soft caution, not a blocker: surface it.
  const caution = tm.status === 'caution' || biz.status === 'caution' ? tm.note || biz.note : null;

  if (allFree && trademarkClear) {
    return make(
      'perfect-match',
      `No famous-mark collision, and free on ${keyChannels.map((k) => k.label).join(', ')}.`,
      { keyChannels, caution },
    );
  }

  const contested = keyChannels.filter((k) => k.status !== 'available');
  const reason = contested.length
    ? `Contested: ${contested.map((k) => `${k.label} (${k.status})`).join(', ')}.`
    : 'Some secondary channels are contested.';
  return make('complicated', reason, { keyChannels, caution });
}

function keyStatuses(scorecard, keys) {
  return keys.map((k) => ({ ...k, status: getStatus(scorecard, k) }));
}

function make(tier, reason, extra) {
  return { ...TIERS[tier], reason, ...extra };
}

/**
 * A 0..1 availability score across every channel leaf, used to break ties within
 * a tier. available = 1, unknown = 0.5 (neutral), taken = 0.
 */
export function availabilityScore(scorecard) {
  const leaves = [];
  const c = scorecard?.channels || {};
  for (const group of ['domains', 'github', 'registries']) {
    for (const v of Object.values(c[group] || {})) {
      leaves.push(v && typeof v === 'object' ? v.status : v); // npm can be an object (tombstone)
    }
  }
  for (const v of Object.values(c.social || {})) {
    leaves.push(v && typeof v === 'object' ? v.status : v);
  }
  if (!leaves.length) return 0;
  const total = leaves.reduce((sum, s) => {
    if (s === 'available') return sum + 1;
    if (s === 'taken') return sum + 0;
    return sum + 0.5; // unknown
  }, 0);
  return total / leaves.length;
}

/**
 * Rank finalists by verdict tier then combined fit+availability, and pick a
 * winner. A Deal Breaker is never the winner (returns the best non-Deal-Breaker,
 * or null if every finalist is a Deal Breaker).
 *
 * @param {Array<{id?:string, name:string, fit?:number, scorecard:Object}>} finalists
 * @param {Object} [opts]
 * @param {number} [opts.fitWeight]
 * @param {number} [opts.availWeight]
 * @param {Array} [opts.keys] explicit key list
 * @param {string} [opts.preset] a KEY_PRESETS name
 */
export function rankByVerdict(finalists, opts = {}) {
  const { fitWeight = 0.5, availWeight = 0.5, keys, preset } = opts;
  const scored = finalists.map((f) => {
    const verdict = computeVerdict(f.scorecard, { keys, preset });
    const avail = availabilityScore(f.scorecard);
    const fit = typeof f.fit === 'number' ? f.fit : 0.5;
    const combined = fitWeight * fit + availWeight * avail;
    return { ...f, verdict, availability: avail, combined };
  });
  scored.sort(
    (a, b) =>
      a.verdict.rank - b.verdict.rank ||
      b.combined - a.combined ||
      String(a.name).localeCompare(String(b.name)),
  );
  const winner = scored.find((f) => f.verdict.tier !== 'deal-breaker') || null;
  return { ranked: scored, winner };
}
