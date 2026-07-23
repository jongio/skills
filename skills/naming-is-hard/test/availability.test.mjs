// test/availability.test.mjs: channel probes with an injected fetch. No real network.
// Run:  node test/availability.test.mjs

import assert from 'node:assert/strict';
import {
  checkDomain,
  checkDomains,
  checkGithubHandle,
  checkGithubRepo,
  checkRegistry,
  checkRegistries,
  socialChannels,
  markChannels,
  mapStatus,
  isPlausiblePublicHost,
  isPrivateAddress,
  normalizeHost,
  suggestHandleVariants,
  DEFAULT_TLDS,
  check,
  checkMany,
} from '../scripts/availability.mjs';

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

import { res, mockFetch, publicResolver, nsAbsent, nsMock } from './helpers.mjs';

// Models rdap.org realistically: it 302-redirects covered TLDs to a registry RDAP
// server (which 404s for free names, 200 for taken), and returns a DIRECT 404 for
// TLDs it does not cover. Non-RDAP URLs (github/registries) return `otherStatus`.
function rdapAwareMock({ taken = new Set(), coveredTlds, otherStatus = 404 } = {}) {
  const covered = coveredTlds || new Set(['com', 'io', 'dev', 'ai', 'app', 'co']);
  return async (url) => {
    const dm = url.match(/rdap\.org\/domain\/([a-z0-9-]+)\.([a-z]+)/);
    if (dm) {
      if (!covered.has(dm[2])) return res(404); // no coverage -> direct 404
      return res(302, { location: `https://rdap.reg.example/${dm[2]}/domain/${dm[1]}.${dm[2]}` });
    }
    const rm = url.match(/rdap\.reg\.example\/[a-z]+\/domain\/([a-z0-9-]+)\.([a-z]+)/);
    if (rm) return taken.has(`${rm[1]}.${rm[2]}`) ? res(200) : res(404);
    return res(otherStatus); // github + package registries
  };
}

// T1/T2/T3/T4: NS-first domain checks
await test('domain NS present means taken (no RDAP)', async () => {
  let rdapCalled = false;
  const status = await checkDomain('google', 'com', {
    resolveNs: nsMock(new Set(['google.com'])),
    fetchImpl: async () => {
      rdapCalled = true;
      return res(404);
    },
  });
  assert.equal(status, 'taken');
  assert.equal(rdapCalled, false, 'NS present is authoritative; RDAP not called');
});

await test('google TLDs use NS without RDAP', async () => {
  let rdapCalled = false;
  const free = await checkDomain('zqxcoined', 'dev', {
    resolveNs: nsAbsent,
    fetchImpl: async () => {
      rdapCalled = true;
      return res(404);
    },
  });
  assert.equal(free, 'available');
  assert.equal(rdapCalled, false, '.dev decides on NS alone');
  // a PARKED .dev has NS delegation -> taken (the false-positive this fixes)
  const parked = await checkDomain('parked', 'dev', { resolveNs: nsMock(new Set(['parked.dev'])) });
  assert.equal(parked, 'taken');
  // NS undetermined (disabled) -> unknown for a google TLD (no RDAP to fall back on)
  assert.equal(await checkDomain('x', 'dev', { resolveNs: null }), 'unknown');
});

await test('non-google TLD confirms NS-absent via RDAP', async () => {
  const opts = { resolveNs: nsAbsent, resolveHost: publicResolver };
  // NS absent + RDAP 404 -> available
  assert.equal(
    await checkDomain('brightloom', 'com', { ...opts, fetchImpl: rdapAwareMock() }),
    'available',
  );
  // NS absent + RDAP 200 -> taken (registered-but-not-yet-delegated edge)
  assert.equal(
    await checkDomain('edge', 'com', { ...opts, fetchImpl: rdapAwareMock({ taken: new Set(['edge.com']) }) }),
    'taken',
  );
  // NS absent + rdap.org has no coverage (direct 404) -> available (NS is authoritative)
  assert.equal(
    await checkDomain('brightloom', 'io', { ...opts, fetchImpl: rdapAwareMock({ coveredTlds: new Set(['com']) }) }),
    'available',
  );
  // NS absent + RDAP timeout/offline -> unknown (do not guess)
  assert.equal(
    await checkDomain('x', 'co', { ...opts, fetchImpl: async () => { throw new Error('offline'); } }),
    'unknown',
  );
});

