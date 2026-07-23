#!/usr/bin/env node
/**
 * smoke.mjs: a REAL-network availability check, run on demand (never in CI).
 *
 * The unit tests inject a mock fetch and never touch the network. This script is
 * the opposite: it exercises the live endpoints (RDAP, GitHub, registries) so you
 * can sanity-check that the real services still behave as the mappers expect.
 *
 * Usage:
 *   node scripts/smoke.mjs <name> [<name> ...]
 *   GITHUB_TOKEN=ghp_xxx node scripts/smoke.mjs myidea   # higher GitHub rate limit
 */

import { check } from './availability.mjs';
import { computeVerdict } from './verdict.mjs';

const names = process.argv.slice(2);
if (!names.length) {
  console.error('usage: node scripts/smoke.mjs <name> [<name> ...]');
  process.exit(1);
}

for (const name of names) {
  const card = await check(name, { githubToken: process.env.GITHUB_TOKEN });
  const verdict = computeVerdict(card);
  console.log(`\n${verdict.emoji} ${name}: ${verdict.label}`);
  console.log(`   ${verdict.reason}`);
  if (card.channels?.domains) {
    console.log('   domains:', JSON.stringify(card.channels.domains));
  }
  if (card.channels?.github) {
    console.log('   github :', JSON.stringify(card.channels.github));
  }
  if (card.channels?.registries) {
    console.log('   npm/pypi/…:', JSON.stringify(card.channels.registries));
  }
}
