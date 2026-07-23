// test/verdict.test.mjs: the three-tier roll-up.
// Run:  node test/verdict.test.mjs

import assert from 'node:assert/strict';
import {
  computeVerdict,
  rankByVerdict,
  availabilityScore,
  resolveKeys,
  KEY_PRESETS,
  DEFAULT_PRESET,
  TIERS,
} from '../scripts/verdict.mjs';

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

function sc(over = {}) {
  return {
    name: over.name || 'Test',
    channels: {
      trademark: over.trademark || { status: 'clear', famous: false },
      business: over.business || { status: 'clear', famous: false },
      domains: over.domains || {},
      github: over.github || {},
      registries: over.registries || {},
      social: over.social || {},
    },
  };
}

const FREE = {
  domains: { dev: 'available', com: 'available' },
  github: { org: 'available' },
  registries: { npm: 'available' },
};

// T30: famous-marks forces Deal Breaker regardless of open domains
test('famous-marks forces Deal Breaker', () => {
  const v = computeVerdict(
    sc({
      trademark: { status: 'collision', famous: true, mark: 'Spotify', reason: 'matches Spotify' },
      ...FREE, // even with everything free
    }),
  );
  assert.equal(v.tier, 'deal-breaker');
  assert.equal(v.famousMark, 'Spotify');
  assert.match(v.reason, /Spotify/);
});

// T31: all clear yields Perfect Match
test('all clear yields Perfect Match', () => {
  const v = computeVerdict(sc(FREE));
  assert.equal(v.tier, 'perfect-match');
  // trademark 'unknown' (not confirmable) still allows Perfect Match if channels free
  const v2 = computeVerdict(sc({ ...FREE, trademark: { status: 'unknown', famous: false } }));
  assert.equal(v2.tier, 'perfect-match');
});

// T32: contested key channel yields It's Complicated
test('contested key channel yields It\'s Complicated', () => {
  const v = computeVerdict(
    sc({
      domains: { dev: 'available' },
      github: { org: 'available' },
      registries: { npm: 'taken' },
    }),
  );
  assert.equal(v.tier, 'complicated');
  assert.match(v.reason, /npm package \(taken\)/);
  // unknown key channel also blocks Perfect Match (we did not confirm it free)
  const v2 = computeVerdict(
    sc({ domains: { dev: 'available' }, github: { org: 'unknown' }, registries: { npm: 'available' } }),
  );
  assert.equal(v2.tier, 'complicated');
});

// T33: verdict has label, emoji, reason
test('verdict has label, emoji, reason', () => {
  const v = computeVerdict(sc(FREE));
  assert.equal(v.label, 'Perfect Match');
  assert.equal(v.emoji, '💚');
  assert.ok(typeof v.reason === 'string' && v.reason.length > 0);
  assert.equal(computeVerdict(sc({ trademark: { famous: true, mark: 'Nike' } })).emoji, '🚫');
  assert.equal(TIERS['complicated'].label, "It's Complicated");
});

// T34: key channels are configurable
test('key channels are configurable', () => {
  const keys = [{ group: 'social', key: 'x', label: 'X handle' }];
  const free = computeVerdict(sc({ social: { x: { status: 'available' } } }), { keys });
  assert.equal(free.tier, 'perfect-match');
  const taken = computeVerdict(sc({ social: { x: { status: 'taken' } } }), { keys });
  assert.equal(taken.tier, 'complicated');
});

// T35: report never crowns a Deal Breaker winner
test('report never crowns a Deal Breaker', () => {
  const dealBreaker = {
    name: 'Spotify',
    fit: 0.99, // user loved it
    scorecard: sc({ trademark: { famous: true, mark: 'Spotify' }, ...FREE }),
  };
  const clean = { name: 'Brightloom', fit: 0.6, scorecard: sc(FREE) };
  const { ranked, winner } = rankByVerdict([dealBreaker, clean]);
  assert.equal(winner.name, 'Brightloom');
  assert.equal(ranked[0].name, 'Brightloom'); // deal-breaker sorted last
  assert.equal(ranked[ranked.length - 1].verdict.tier, 'deal-breaker');

  // all deal-breakers -> no winner
  const allBad = rankByVerdict([dealBreaker, { name: 'Nike', scorecard: sc({ trademark: { famous: true, mark: 'Nike' } }) }]);
  assert.equal(allBad.winner, null);
});

test('availabilityScore reflects free vs taken', () => {
  const free = availabilityScore(sc(FREE));
  const taken = availabilityScore(
    sc({ domains: { com: 'taken' }, github: { org: 'taken' }, registries: { npm: 'taken' } }),
  );
  assert.ok(free > taken);
  assert.equal(taken, 0);
  // an object-valued npm (tombstone) counts as taken (0), not unknown (0.5)
  const tomb = availabilityScore(
    sc({ domains: { com: 'taken' }, github: { org: 'taken' }, registries: { npm: { status: 'taken', tombstone: true } } }),
  );
  assert.equal(tomb, 0);
});

test('near-miss caution does not force Deal Breaker', () => {
  const v = computeVerdict(
    sc({
      trademark: { status: 'caution', famous: false, note: 'one character from Stripe. Worth a manual check.' },
      business: { status: 'caution', famous: false },
      ...FREE,
    }),
  );
  assert.equal(v.tier, 'perfect-match');
  assert.ok(v.caution && v.caution.includes('Stripe'));
});

// T16-T18: channel-priority presets
test('cli-first preset order and resolveKeys', () => {
  const cli = KEY_PRESETS['cli-first'];
  assert.equal(cli[0].group, 'registries'); // npm first
  assert.equal(cli[0].key, 'npm');
  assert.equal(cli[1].label, '.dev domain'); // launch TLD, not .com
  assert.equal(cli[2].group, 'github');
  assert.equal(DEFAULT_PRESET, 'cli-first');
  // resolveKeys accepts a name, an array, or nothing (default)
  assert.deepEqual(resolveKeys('domain-first'), KEY_PRESETS['domain-first']);
  assert.deepEqual(resolveKeys(undefined), KEY_PRESETS['cli-first']);
  assert.deepEqual(resolveKeys('nonsense'), KEY_PRESETS['cli-first']);
  const custom = [{ group: 'social', key: 'x', label: 'X' }];
  assert.deepEqual(resolveKeys(custom), custom);
});

test('preset changes the verdict', () => {
  // npm taken, .dev free: cli-first (npm is key) -> complicated; a social-only preset -> perfect
  const card = sc({
    registries: { npm: 'taken' },
    domains: { dev: 'available' },
    github: { org: 'available' },
    social: { x: { status: 'available' } },
  });
  assert.equal(computeVerdict(card, { preset: 'cli-first' }).tier, 'complicated');
  assert.equal(computeVerdict(card, { preset: 'social-first' }).tier, 'complicated'); // social-first still includes npm
  const socialOnly = computeVerdict(card, { keys: [{ group: 'social', key: 'x', label: 'X' }] });
  assert.equal(socialOnly.tier, 'perfect-match');
});

console.log(`\nverdict.test.mjs: ${passed} passed`);