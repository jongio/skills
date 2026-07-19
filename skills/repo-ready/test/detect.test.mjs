/**
 * detect.test.mjs
 *
 * Tests for the stack detection module.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectStack, gitignoreTemplates, dependabotEcosystems } from '../scripts/detect-stack.mjs';

let tmpDir;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'repo-ready-detect-'));
}

function teardown() {
  rmSync(tmpDir, { recursive: true, force: true });
}

function touch(name) {
  const p = join(tmpDir, name);
  const dir = join(p, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, '', 'utf-8');
}

// Test: empty directory detects nothing
{
  setup();
  const result = detectStack(tmpDir);
  assert.deepStrictEqual(result.stacks, []);
  assert.strictEqual(result.pkgManager, null);
  assert.deepStrictEqual(result.labels, []);
  teardown();
  console.log('PASS: empty directory detects no stacks');
}

// Test: Node.js with pnpm
{
  setup();
  touch('package.json');
  touch('pnpm-lock.yaml');
  const result = detectStack(tmpDir);
  assert(result.stacks.includes('node'), 'should detect node');
  assert.strictEqual(result.pkgManager, 'pnpm');
  assert(result.labels.includes('Node.js'));
  teardown();
  console.log('PASS: detects Node.js with pnpm');
}

// Test: Node.js with npm
{
  setup();
  touch('package.json');
  touch('package-lock.json');
  const result = detectStack(tmpDir);
  assert(result.stacks.includes('node'));
  assert.strictEqual(result.pkgManager, 'npm');
  teardown();
  console.log('PASS: detects Node.js with npm');
}

// Test: TypeScript detected alongside Node.js
{
  setup();
  touch('package.json');
  touch('tsconfig.json');
  const result = detectStack(tmpDir);
  assert(result.stacks.includes('node'));
  assert(result.stacks.includes('typescript'));
  assert(result.labels.includes('TypeScript'));
  teardown();
  console.log('PASS: detects TypeScript alongside Node.js');
}

// Test: Python with pyproject.toml
{
  setup();
  touch('pyproject.toml');
  const result = detectStack(tmpDir);
  assert(result.stacks.includes('python'));
  assert.strictEqual(result.pkgManager, 'uv');
  assert(result.labels.includes('Python'));
  teardown();
  console.log('PASS: detects Python with pyproject.toml');
}

// Test: Python with requirements.txt
{
  setup();
  touch('requirements.txt');
  const result = detectStack(tmpDir);
  assert(result.stacks.includes('python'));
  assert.strictEqual(result.pkgManager, 'pip');
  teardown();
  console.log('PASS: detects Python with requirements.txt');
}

// Test: Go
{
  setup();
  touch('go.mod');
  const result = detectStack(tmpDir);
  assert(result.stacks.includes('go'));
  assert.strictEqual(result.pkgManager, 'go');
  assert(result.labels.includes('Go'));
  teardown();
  console.log('PASS: detects Go');
}

// Test: Rust
{
  setup();
  touch('Cargo.toml');
  const result = detectStack(tmpDir);
  assert(result.stacks.includes('rust'));
  assert.strictEqual(result.pkgManager, 'cargo');
  assert(result.labels.includes('Rust'));
  teardown();
  console.log('PASS: detects Rust');
}

// Test: .NET (glob match on *.csproj)
{
  setup();
  touch('MyApp.csproj');
  const result = detectStack(tmpDir);
  assert(result.stacks.includes('dotnet'));
  assert.strictEqual(result.pkgManager, 'nuget');
  assert(result.labels.includes('.NET'));
  teardown();
  console.log('PASS: detects .NET via *.csproj glob');
}

// Test: Docker
{
  setup();
  touch('Dockerfile');
  const result = detectStack(tmpDir);
  assert(result.stacks.includes('docker'));
  assert(result.labels.includes('Docker'));
  teardown();
  console.log('PASS: detects Docker');
}

// Test: multiple stacks (Node + Docker + Go)
{
  setup();
  touch('package.json');
  touch('Dockerfile');
  touch('go.mod');
  const result = detectStack(tmpDir);
  assert(result.stacks.includes('node'));
  assert(result.stacks.includes('docker'));
  assert(result.stacks.includes('go'));
  assert(result.stacks.length >= 3);
  teardown();
  console.log('PASS: detects multiple stacks');
}

// Test: gitignoreTemplates always includes OS and editor templates
{
  const templates = gitignoreTemplates([]);
  assert(templates.includes('macos'));
  assert(templates.includes('windows'));
  assert(templates.includes('linux'));
  assert(templates.includes('visualstudiocode'));
  console.log('PASS: gitignoreTemplates includes OS/editor defaults');
}

// Test: gitignoreTemplates adds stack-specific templates
{
  const templates = gitignoreTemplates(['node', 'python']);
  assert(templates.includes('node'));
  assert(templates.includes('python'));
  console.log('PASS: gitignoreTemplates adds stack templates');
}

// Test: dependabotEcosystems always includes github-actions
{
  const ecosystems = dependabotEcosystems([]);
  assert(ecosystems.includes('github-actions'));
  console.log('PASS: dependabotEcosystems always includes github-actions');
}

// Test: dependabotEcosystems adds stack ecosystems
{
  const ecosystems = dependabotEcosystems(['node', 'python', 'docker']);
  assert(ecosystems.includes('npm'));
  assert(ecosystems.includes('pip'));
  assert(ecosystems.includes('docker'));
  assert(ecosystems.includes('github-actions'));
  console.log('PASS: dependabotEcosystems adds stack ecosystems');
}

// Test: Ruby detection
{
  setup();
  touch('Gemfile');
  const result = detectStack(tmpDir);
  assert(result.stacks.includes('ruby'));
  assert.strictEqual(result.pkgManager, 'bundler');
  teardown();
  console.log('PASS: detects Ruby');
}

// Test: Java with Maven
{
  setup();
  touch('pom.xml');
  const result = detectStack(tmpDir);
  assert(result.stacks.includes('java'));
  assert.strictEqual(result.pkgManager, 'maven');
  teardown();
  console.log('PASS: detects Java with Maven');
}

// Test: Java with Gradle
{
  setup();
  touch('build.gradle');
  const result = detectStack(tmpDir);
  assert(result.stacks.includes('java'));
  assert.strictEqual(result.pkgManager, 'gradle');
  teardown();
  console.log('PASS: detects Java with Gradle');
}

console.log('\nAll detect-stack tests passed.');
