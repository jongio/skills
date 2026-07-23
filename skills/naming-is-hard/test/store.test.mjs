// test/store.test.mjs: state persistence.
// Run:  node test/store.test.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../scripts/store.mjs';
import { score } from '../scripts/model.mjs';

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

function tmp() {
  return mkdtempSync(join(tmpdir(), 'nih-store-'));
}

// T36: round-trips full state
test('round-trips full state', () => {
  const dir = tmp();
  try {
    let state = store.defaultState();
    state = store.setBrief(state, { name: 'Acme', tone: 'playful' });
    const added = store.addCandidates(state, [
      { name: 'Brightloom', strategy: 'compound', tags: ['light'] },
      { name: 'Zapzap' },
    ]);
    state = added.state;
    assert.equal(state.candidates.length, 2);
    assert.ok(state.candidates[0].tokens.length > 0); // features extracted
    state = store.recordSwipe(state, added.added[0].id, 'like');
    state = store.recordSwipe(state, added.added[1].id, 'pass');
    state = store.setResult(state, 'Brightloom', { name: 'Brightloom', channels: {} });
    store.save(dir, state);

    const loaded = store.load(dir);
    assert.deepEqual(loaded.brief, { name: 'Acme', tone: 'playful' });
    assert.equal(loaded.candidates.length, 2);
    assert.equal(loaded.candidates[0].swipe, 'like');
    assert.equal(loaded.candidates[1].swipe, 'pass');
    assert.ok(Object.keys(loaded.weights).length > 0);
    assert.ok(loaded.results['Brightloom']);
    assert.equal(store.likedCandidates(loaded).length, 1);
    assert.equal(store.unseenCandidates(loaded).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// T37: atomic write and recovery
test('atomic write and recovery', () => {
  const dir = tmp();
  try {
    // missing file -> default state
    const fresh = store.load(dir);
    assert.equal(fresh.candidates.length, 0);
    assert.equal(fresh.version, store.STATE_VERSION);

    // save then reload
    store.save(dir, store.setBrief(fresh, { name: 'X' }));
    assert.deepEqual(store.load(dir).brief, { name: 'X' });

    // corrupt file -> recovers to default rather than throwing
    writeFileSync(store.statePath(dir), '{ not json', 'utf-8');
    const recovered = store.load(dir);
    assert.equal(recovered.candidates.length, 0);
    assert.equal(recovered.brief, null);

    // reset removes state
    store.save(dir, store.setBrief(store.defaultState(), { name: 'Y' }));
    store.reset(dir);
    assert.equal(store.load(dir).brief, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// T38: persists the brief and assigns unique ids
test('persists the brief and dedups candidates', () => {
  const dir = tmp();
  try {
    let state = store.setBrief(store.defaultState(), {
      name: 'Acme',
      what: 'a task runner',
      audience: 'devs',
      tone: 'techy',
      constraints: ['.com-able'],
    });
    // duplicate name is skipped; distinct names get unique ids
    state = store.addCandidates(state, [{ name: 'Flow' }, { name: 'Flow' }, { name: 'Flow!' }]).state;
    store.save(dir, state);
    const loaded = store.load(dir);
    assert.equal(loaded.brief.what, 'a task runner');
    assert.equal(loaded.candidates.length, 1); // "Flow" and "Flow!" slug identically
    assert.equal(loaded.candidates[0].id, 'flow');

    // unknown swipe id throws
    assert.throws(() => store.recordSwipe(loaded, 'nope', 'like'), /unknown candidate id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Re-swiping must be idempotent: no double-counting, and changing a swipe
// reflects only the new label.
test('re-swiping is idempotent', () => {
  const seeded = store.addCandidates(store.defaultState(), [{ name: 'Zap' }]);
  const state = seeded.state;
  const id = seeded.added[0].id;
  const tokens = state.candidates[0].tokens;

  const once = store.recordSwipe(state, id, 'like');
  const scoreOnce = score(once.weights, tokens);
  assert.ok(scoreOnce > 0);

  const twice = store.recordSwipe(once, id, 'like'); // repeat same label
  assert.equal(score(twice.weights, tokens), scoreOnce, 'repeat like must not double-count');

  const changed = store.recordSwipe(once, id, 'pass'); // like -> pass
  const freshPass = store.recordSwipe(state, id, 'pass');
  assert.equal(
    score(changed.weights, tokens),
    score(freshPass.weights, tokens),
    'changed swipe must reflect only the new label',
  );
  assert.ok(score(changed.weights, tokens) < 0);
  assert.equal(changed.candidates[0].swipe, 'pass');
});

console.log(`\nstore.test.mjs: ${passed} passed`);
