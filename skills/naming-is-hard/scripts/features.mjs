/**
 * features.mjs: deterministic feature extraction from a name.
 *
 * The preference model learns over *features*, not raw strings, so it can
 * generalize ("you like short coined names ending in -ly") from a handful of
 * swipes. This module turns a name into a stable set of categorical feature
 * tokens plus a human-readable detail object. Same input always yields the same
 * output: no randomness, no network, no clock.
 *
 * The agent may attach a `strategy` (how it coined the name) and semantic
 * `tags` (drawn from the Naming Brief); those are merged in as `strategy:*` and
 * `tag:*` tokens so the model can also learn "this founder likes nature
 * metaphors".
 */

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const HARD_CONSONANTS = /[kxzqj]|ck|gg/;
const SIBILANTS = /s|sh|z|ss|c[ei]/;

// Suffix families, longest/most-specific first; first match wins.
const SUFFIX_FAMILIES = [
  ['ify', /ify$/],
  ['ly', /ly$/],
  ['io', /io$/],
  ['ai', /ai$/],
  ['hub', /hub$/],
  ['labs', /labs$/],
  ['ster', /ster$/],
  ['ish', /ish$/],
  ['ify-fy', /fy$/],
  ['let', /let$/],
  ['o', /[bcdfghjklmnpqrstvwxyz]o$/], // consonant + o (e.g. Venmo, Zoho)
  ['r-drop', /[bcdfghjklmnpqrstvwxyz]r$/], // vowel-dropped (Flickr, Tumblr)
];

const PREFIX_FAMILIES = [
  ['get', /^get[a-z]/],
  ['go', /^go[a-z]/],
  ['try', /^try[a-z]/],
  ['use', /^use[a-z]/],
  ['my', /^my[a-z]/],
  ['e', /^e[a-z]{3}/],
  ['i', /^i[a-z]{3}/],
];

/**
 * Estimate syllables with the classic vowel-group heuristic. Not perfect, but
 * stable and good enough as a learning feature.
 * @param {string} letters lowercased letters only
 */
export function countSyllables(letters) {
  if (!letters) return 0;
  const groups = letters.match(/[aeiouy]+/g);
  let count = groups ? groups.length : 0;
  // silent trailing 'e' (e.g. "flame" -> 1, not 2), but not "-le" ("cradle")
  if (/[^aeiouy]e$/.test(letters) && !/[^aeiouy]le$/.test(letters)) {
    count -= 1;
  }
  return Math.max(1, count);
}

/** Split a name into words on hyphen or camelCase boundaries. */
export function splitWords(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s\-_]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

function lengthBucket(n) {
  if (n <= 5) return 'short';
  if (n <= 9) return 'medium';
  return 'long';
}

function syllableBucket(n) {
  if (n <= 1) return '1';
  if (n === 2) return '2';
  if (n === 3) return '3';
  return '4+';
}

function vowelClass(letters) {
  if (!letters.length) return 'balanced';
  const vowels = [...letters].filter((c) => VOWELS.has(c)).length;
  const ratio = vowels / letters.length;
  if (ratio >= 0.5) return 'vowel-heavy';
  if (ratio <= 0.28) return 'consonant-heavy';
  return 'balanced';
}

/**
 * Heuristic style hint. Not ground truth (no dictionary is bundled), just a
 * signal the model can weight: coined (vowel-dropped / unusual endings),
 * compound (splits into >=2 words), or realish.
 */
function styleHint(letters, words) {
  if (words.length >= 2) return 'compound';
  if (/[bcdfghjklmnpqrstvwxyz]{2}$/.test(letters) || /[^aeiouy]r$/.test(letters)) {
    return 'coined';
  }
  if (vowelClass(letters) === 'consonant-heavy') return 'coined';
  return 'realish';
}

function matchFamily(families, letters) {
  for (const [label, re] of families) {
    if (re.test(letters)) return label;
  }
  return 'none';
}

/**
 * Score how easy a name is to say (0 = unsayable, 1 = effortless), plus a `hardToSay`
 * flag. Penalizes vowel-starved names, long consonant clusters, and digits-as-letters
 * ("svrn", "s0", "nxdmn"). Ease of saying is a common rejection axis. Deterministic;
 * note that meaninglessness is a SEPARATE axis (a coined word can be easy to say yet
 * carry no meaning).
 * @param {string} name
 * @returns {{ score: number, hardToSay: boolean, reasons: string[] }}
 */