await test('NS resolver errors are classified', async () => {
  // genuine NXDOMAIN (ENOTFOUND/ENODATA) -> absent -> available
  const absent = await checkDomain('zqxcoined', 'dev', {
    resolveNs: async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }); },
  });
  assert.equal(absent, 'available');
  // a transient error (timeout/servfail) is UNDETERMINED -> unknown, never a false available
  for (const code of ['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED']) {
    const status = await checkDomain('money', 'dev', {
      resolveNs: async () => { throw Object.assign(new Error(code), { code }); },
    });
    assert.equal(status, 'unknown', `${code} must be unknown, not a false available`);
  }
  // a malformed tld cannot produce a bad domain string
  assert.equal(await checkDomain('x', 'com/../secret', { resolveNs: nsAbsent, fetchImpl: async () => ({ status: 0, headers: new Map() }) }), 'unknown');
});

await test('rejects redirect to a non-public host', async () => {
  // Force NS-absent + a non-google TLD so the check reaches the RDAP redirect path.
  const base = { resolveNs: nsAbsent };
  // rdap.org tries to redirect us to an internal IP -> refused -> unknown
  const evil = await checkDomain('x', 'com', {
    ...base,
    fetchImpl: mockFetch([
      ['rdap.org', () => res(302, { location: 'https://169.254.169.254/latest' })],
    ]),
  });
  assert.equal(evil, 'unknown');

  // trailing-dot bypass is closed: metadata.google.internal. must be refused
  let reached = false;
  const trailingDot = await checkDomain('x', 'com', {
    ...base,
    fetchImpl: mockFetch([
      ['rdap.org', () => res(302, { location: 'https://metadata.google.internal./computeMetadata/v1/' })],
      ['metadata.google.internal', () => { reached = true; return res(200); }],
    ]),
  });
  assert.equal(trailingDot, 'unknown');
  assert.equal(reached, false, 'must never fetch the internal host');

  // DNS rebinding: a public-looking host that resolves to a private IP is refused
  const rebinding = await checkDomain('x', 'com', {
    ...base,
    resolveHost: async () => [{ address: '10.0.0.5' }],
    fetchImpl: mockFetch([
      ['rdap.org', () => res(302, { location: 'https://totally-normal.example/rdap' })],
      ['totally-normal.example', () => res(200)],
    ]),
  });
  assert.equal(rebinding, 'unknown');

  // syntactic guard
  assert.equal(isPlausiblePublicHost('169.254.169.254'), false);
  assert.equal(isPlausiblePublicHost('127.0.0.1'), false);
  assert.equal(isPlausiblePublicHost('10.0.0.5'), false);
  assert.equal(isPlausiblePublicHost('localhost'), false);
  assert.equal(isPlausiblePublicHost('localhost.'), false); // trailing dot
  assert.equal(isPlausiblePublicHost('metadata.google.internal.'), false);
  assert.equal(isPlausiblePublicHost('foo.internal'), false);
  assert.equal(isPlausiblePublicHost('[::1]'), false);
  assert.equal(isPlausiblePublicHost('rdap.verisign.com'), true);
  assert.equal(normalizeHost('Metadata.Google.Internal.'), 'metadata.google.internal');
});

