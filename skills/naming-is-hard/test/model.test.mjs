// test/model.test.mjs: the preference model: learning, ranking, explore/exploit,
// explanation, and variant suggestions.
// Run:  node test/model.test.mjs

import assert from 'node:assert/strict';
import { extractFeatures } from '../scripts/features.mjs';
import {
  score,
  update,
  revert,
  duel,
  tournament,
  rank,
  pickNext,
  profile,
  suggestVariants,
  normalized,
} from '../scripts/model.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

function cand(id, name, meta) {
  const f = extractFeatures(name, meta);
  return { id, name, tokens: f.tokens };
}

// classA = short, hard-sounding, coined; classB = long, soft, compound
const A = (id, n) => cand(id, n); // e.g. Zap, Vex, Qbit
const B = (id, n) => cand(id, n); // e.g. Willowmeadow, Gentlebrook

// T7: learns from likes and passes
test('learns from likes and passes', () => {
  let w = {};
  w = update(w, A('a', 'Zap').tokens, 'like');
  w = update(w, A('a2', 'Kex').tokens, 'like');
  w = update(w, B('b', 'Willowmeadow').tokens, 'pass');
  w = update(w, B('b2', 'Gentlebrook').tokens, 'pass');

  const likedType = score(w, A('u1', 'Vex').tokens); // short + hard
  const passedType = score(w, B('u2', 'Meadowbrook').tokens); // long + compound
  assert.ok(
    likedType > passedType,
    `expected liked-type ${likedType} > passed-type ${passedType}`,
  );
  assert.ok(likedType > 0);
  assert.ok(passedType < 0);
});

// T8: super-like weighs more than like
test('super-like weighs more than like', () => {
  const tokens = A('x', 'Zap').tokens;
  const wLike = update({}, tokens, 'like');
  const wSuper = update({}, tokens, 'superlike');
  const sLike = score(wLike, tokens);
  const sSuper = score(wSuper, tokens);
  assert.ok(sSuper > sLike);
  assert.equal(sSuper, 2 * sLike); // +2 per token vs +1 per token
});

// T9: explains the learned type
test('explains the learned type', () => {
  let w = {};
  for (const n of ['Zap', 'Kex', 'Vex', 'Qbit']) {
    w = update(w, extractFeatures(n).tokens, 'like');
  }
  const p = profile(w);
  assert.equal(p.hasSignal, true);
  assert.ok(typeof p.summary === 'string' && p.summary.length > 0);
  assert.ok(p.likes.length > 0);
  // the learned likes should include short and/or hard-sound phrasing
  const phrases = p.likes.map((l) => l.phrase).join(' | ');
  assert.ok(/short|hard|coined|invented/i.test(phrases), phrases);

  const empty = profile({});
  assert.equal(empty.hasSignal, false);
  assert.match(empty.summary, /not enough/i);
});

// T10: next skips swiped
test('next skips swiped', () => {
  const candidates = ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
    cand(id, ['Zap', 'Willowmeadow', 'Feedly', 'Nio', 'Brightloom'][i]),
  );
  const swipedIds = [];
  const swipedCandidates = [];
  const shown = new Set();
  let picks = 0;
  while (true) {
    const next = pickNext(candidates, { swipedIds, swipedCandidates });
    if (!next) break;
    assert.ok(!swipedIds.includes(next.id), 'returned an already-swiped id');
    assert.ok(!shown.has(next.id), 'returned a duplicate');
    shown.add(next.id);
    swipedIds.push(next.id);
    swipedCandidates.push(next);
    if (++picks > 10) throw new Error('pickNext did not terminate');
  }
  assert.equal(picks, candidates.length);
});

// T11: next exploits learned preference
test('next exploits learned preference', () => {
  let w = {};
  for (let i = 0; i < 3; i++) {
    w = update(w, extractFeatures('Zap').tokens, 'like');
    w = update(w, extractFeatures('Willowmeadow').tokens, 'pass');
  }
  const candidates = [
    cand('vex', 'Vex'), // class A (liked)
    cand('gentle', 'Gentlebrook'), // class B (passed)
    cand('meadow', 'Meadowbrook'), // class B (passed)
  ];
  // swipeCount >= warmup so the exploration bonus is 0 -> pure exploit
  const next = pickNext(candidates, {
    weights: w,
    swipedIds: ['s1', 's2', 's3', 's4', 's5', 's6'],
    swipedCandidates: [],
  });
  assert.equal(next.id, 'vex');
});

