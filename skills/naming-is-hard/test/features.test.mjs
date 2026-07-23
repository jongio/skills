// test/features.test.mjs: deterministic feature extraction.
// Run:  node test/features.test.mjs

import assert from 'node:assert/strict';
import {
  extractFeatures,
  countSyllables,
  splitWords,
  pronounceability,
} from '../scripts/features.mjs';

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

function tokenVal(tokens, prefix) {
  const t = tokens.find((x) => x.startsWith(prefix + ':'));
  return t ? t.slice(prefix.length + 1) : undefined;
}

// T1: stable feature vector
test('extracts a stable feature vector', () => {
  const a = extractFeatures('Feedly');
  const b = extractFeatures('Feedly');
  assert.deepEqual(a.tokens, b.tokens);
  assert.deepEqual(a.detail, b.detail);
  assert.equal(tokenVal(a.tokens, 'len'), 'medium'); // 6 letters
  assert.equal(tokenVal(a.tokens, 'suffix'), 'ly');
  assert.ok(Array.isArray(a.tokens) && a.tokens.length > 0);
});

// T2: syllable estimate
test('estimates syllables', () => {
  assert.equal(countSyllables('flame'), 1); // silent e
  assert.equal(countSyllables('code'), 1);
  assert.equal(countSyllables('rocket'), 2);
  assert.equal(countSyllables('banana'), 3);
  assert.equal(countSyllables('table'), 2); // -le is not silent
  assert.equal(countSyllables('a'), 1); // floor at 1
  assert.equal(countSyllables(''), 0);
});

// T3: morphology (suffix / prefix)
test('detects morphology', () => {
  assert.equal(tokenVal(extractFeatures('Feedly').tokens, 'suffix'), 'ly');
  assert.equal(tokenVal(extractFeatures('Shopify').tokens, 'suffix'), 'ify');
  assert.equal(tokenVal(extractFeatures('GitHub').tokens, 'suffix'), 'hub');
  assert.equal(tokenVal(extractFeatures('Flickr').tokens, 'suffix'), 'r-drop');
  assert.equal(tokenVal(extractFeatures('GetHarvest').tokens, 'prefix'), 'get');
  assert.equal(tokenVal(extractFeatures('GoCardless').tokens, 'prefix'), 'go');
});

// T4: sound features
test('detects sound features', () => {
  assert.equal(tokenVal(extractFeatures('Zapier').tokens, 'sound'), 'hard'); // z
  assert.equal(tokenVal(extractFeatures('Kubernetes').tokens, 'sound'), 'hard'); // k
  assert.equal(tokenVal(extractFeatures('Mellow').tokens, 'sound'), 'soft');
  assert.equal(tokenVal(extractFeatures('Sass').tokens, 'sibilance'), 'yes');
  assert.equal(tokenVal(extractFeatures('Mellow').tokens, 'double'), 'yes'); // ll
});

// T5: real vs coined heuristic + compound
test('classifies real vs coined', () => {
  assert.equal(tokenVal(extractFeatures('Flickr').tokens, 'style'), 'coined');
  assert.equal(tokenVal(extractFeatures('blue-sky').tokens, 'style'), 'compound');
  assert.equal(tokenVal(extractFeatures('BlueSky').tokens, 'words'), 'multi');
  assert.equal(tokenVal(extractFeatures('river').tokens, 'style'), 'realish');
});

// T6: degenerate names do not throw
test('handles degenerate names', () => {
  for (const n of ['', '   ', 'a', '!!', null, undefined]) {
    const f = extractFeatures(n);
    assert.ok(Array.isArray(f.tokens), `tokens for ${JSON.stringify(n)}`);
    assert.equal(typeof f.length, 'number');
    assert.ok(f.syllables >= 0);
  }
});

// strategy + tags merge into tokens
test('merges strategy and semantic tags', () => {
  const f = extractFeatures('Willowmind', {
    strategy: 'Portmanteau',
    tags: ['calm', 'nature vibes'],
  });
  assert.ok(f.tokens.includes('strategy:portmanteau'));
  assert.ok(f.tokens.includes('tag:calm'));
  assert.ok(f.tokens.includes('tag:nature-vibes'));
});

test('splitWords handles camelCase, hyphen, and underscore', () => {
  assert.deepEqual(splitWords('BlueSky'), ['Blue', 'Sky']);
  assert.deepEqual(splitWords('blue-sky'), ['blue', 'sky']);
  assert.deepEqual(splitWords('blue_sky_labs'), ['blue', 'sky', 'labs']);
  assert.deepEqual(splitWords('river'), ['river']);
});

// T13/T14/T15: pronounceability
test('flags hard-to-say names', () => {
  assert.equal(pronounceability('svrn').hardToSay, true); // vowel-starved + cluster
  assert.equal(pronounceability('s0').hardToSay, true); // digit + no vowel
  assert.equal(pronounceability('nxdmn').hardToSay, true);
  assert.equal(pronounceability('').hardToSay, true);
  const svrn = pronounceability('svrn');
  assert.ok(svrn.score < 0.5);
  assert.ok(svrn.reasons.length > 0);
});

test('easy names score easy', () => {
  for (const n of ['river', 'brightloom', 'lumen', 'zylo', 'meridian']) {
    const p = pronounceability(n);
    assert.equal(p.hardToSay, false, `${n} should be easy: ${JSON.stringify(p)}`);
    assert.ok(p.score >= 0.5);
  }
  // deterministic
  assert.deepEqual(pronounceability('lumen'), pronounceability('lumen'));
});

test('say token in features', () => {
  assert.ok(extractFeatures('svrn').tokens.includes('say:hard'));
  assert.ok(extractFeatures('river').tokens.includes('say:easy'));
  assert.equal(typeof extractFeatures('river').detail.pronounceability, 'number');
});

console.log(`\nfeatures.test.mjs: ${passed} passed`);