await test('RDAP redirect failure branches degrade to unknown', async () => {
  const base = { resolveNs: nsAbsent, resolveHost: publicResolver };
  // a non-HTTPS redirect target is refused (never downgrade to http)
  assert.equal(
    await checkDomain('x', 'com', {
      ...base,
      fetchImpl: mockFetch([['rdap.org', () => res(302, { location: 'http://rdap.verisign.com/domain/x.com' })]]),
    }),
    'unknown',
  );
  // an endless redirect chain stops at the hop cap and yields unknown (no infinite loop)
  assert.equal(
    await checkDomain('x', 'com', {
      ...base,
      fetchImpl: async () => res(302, { location: 'https://rdap.verisign.com/next' }),
    }),
    'unknown',
  );
  // a redirect host whose resolver throws is treated as unsafe -> refused
  assert.equal(
    await checkDomain('x', 'com', {
      resolveNs: nsAbsent,
      resolveHost: async () => { throw new Error('dns down'); },
      fetchImpl: mockFetch([['rdap.org', () => res(302, { location: 'https://rdap.verisign.com/domain/x.com' })]]),
    }),
    'unknown',
  );
});

await test('isPlausiblePublicHost rejects obfuscated IP literals', () => {
  assert.equal(isPlausiblePublicHost('0177.0.0.1'), false); // dotted-octal
  assert.equal(isPlausiblePublicHost('0x7f.0.0.1'), false); // dotted-hex
  assert.equal(isPlausiblePublicHost('2130706433'), false); // single 32-bit integer
  assert.equal(isPlausiblePublicHost('0x7f000001'), false); // hex integer
  assert.equal(isPlausiblePublicHost('rdap.verisign.com'), true); // a real named host still passes
});

await test('isPrivateAddress classifies ranges', () => {
  for (const p of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'febf::1', 'fec0::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:0:0:1']) {
    assert.equal(isPrivateAddress(p), true, `${p} should be private`);
  }
  for (const p of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(p), false, `${p} should be public`);
  }
});

// Near-miss must be a soft caution, never a Deal Breaker (distinct real words
// sit one edit from a brand: Strive vs Stripe).
await test('near-miss is a caution, not a collision', () => {
  const nm = markChannels('Strive');
  assert.equal(nm.trademark.famous, false);
  assert.equal(nm.trademark.status, 'caution');
  assert.equal(nm.trademark.near, 'Stripe');
  assert.ok(nm.trademark.note.toLowerCase().includes('manual check'));
  assert.equal(nm.business.status, 'caution');
  // an exact hit is still a confident collision
  assert.equal(markChannels('Stripe').trademark.status, 'collision');
  // closed-form multi-word brands must stay confident collisions (regression guard)
  for (const brand of ['CocaCola', 'RedBull', 'Goldmansachs']) {
    const mc = markChannels(brand);
    assert.equal(mc.trademark.status, 'collision', `${brand} must be a collision`);
    assert.equal(mc.trademark.famous, true, `${brand} must be famous`);
  }
});

// T16: maps GitHub results
await test('maps GitHub results', async () => {
  const avail = await checkGithubHandle('brightloom', {
    fetchImpl: mockFetch([['api.github.com/users/', () => res(404)]]),
  });
  assert.equal(avail, 'available');
  const taken = await checkGithubHandle('github', {
    fetchImpl: mockFetch([['api.github.com/users/', () => res(200)]]),
  });
  assert.equal(taken, 'taken');

  // token is forwarded as a bearer header
  let seenAuth;
  await checkGithubHandle('x', {
    githubToken: 'secret-token',
    fetchImpl: async (url, init) => {
      seenAuth = init.headers.authorization;
      return res(404);
    },
  });
  assert.equal(seenAuth, 'Bearer secret-token');
});