// T12: next explores on cold start (no immediate tunnelling)
test('next explores on cold start', () => {
  const candidates = [
    cand('a', 'Zap'), // short/hard
    cand('b', 'Zop'), // near-duplicate of 'a' (short/hard)
    cand('z', 'Willowmeadow'), // very different (long/soft/compound)
  ];
  // first cold pick: all equal novelty -> smallest id
  const first = pickNext(candidates, { swipedIds: [], swipedCandidates: [] });
  assert.equal(first.id, 'a');
  // after passing 'a', the fresh long name should beat the near-duplicate 'b'
  const second = pickNext(candidates, {
    swipedIds: ['a'],
    swipedCandidates: [candidates[0]],
  });
  assert.equal(second.id, 'z', 'exploration should avoid the near-duplicate');
});

// T13: ranks by score
test('ranks by score', () => {
  let w = {};
  for (let i = 0; i < 3; i++) {
    w = update(w, extractFeatures('Zap').tokens, 'like');
    w = update(w, extractFeatures('Willowmeadow').tokens, 'pass');
  }
  const candidates = [
    cand('gentle', 'Gentlebrook'),
    cand('vex', 'Vex'),
    cand('meadow', 'Meadowbrook'),
  ];
  const ranked = rank(candidates, w);
  assert.equal(ranked[0].id, 'vex');
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score, 'not sorted desc');
  }
  assert.ok(ranked[0].fit > 0 && ranked[0].fit < 1); // normalized present
  assert.equal(ranked[0].fit, normalized(ranked[0].score));
});

// T14: suggests variants of liked names
test('suggests variants of liked names', () => {
  const variants = suggestVariants('Flow');
  assert.ok(Array.isArray(variants));
  assert.ok(variants.length <= 8 && variants.length > 0);
  assert.ok(variants.includes('Flowly'));
  assert.ok(variants.includes('Flowify'));
  assert.ok(!variants.includes('Flow')); // excludes the base itself
  // deterministic
  assert.deepEqual(variants, suggestVariants('Flow'));
  assert.deepEqual(suggestVariants(''), []);
});

// revert undoes an update (idempotent swiping support)
test('revert undoes an update', () => {
  const tokens = extractFeatures('Zap').tokens;
  const liked = update({}, tokens, 'like');
  const undone = revert(liked, tokens, 'like');
  assert.equal(score(undone, tokens), 0);
  // revert of a superlike is the inverse of applying it
  const supered = update({}, tokens, 'superlike');
  assert.equal(score(revert(supered, tokens, 'superlike'), tokens), 0);
});

// T23/T24: decision mode (duel + tournament)
test('duel moves winner above loser', () => {
  const a = extractFeatures('Zap'); // short/hard
  const b = extractFeatures('Willowmeadow'); // long/soft
  const w = duel({}, a.tokens, b.tokens);
  // after A beats B, A's distinguishing features outrank B's
  assert.ok(score(w, a.tokens) > score(w, b.tokens));
  // shared tokens do not move (only distinguishing ones)
  const shared = a.tokens.filter((t) => b.tokens.includes(t));
  for (const t of shared) assert.equal(w[t] || 0, 0);
});

test('tournament ranks from duels', () => {
  const cands = [
    { id: 'zap', ...extractFeatures('Zap') },
    { id: 'kex', ...extractFeatures('Kex') },
    { id: 'willow', ...extractFeatures('Willowmeadow') },
  ].map((c) => ({ id: c.id, tokens: c.tokens }));
  const zap = cands[0].tokens;
  const willow = cands[2].tokens;
  const kex = cands[1].tokens;
  const { ranked } = tournament(cands, [
    { winnerTokens: zap, loserTokens: willow },
    { winnerTokens: kex, loserTokens: willow },
  ]);
  assert.equal(ranked[ranked.length - 1].id, 'willow'); // the two-time loser ranks last
});

console.log(`\nmodel.test.mjs: ${passed} passed`);
