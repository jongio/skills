/**
 * scan.test.mjs
 *
 * Tests for the repo scanner module.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FILE_CATALOG, checkFile, scanRepo, formatReport } from '../scripts/scan-repo.mjs';

let tmpDir;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'repo-ready-scan-'));
}

function teardown() {
  rmSync(tmpDir, { recursive: true, force: true });
}

function touch(name, content = '') {
  const p = join(tmpDir, name);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf-8');
}

// Test: FILE_CATALOG has required fields on every entry
{
  for (const entry of FILE_CATALOG) {
    assert(entry.id, `entry missing id: ${JSON.stringify(entry)}`);
    assert(entry.path, `entry ${entry.id} missing path`);
    assert(typeof entry.tier === 'number', `entry ${entry.id} missing tier`);
    assert(entry.tierLabel, `entry ${entry.id} missing tierLabel`);
    assert(entry.description, `entry ${entry.id} missing description`);
    assert(entry.audience, `entry ${entry.id} missing audience`);
  }
  console.log(`PASS: FILE_CATALOG has ${FILE_CATALOG.length} entries, all with required fields`);
}

// Test: FILE_CATALOG ids are unique
{
  const ids = FILE_CATALOG.map(e => e.id);
  const unique = new Set(ids);
  assert.strictEqual(ids.length, unique.size, 'FILE_CATALOG has duplicate ids');
  console.log('PASS: FILE_CATALOG ids are unique');
}

// Test: checkFile finds primary path
{
  setup();
  touch('LICENSE', 'MIT License...');
  const entry = FILE_CATALOG.find(e => e.id === 'license');
  const result = checkFile(tmpDir, entry);
  assert(result.exists);
  assert.strictEqual(result.foundPath, 'LICENSE');
  assert(result.content.includes('MIT'));
  teardown();
  console.log('PASS: checkFile finds primary path');
}

// Test: checkFile finds alt path
{
  setup();
  touch('LICENSE.md', 'Apache 2.0...');
  const entry = FILE_CATALOG.find(e => e.id === 'license');
  const result = checkFile(tmpDir, entry);
  assert(result.exists);
  assert.strictEqual(result.foundPath, 'LICENSE.md');
  teardown();
  console.log('PASS: checkFile finds alternate path');
}

// Test: checkFile returns false for missing file
{
  setup();
  const entry = FILE_CATALOG.find(e => e.id === 'license');
  const result = checkFile(tmpDir, entry);
  assert(!result.exists);
  assert.strictEqual(result.foundPath, null);
  assert.strictEqual(result.content, null);
  teardown();
  console.log('PASS: checkFile returns false for missing file');
}

// Test: scanRepo on empty directory reports all missing
{
  setup();
  const results = scanRepo(tmpDir);
  const missing = results.filter(r => r.status === 'missing');
  const present = results.filter(r => r.status === 'present');
  assert(missing.length > 0, 'should have missing files');
  assert.strictEqual(present.length, 0, 'empty dir should have no present files');
  teardown();
  console.log('PASS: scanRepo on empty dir reports all missing');
}

// Test: scanRepo detects present files
{
  setup();
  touch('.gitignore', 'node_modules/');
  touch('LICENSE', 'MIT');
  touch('README.md', '# Hello');
  const results = scanRepo(tmpDir);
  const gitignore = results.find(r => r.id === 'gitignore');
  const license = results.find(r => r.id === 'license');
  const readme = results.find(r => r.id === 'readme');
  assert.strictEqual(gitignore.status, 'present');
  assert.strictEqual(license.status, 'present');
  assert.strictEqual(readme.status, 'present');
  teardown();
  console.log('PASS: scanRepo detects present files');
}

// Test: scanRepo finds files at alt paths
{
  setup();
  touch('.github/CONTRIBUTING.md', '# Contributing');
  const results = scanRepo(tmpDir);
  const contrib = results.find(r => r.id === 'contributing');
  assert.strictEqual(contrib.status, 'present');
  assert.strictEqual(contrib.foundPath, '.github/CONTRIBUTING.md');
  teardown();
  console.log('PASS: scanRepo finds files at alt paths');
}

// Test: scanRepo finds CI workflow at alt path
{
  setup();
  touch('.github/workflows/build.yml', 'name: Build');
  const results = scanRepo(tmpDir);
  const ci = results.find(r => r.id === 'ci-workflow');
  assert.strictEqual(ci.status, 'present');
  assert.strictEqual(ci.foundPath, '.github/workflows/build.yml');
  teardown();
  console.log('PASS: scanRepo finds CI workflow at alt path');
}

// Test: formatReport produces readable output
{
  setup();
  touch('.gitignore');
  touch('README.md', '# Test');
  const results = scanRepo(tmpDir);
  const report = formatReport(results);
  assert(report.includes('Gap Analysis'));
  assert(report.includes('Tier 1'));
  assert(report.includes('\u2705'));
  assert(report.includes('\u274c'));
  assert(report.includes('Summary'));
  teardown();
  console.log('PASS: formatReport produces readable output');
}

// Test: Tier structure is correct (1 through 5)
{
  const tiers = [...new Set(FILE_CATALOG.map(e => e.tier))].sort();
  assert.deepStrictEqual(tiers, [1, 2, 3, 4, 5], 'should have tiers 1-5');
  console.log('PASS: FILE_CATALOG has tiers 1 through 5');
}

// Test: every tier 1 entry has audience 'all'
{
  const tier1 = FILE_CATALOG.filter(e => e.tier === 1);
  for (const entry of tier1) {
    assert.strictEqual(entry.audience, 'all', `tier 1 entry ${entry.id} should have audience 'all'`);
  }
  console.log('PASS: all tier 1 entries have audience "all"');
}

console.log('\nAll scan-repo tests passed.');