// T17: maps registry results
await test('maps registry results', async () => {
  const npmFree = await checkRegistry('brightloom', 'npm', {
    fetchImpl: mockFetch([['registry.npmjs.org', () => res(404)]]),
  });
  assert.equal(npmFree, 'available');
  const npmTaken = await checkRegistry('react', 'npm', {
    fetchImpl: mockFetch([['registry.npmjs.org', () => res(200)]]),
  });
  assert.equal(npmTaken, 'taken');

  const all = await checkRegistries('brightloom', {
    fetchImpl: mockFetch([
      ['pypi.org', () => res(200)], // taken on pypi
      ['', () => res(404)], // free everywhere else
    ]),
  });
  assert.deepEqual(Object.keys(all).sort(), ['crates', 'npm', 'nuget', 'pypi', 'rubygems']);
  assert.equal(all.pypi, 'taken');
  assert.equal(all.npm, 'available');
});

// T18: social is best-effort with verify url
await test('social is best-effort with verify url', () => {
  const social = socialChannels('brightloom');
  for (const [platform, entry] of Object.entries(social)) {
    assert.equal(entry.status, 'unknown', `${platform} should be unknown (best-effort)`);
    assert.equal(entry.bestEffort, true);
    assert.ok(entry.url && entry.url.startsWith('https://'), `${platform} needs a verify url`);
  }
  assert.ok(social.x.url.includes('brightloom'));
});

// T19: degrades to unknown on failure
await test('degrades to unknown on failure', async () => {
  const throwing = async () => { throw new Error('boom'); };
  assert.equal(await checkRegistry('x', 'npm', { fetchImpl: throwing }), 'unknown');
  // throttled / auth statuses are unknown, never a confident value
  assert.equal(mapStatus({ status: 403 }), 'unknown');
  assert.equal(mapStatus({ status: 429 }), 'unknown');
  assert.equal(mapStatus({ status: 0 }), 'unknown');
  assert.equal(mapStatus({ status: 301, redirected: true }), 'taken');
});

// T20: builds a scorecard
await test('builds a scorecard', async () => {
  const card = await check('Brightloom', {
    resolveNs: nsAbsent,
    resolveHost: publicResolver,
    fetchImpl: rdapAwareMock(), // domains free (NS absent + RDAP 404), github + registries free
  });
  assert.equal(card.name, 'Brightloom');
  assert.equal(card.slug, 'brightloom');
  assert.ok(card.checkedAt);
  for (const group of ['trademark', 'business', 'domains', 'github', 'registries', 'social']) {
    assert.ok(card.channels[group], `missing channel group ${group}`);
  }
  assert.equal(card.channels.domains.dev, 'available'); // launch TLD is primary now
  assert.equal(card.channels.domains.com, 'available');
  assert.equal(card.channels.github.org, 'available');
  assert.equal(card.channels.registries.npm, 'available');
  assert.ok(Array.isArray(card.notes));
  assert.ok(
    card.notes.some((n) => /\.com.*available.*verify/i.test(n)),
    'surfaces the .com verification note when .com reads available',
  );

  // unusable name short-circuits
  const bad = await check('!!!', { fetchImpl: mockFetch([]) });
  assert.equal(bad.error, 'unusable-name');
});

// T28: trademark and business channels
await test('trademark and business channels', () => {
  const famous = markChannels('Spotify');
  assert.equal(famous.trademark.status, 'collision');
  assert.equal(famous.trademark.famous, true);
  assert.equal(famous.trademark.mark, 'Spotify');
  assert.equal(famous.business.famous, true);
  assert.ok(famous.trademark.links.uspto);

  const clean = markChannels('Brightloom');
  assert.equal(clean.trademark.status, 'unknown');
  assert.equal(clean.trademark.famous, false);
  assert.ok(clean.trademark.links.opencorporates.includes('Brightloom'));
});

// T29: trademark degrades to unknown, never false "clear"
await test('trademark degrades to unknown', () => {
  const clean = markChannels('Zblorptastic');
  assert.equal(clean.trademark.status, 'unknown'); // never 'clear' from the engine alone
  assert.notEqual(clean.trademark.status, 'clear');
  assert.equal(clean.business.status, 'unknown');
});

