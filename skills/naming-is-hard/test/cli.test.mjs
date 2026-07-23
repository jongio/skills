// test/cli.test.mjs: the engine CLI wiring, driven programmatically with an
// injected fetch (no network).
// Run:  node test/cli.test.mjs

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  parseArgs,
  runInit,
  runBrief,
  runAdd,
  runNext,
  runSwipe,
  runRank,
  runProfile,
  runSuggest,
  runCheck,
  runScreen,
  runVariants,
  runSimilar,
  runDuel,
  runReport,
  runState,
  runReset,
  main,
} from '../scripts/naming.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

import { tmp as makeTmp, res, publicResolver, nsAbsent, nsMock } from './helpers.mjs';

function tmp() {
  return makeTmp('nih-cli-');
}

// Models rdap.org's redirect behavior so "available" domains come via a redirect
// (a direct rdap.org 404 means "no RDAP coverage" -> unknown, not available).
function rdapAwareMock({ taken = new Set() } = {}) {
  return async (url) => {
    const dm = url.match(/rdap\.org\/domain\/([a-z0-9-]+)\.([a-z]+)/);
    if (dm) return res(302, { location: `https://rdap.reg.example/${dm[2]}/${dm[1]}.${dm[2]}` });
    const rm = url.match(/rdap\.reg\.example\/[a-z]+\/([a-z0-9-]+)\.([a-z]+)/);
    if (rm) return taken.has(`${rm[1]}.${rm[2]}`) ? res(200) : res(404);
    return res(404); // github + registries free
  };
}

test('parseArgs splits flags and positionals', () => {
  const { positional, flags } = parseArgs(['add', '--dir', 'd', '--json', '[]', '--as-json']);
  assert.deepEqual(positional, ['add']);
  assert.equal(flags.dir, 'd');
  assert.equal(flags.json, '[]');
  assert.equal(flags['as-json'], true);
});

