// test/similarity.test.mjs: confusability detection.
// Run:  node test/similarity.test.mjs

import assert from 'node:assert/strict';
import {
  editDistance,
  phoneticKey,
  similarity,
  confusableAgainst,
} from '../scripts/similarity.mjs';

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

// T9: edit distance
test('detects edit distance', () => {
  assert.equal(editDistance('beacon', 'beacon'), 0);
  assert.equal(editDistance('beacon', 'beacons'), 1); // insertion
  assert.equal(editDistance('flame', 'frame'), 1); // substitution
  assert.equal(editDistance('kitten', 'sitting'), 3);
  const s = similarity('beacon', 'beacons');
  assert.equal(s.level, 'high'); // one edit
  assert.ok(s.flags.includes('edit-distance-1'));
});

// T10: token reorder / segment swap
test('detects token reorder', () => {
  const s = similarity('alphacore', 'corealpha');
  assert.equal(s.level, 'high');
  assert.ok(s.flags.includes('segment-swap'));
  // multi-word reorder
  const w = similarity('blue-sky', 'sky-blue');
  assert.equal(w.level, 'high');
  assert.ok(w.flags.includes('token-reorder') || w.flags.includes('segment-swap'));
});

// T11: phonetic + no false positive
test('phonetic and no-false-positive', () => {
  assert.equal(phoneticKey('flex'), phoneticKey('flx')); // vowels dropped
  // clearly distinct names do not flag
  assert.equal(similarity('brightloom', 'zephyr').level, 'none');
  assert.equal(similarity('lumen', 'cascade').level, 'none');
  assert.equal(similarity('zap', 'willowmeadow').level, 'none');
});

// T12: confusableAgainst
test('confusableAgainst reports collisions', () => {
  const out = confusableAgainst('alphacore', ['corealpha', 'react', 'beacons']);
  assert.ok(out.length >= 1);
  assert.equal(out[0].other, 'corealpha'); // segment-swap collision
  for (const r of out) {
    assert.ok(r.level !== 'none');
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  }
  // identical name in the corpus is the strongest collision
  const withSelf = confusableAgainst('alphacore', ['alphacore', 'corealpha']);
  assert.equal(withSelf[0].other, 'alphacore');
  assert.deepEqual(confusableAgainst('unique-xyz', ['react', 'vue']), []); // nothing close
  assert.deepEqual(confusableAgainst('x', []), []); // empty corpus
});

console.log(`\nsimilarity.test.mjs: ${passed} passed`);