// Reconciliation: cover checkDomains (plural), checkGithubRepo, and checkMany
await test('checkDomains, checkGithubRepo, checkMany', async () => {
  const domains = await checkDomains('brightloom', {
    resolveNs: nsAbsent,
    resolveHost: publicResolver,
    fetchImpl: rdapAwareMock(),
  });
  assert.deepEqual(Object.keys(domains).sort(), ['ai', 'app', 'co', 'com', 'dev', 'io']);
  assert.ok(Object.values(domains).every((s) => s === 'available'));

  const repoFree = await checkGithubRepo('octocat', 'brightloom', {
    fetchImpl: mockFetch([['api.github.com/repos/', () => res(404)]]),
  });
  assert.equal(repoFree, 'available');
  const repoTaken = await checkGithubRepo('octocat', 'hello-world', {
    fetchImpl: mockFetch([['api.github.com/repos/', () => res(200)]]),
  });
  assert.equal(repoTaken, 'taken');
  assert.equal(await checkGithubRepo('', 'x', { fetchImpl: mockFetch([]) }), 'unknown'); // bad owner

  const many = await checkMany(['Brightloom', 'Flowly'], {
    resolveNs: nsAbsent,
    resolveHost: publicResolver,
    fetchImpl: rdapAwareMock(),
  });
  assert.equal(many.length, 2);
  assert.equal(many[0].name, 'Brightloom');
});

// T5/T7/T19: TLD order, npm tombstone, decorated variants
await test('TLD order leads with .dev', () => {
  assert.equal(DEFAULT_TLDS[0], 'dev');
  assert.ok(DEFAULT_TLDS.includes('com'));
  assert.equal(DEFAULT_TLDS[DEFAULT_TLDS.length - 1], 'com'); // .com last (low signal)
});

await test('npm tombstone is taken with a note; free vs live', async () => {
  const resBody = (status, body) => ({
    status,
    headers: new Map(),
    text: async () => body,
  });
  // tombstone: 200 with zero versions + unpublished marker
  const tomb = await checkRegistry('oldpackage', 'npm', {
    fetchImpl: async () => resBody(200, JSON.stringify({ name: 'oldpackage', versions: {}, time: { unpublished: {} } })),
  });
  assert.equal(typeof tomb, 'object');
  assert.equal(tomb.status, 'taken');
  assert.equal(tomb.tombstone, true);
  assert.ok(/tombstone/i.test(tomb.note));
  // live package: 200 with versions -> plain 'taken'
  const live = await checkRegistry('react', 'npm', {
    fetchImpl: async () => resBody(200, JSON.stringify({ name: 'react', versions: { '18.0.0': {} } })),
  });
  assert.equal(live, 'taken');
  // free -> available
  const free = await checkRegistry('zqxfree', 'npm', { fetchImpl: async () => resBody(404, '{}') });
  assert.equal(free, 'available');
});

await test('suggests decorated variants', () => {
  const v = suggestHandleVariants('Brightloom');
  assert.ok(v.includes('getbrightloom'));
  assert.ok(v.includes('brightloomhq'));
  assert.ok(v.includes('brightloomdev'));
  assert.ok(v.includes('usebrightloom'));
  assert.ok(!v.includes('brightloom')); // excludes the bare name
  assert.equal(suggestHandleVariants('!!!').length, 0);
});

await test('scorecard notes surface npm tombstone', async () => {
  const routes = async (url) => {
    if (url.includes('registry.npmjs.org')) {
      return { status: 200, headers: new Map(), text: async () => JSON.stringify({ versions: {}, time: { unpublished: {} } }) };
    }
    return rdapAwareMock()(url);
  };
  const card = await check('oldpackage', { resolveNs: nsAbsent, resolveHost: publicResolver, fetchImpl: routes });
  assert.ok(card.notes.some((n) => /tombstone/i.test(n)));
});

console.log(`\navailability.test.mjs: ${passed} passed`);