// T39: add stores candidates with features
await test('add stores candidates with features', () => {
  const dir = tmp();
  try {
    runInit({ dir, 'brief-json': JSON.stringify({ name: 'Acme', tone: 'techy' }) });
    const added = runAdd({
      dir,
      items: [
        { name: 'Brightloom', strategy: 'compound' },
        { name: 'Zapzap', strategy: 'reduplication' },
        { name: 'Flowly', strategy: 'suffix' },
      ],
    });
    assert.equal(added.total, 3);
    assert.equal(added.added.length, 3);
    const state = runState({ dir });
    assert.ok(state.candidates.every((c) => c.tokens.length > 0));
    assert.ok(state.brief.name === 'Acme');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// T40: swipe then next reflects learning
await test('swipe then next reflects learning', () => {
  const dir = tmp();
  try {
    runInit({ dir });
    runAdd({
      dir,
      items: [
        { name: 'Zap' },
        { name: 'Kex' },
        { name: 'Willowmeadow' },
        { name: 'Gentlebrook' },
        { name: 'Vex' },
      ],
    });
    // like the short/hard names, pass the long/soft ones
    runSwipe({ dir, id: 'zap', label: 'like' });
    runSwipe({ dir, id: 'kex', label: 'like' });
    const afterPass = runSwipe({ dir, id: 'willowmeadow', label: 'pass' });
    assert.ok(afterPass.profile.hasSignal);
    assert.equal(afterPass.swiped, 3);

    // next never returns a swiped card
    const { cards } = runNext({ dir, count: 2 });
    const swipedIds = ['zap', 'kex', 'willowmeadow'];
    for (const card of cards) assert.ok(!swipedIds.includes(card.id));

    // profile reflects a learned type
    const prof = runProfile({ dir });
    assert.ok(prof.hasSignal);
    assert.ok(prof.summary.length > 0);

    // rank puts an unseen liked-type name (Vex) above a passed-type name
    const { ranked } = runRank({ dir });
    const vex = ranked.findIndex((r) => r.id === 'vex');
    const gentle = ranked.findIndex((r) => r.id === 'gentlebrook');
    assert.ok(vex < gentle, 'liked-type should rank above passed-type');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// T41: check and report produce output
await test('check and report produce output', async () => {
  const dir = tmp();
  try {
    runInit({ dir });
    runAdd({ dir, items: [{ name: 'Brightloom' }, { name: 'Flowly' }] });
    // Brightloom is free everywhere; Flowly's .dev (a key channel) is taken.
    const checked = await runCheck({
      dir,
      names: 'Brightloom,Flowly',
      resolveNs: nsMock(new Set(['flowly.dev'])),
      resolveHost: publicResolver,
      fetchImpl: rdapAwareMock(),
    });
    assert.equal(checked.scorecards.length, 2);

    const report = runReport({ dir, names: 'Brightloom,Flowly' });
    assert.ok(report.text.includes('Winner'));
    assert.ok(report.text.includes('Brightloom'));
    assert.equal(report.winner.name, 'Brightloom'); // perfect match beats complicated
    const brightloom = report.ranked.find((r) => r.name === 'Brightloom');
    const flowly = report.ranked.find((r) => r.name === 'Flowly');
    assert.equal(brightloom.verdict.tier, 'perfect-match');
    assert.equal(flowly.verdict.tier, 'complicated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// T42: reset and unknown-command handling
await test('reset and unknown-command handling', async () => {
  const dir = tmp();
  try {
    runInit({ dir, 'brief-json': JSON.stringify({ name: 'Acme' }) });
    assert.ok(runState({ dir }).brief);
    runReset({ dir });
    assert.equal(runState({ dir }).brief, null); // cleared

    // unknown command sets a non-zero exit code
    const prev = process.exitCode;
    process.exitCode = 0;
    await main(['definitely-not-a-command']);
    assert.equal(process.exitCode, 1);
    process.exitCode = prev || 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Reconciliation: runBrief, runSuggest, and the no-winner / no-finalists report branches
await test('runBrief, runSuggest, and report edge branches', async () => {
  const dir = tmp();
  try {
    runInit({ dir });
    runBrief({ dir, json: JSON.stringify({ name: 'Zed', what: 'a shell' }) });
    assert.equal(runState({ dir }).brief.name, 'Zed');

    const sug = runSuggest({ name: 'Flow' });
    assert.ok(sug.variants.includes('Flowly'));

    // no finalists yet (nothing checked) -> report says so
    const empty = runReport({ dir });
    assert.ok(empty.text.includes('No finalists'));

    // all Deal Breakers -> no crowned winner
    runAdd({ dir, items: [{ name: 'Spotify' }, { name: 'Nike' }] });
    const mock = async () => res(404); // channels free, but famous marks force Deal Breaker
    await runCheck({ dir, names: 'Spotify,Nike', resolveNs: nsAbsent, fetchImpl: mock });
    const report = runReport({ dir, names: 'Spotify,Nike' });
    assert.equal(report.winner, null);
    assert.ok(report.text.includes('No clean winner'));
    assert.ok(report.ranked.every((r) => r.verdict.tier === 'deal-breaker'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// T20/T21/T22/T25: new commands (screen, variants, similar, duel)
await test('screen buckets by key channels', async () => {
  const dir = tmp();
  try {
    runInit({ dir });
    // Brightloom free everywhere -> clear; Flowly .dev taken -> contested; Spotify -> blocked
    const out = await runScreen({
      dir,
      names: 'Brightloom,Flowly,Spotify',
      resolveNs: nsMock(new Set(['flowly.dev'])),
      resolveHost: publicResolver,
      fetchImpl: rdapAwareMock(),
    });
    assert.ok(out.buckets.clear.includes('Brightloom'));
    assert.ok(out.buckets.contested.includes('Flowly'));
    assert.ok(out.buckets.blocked.includes('Spotify'));
    assert.equal(out.preset, 'cli-first');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('variants command checks decorated forms', async () => {
  // getbrightloom github taken, everything else free
  const mock = async (url) => {
    if (url.includes('api.github.com/users/getbrightloom')) return res(200);
    return res(404);
  };
  const out = await runVariants({ name: 'Brightloom', resolveNs: nsAbsent, resolveHost: publicResolver, fetchImpl: mock });
  assert.ok(out.variants.length > 0);
  const getbrightloom = out.variants.find((v) => v.name === 'getbrightloom');
  assert.equal(getbrightloom.github, 'taken');
  const brightloomhq = out.variants.find((v) => v.name === 'brightloomhq');
  assert.equal(brightloomhq.github, 'available');
  assert.ok('npm' in brightloomhq && 'dev' in brightloomhq);
});

test('similar command reports collisions', () => {
  const out = runSimilar({ name: 'alphacore', against: 'corealpha,react,beacons' });
  assert.ok(out.collisions.length >= 1);
  assert.equal(out.collisions[0].other, 'corealpha'); // strongest collision first
  assert.throws(() => runSimilar({ name: 'x' }), /--against/);
});

await test('duel command records result', () => {
  const dir = tmp();
  try {
    runInit({ dir });
    runAdd({ dir, items: [{ name: 'Zap' }, { name: 'Willowmeadow' }] });
    const out = runDuel({ dir, winner: 'zap', loser: 'willowmeadow' });
    assert.equal(out.winner, 'Zap');
    assert.equal(out.loser, 'Willowmeadow');
    assert.ok(out.profile.hasSignal);
    assert.throws(() => runDuel({ dir, winner: 'nope', loser: 'zap' }), /unknown winner/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('CLI handlers reject missing required inputs', async () => {
  await assert.rejects(runScreen({}), /--names/); // screen needs --names
  await assert.rejects(runVariants({}), /--name/); // variants needs --name
  assert.throws(() => runSimilar({}), /--name/); // similar needs --name
  const dir = tmp();
  try {
    runInit({ dir });
    assert.throws(() => runDuel({ dir }), /--winner/); // duel needs --winner/--loser ids
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\ncli.test.mjs: ${passed} passed`);
