// test/marks.test.mjs: the famous-marks screen (Deal Breaker source).
// Run:  node test/marks.test.mjs

import assert from 'node:assert/strict';
import {
  matchFamousMark,
  withinEditDistance1,
  markCount,
} from '../scripts/marks.mjs';

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

// T25: matches exact and slug forms
test('matches exact and slug forms', () => {
  for (const n of ['Spotify', 'spotify', 'SPOTIFY']) {
    const m = matchFamousMark(n);
    assert.equal(m.hit, true, `should hit ${n}`);
    assert.equal(m.mark, 'Spotify');
  }
  // space / hyphen / concatenation variants of a multi-word brand
  assert.equal(matchFamousMark('Coca Cola').hit, true);
  assert.equal(matchFamousMark('coca-cola').hit, true);
  // closed form founders actually type must be a CONFIDENT (exact) match, not near-miss
  const cc = matchFamousMark('CocaCola');
  assert.equal(cc.hit, true);
  assert.equal(cc.matchType, 'exact', 'closed-form multi-word brand must be a confident match');
  assert.equal(matchFamousMark('RedBull').matchType, 'exact');
  assert.equal(matchFamousMark('goldmansachs').matchType, 'exact');
  // whole-word containment
  const gc = matchFamousMark('GoogleCloud');
  assert.equal(gc.hit, true);
  assert.equal(gc.mark, 'Google');
  assert.equal(gc.matchType, 'word');
});

// T26: near-miss is conservative
test('near-miss is conservative', () => {
  const g = matchFamousMark('Gooogle');
  assert.equal(g.hit, true);
  assert.equal(g.mark, 'Google');
  assert.equal(g.matchType, 'near-miss');

  // distinct names must NOT hit
  for (const n of ['Flowly', 'Zap', 'Brightloom', 'Willowmind', 'Quibble']) {
    assert.equal(matchFamousMark(n).hit, false, `false positive on ${n}`);
  }
  // substring must not trigger: "metaverse" is not "Meta"
  assert.equal(matchFamousMark('Metaverse').hit, false);
  // short distinct names are guarded out of near-miss
  assert.equal(matchFamousMark('Kex').hit, false);
});

// T27: reports why it matched
test('reports why it matched', () => {
  const m = matchFamousMark('Spotify');
  assert.ok(typeof m.reason === 'string' && m.reason.includes('Spotify'));
  assert.equal(m.matchType, 'exact');
  assert.ok(m.category);
  // empty / unusable input never hits
  assert.equal(matchFamousMark('').hit, false);
  assert.equal(matchFamousMark('   ').hit, false);
});

test('withinEditDistance1 basics', () => {
  assert.equal(withinEditDistance1('google', 'google'), true);
  assert.equal(withinEditDistance1('google', 'gooogle'), true); // insertion
  assert.equal(withinEditDistance1('google', 'googl'), true); // deletion
  assert.equal(withinEditDistance1('google', 'gaagle'), false); // 2 subs
  assert.equal(withinEditDistance1('abc', 'abcde'), false); // len diff 2
});

test('marks list loaded', () => {
  assert.ok(markCount() > 100, `expected a sizable list, got ${markCount()}`);
});

console.log(`\nmarks.test.mjs: ${passed} passed`);