export function pronounceability(name) {
  const raw = String(name ?? '').toLowerCase();
  const letters = raw.replace(/[^a-z]/g, '');
  if (!letters) return { score: 0, hardToSay: true, reasons: ['no letters'] };
  const reasons = [];
  const vowels = (letters.match(/[aeiouy]/g) || []).length;
  const vowelRatio = vowels / letters.length;
  const consonantRuns = letters.match(/[^aeiouy]+/g) || [];
  const maxConsonantRun = consonantRuns.reduce((m, r) => Math.max(m, r.length), 0);
  const hasDigit = /[0-9]/.test(raw);

  let score = 1;
  if (vowels === 0) {
    score -= 0.6;
    reasons.push('no vowels');
  } else if (vowelRatio < 0.2) {
    score -= 0.35;
    reasons.push('vowel-starved');
  } else if (vowelRatio < 0.3) {
    score -= 0.15;
    reasons.push('few vowels');
  }
  if (maxConsonantRun >= 4) {
    score -= 0.35;
    reasons.push(`${maxConsonantRun}-consonant cluster`);
  } else if (maxConsonantRun === 3) {
    score -= 0.15;
    reasons.push('3-consonant cluster');
  }
  if (hasDigit) {
    score -= 0.3;
    reasons.push('digit in the name');
  }
  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  return { score, hardToSay: score < 0.5, reasons };
}

/**
 * Extract features from a name.
 *
 * @param {string} name
 * @param {Object} [meta]
 * @param {string} [meta.strategy]  how the name was coined (agent-supplied)
 * @param {string[]} [meta.tags]    semantic tags from the brief
 * @returns {{ name: string, letters: string, length: number, syllables: number,
 *   words: string[], tokens: string[], detail: Record<string, unknown> }}
 */
export function extractFeatures(name, meta = {}) {
  const display = String(name ?? '').trim();
  const letters = display.toLowerCase().replace(/[^a-z]/g, '');
  const words = splitWords(display);
  const syllables = countSyllables(letters);
  const length = letters.length;

  const startsVowel = letters.length > 0 && VOWELS.has(letters[0]);
  const endsVowel = letters.length > 0 && VOWELS.has(letters[letters.length - 1]);
  const doubleLetter = /([a-z])\1/.test(letters);
  const hard = HARD_CONSONANTS.test(letters);
  const sibilant = SIBILANTS.test(letters);
  const suffix = matchFamily(SUFFIX_FAMILIES, letters);
  const prefix = matchFamily(PREFIX_FAMILIES, letters);
  const style = styleHint(letters, words);
  const vowels = vowelClass(letters);
  const say = pronounceability(display);
  const alliteration =
    words.length >= 2 &&
    words.every((w) => w[0] && w[0].toLowerCase() === words[0][0].toLowerCase());

  const detail = {
    length,
    lengthBucket: lengthBucket(length),
    syllables,
    startsVowel,
    endsVowel,
    doubleLetter,
    hardConsonants: hard,
    sibilance: sibilant,
    suffix,
    prefix,
    style,
    vowels,
    wordCount: words.length || 1,
    alliteration,
    pronounceability: say.score,
    hardToSay: say.hardToSay,
  };

  const tokens = [
    `len:${detail.lengthBucket}`,
    `syl:${syllableBucket(syllables)}`,
    `starts:${startsVowel ? 'vowel' : 'consonant'}`,
    `ends:${endsVowel ? 'vowel' : 'consonant'}`,
    `double:${doubleLetter ? 'yes' : 'no'}`,
    `sound:${hard ? 'hard' : 'soft'}`,
    `sibilance:${sibilant ? 'yes' : 'no'}`,
    `suffix:${suffix}`,
    `prefix:${prefix}`,
    `style:${style}`,
    `vowels:${vowels}`,
    `words:${detail.wordCount >= 2 ? 'multi' : 'single'}`,
    `allit:${alliteration ? 'yes' : 'no'}`,
    `say:${say.hardToSay ? 'hard' : 'easy'}`,
  ];

  if (meta.strategy) tokens.push(`strategy:${slugToken(meta.strategy)}`);
  for (const tag of meta.tags || []) tokens.push(`tag:${slugToken(tag)}`);

  return { name: display, letters, length, syllables, words, tokens, detail };
}

/** Normalize a free-text label into a compact token value. */
function slugToken(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}
