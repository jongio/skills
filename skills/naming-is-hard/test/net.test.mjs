// test/net.test.mjs: the security boundary: slug sanitization, host allowlist,
// timeout, and redirect guarding. No real network; fetch is injected.
// Run:  node test/net.test.mjs

import assert from 'node:assert/strict';
import {
  slugify,
  isUsableName,
  isAllowedHost,
  safeFetch,
  mapWithConcurrency,
  ALLOWED_HOSTS,
} from '../scripts/net.mjs';

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

// T21: sanitizes names to a safe slug
await test('sanitizes names to a safe slug', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  Spaced  Out  '), 'spaced-out');
  assert.equal(slugify('café Déjà'), 'cafe-deja'); // unicode folded
  assert.equal(slugify('a.b.c'), 'a-b-c');
  assert.equal(slugify('UPPER_snake.Case'), 'upper-snake-case');
  assert.equal(slugify('--edge--'), 'edge'); // no leading/trailing hyphen
  assert.equal(slugify('a!!!b'), 'a-b'); // runs collapse to single hyphen
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(42), '');
  // length cap keeps it <= 64 and never ends in a hyphen
  const long = slugify('x'.repeat(200));
  assert.ok(long.length <= 64);
  assert.ok(!long.endsWith('-'));
});

// T21b: isUsableName
await test('isUsableName rejects unslug-able input', () => {
  assert.equal(isUsableName('good-name'), true);
  assert.equal(isUsableName('   '), false);
  assert.equal(isUsableName('!!!'), false);
  assert.equal(isUsableName(''), false);
});

// T22: a hostile name cannot produce an off-allowlist URL
await test('rejects host escapes', () => {
  // Whatever a hostile name is, the slug is pure [a-z0-9-]: it cannot contain
  // '/', '@', ':', or '.', so it cannot alter the host when placed in a path.
  for (const evil of [
    '../../../etc/passwd',
    '@evil.com',
    'javascript:alert(1)',
    'foo/../../secret',
    'a b.evil.com',
    'name#fragment?q=1',
    'http://169.254.169.254/latest',
  ]) {
    const slug = slugify(evil);
    assert.ok(/^[a-z0-9-]*$/.test(slug), `slug not safe for: ${evil} -> ${slug}`);
    assert.ok(!slug.includes('/'));
    assert.ok(!slug.includes('@'));
    assert.ok(!slug.includes('.'));
    assert.ok(!slug.includes(':'));
  }
});

// T23: enforces host allowlist
await test('enforces host allowlist', async () => {
  assert.equal(isAllowedHost('api.github.com'), true);
  assert.equal(isAllowedHost('API.GitHub.com'), true); // case-insensitive
  assert.equal(isAllowedHost('evil.com'), false);
  assert.equal(isAllowedHost('api.github.com.evil.com'), false); // no suffix games

  // A non-allowlisted host throws before any fetch is attempted.
  let called = false;
  const spyFetch = async () => {
    called = true;
    return { status: 200, headers: new Map() };
  };
  await assert.rejects(
    () => safeFetch('https://evil.com/x', { fetchImpl: spyFetch }),
    /host not allowed/,
  );
  assert.equal(called, false, 'fetch must not run for a disallowed host');

  // Non-https is refused too.
  await assert.rejects(
    () => safeFetch('http://api.github.com/x', { fetchImpl: spyFetch }),
    /non-https/,
  );
});

// T24: times out and guards redirects
await test('times out and guards redirects', async () => {
  // Timeout: a fetch that rejects on abort comes back as status 0 (unknown),
  // never throws out of safeFetch.
  const hangingFetch = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(new Error('aborted')),
      );
    });
  const timedOut = await safeFetch('https://api.github.com/users/x', {
    fetchImpl: hangingFetch,
    timeoutMs: 20,
  });
  assert.equal(timedOut.status, 0);
  assert.equal(timedOut.ok, false);

  // Redirect: safeFetch requests redirect:'manual' and reports the 3xx without
  // following it.
  let seenInit;
  const redirectingFetch = async (url, init) => {
    seenInit = init;
    return { status: 301, headers: new Map([['location', 'https://evil.com/']]) };
  };
  const r = await safeFetch('https://registry.npmjs.org/foo', {
    fetchImpl: redirectingFetch,
  });
  assert.equal(seenInit.redirect, 'manual');
  assert.equal(r.status, 301);
  assert.equal(r.redirected, true);
});

// mapWithConcurrency preserves order and caps parallelism
await test('mapWithConcurrency preserves order and caps parallelism', async () => {
  let active = 0;
  let maxActive = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = await mapWithConcurrency(items, 3, async (n) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(maxActive <= 3, `concurrency exceeded: ${maxActive}`);
});

await test('ALLOWED_HOSTS is frozen and covers the probed registries', () => {
  assert.ok(Object.isFrozen(ALLOWED_HOSTS));
  for (const h of ['rdap.org', 'api.github.com', 'registry.npmjs.org', 'pypi.org']) {
    assert.ok(ALLOWED_HOSTS.includes(h), `missing ${h}`);
  }
});

console.log(`\nnet.test.mjs: ${passed} passed`);
