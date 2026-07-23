// test/helpers.mjs: shared mock factories for the naming-is-hard test suite.
// Keeps test files focused on assertions rather than duplicated setup.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create a temporary directory for state persistence tests. */
export function tmp(prefix = 'nih-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Build a mock HTTP response object. */
export const res = (status, headers = {}) => ({
  status,
  headers: new Map(Object.entries(headers)),
});

/** Build a mock fetch from [substring, responder] routes. Unmatched URLs 404. */
export function mockFetch(routes) {
  return async (url) => {
    for (const [needle, make] of routes) {
      if (url.includes(needle)) return make(url);
    }
    return { status: 404, headers: new Map() };
  };
}

/** A DNS resolver that reports every host as public (defeats the rebinding guard). */
export const publicResolver = async () => [{ address: '93.184.216.34' }];

/** An NS resolver that always throws ENODATA (no delegation = domain available). */
export const nsAbsent = async () => {
  throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
};

/** An NS resolver where domains in `taken` have delegation, all others are free. */
export function nsMock(taken = new Set()) {
  return async (domain) => {
    if (taken.has(domain)) return ['ns1.example.', 'ns2.example.'];
    throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  };
}
