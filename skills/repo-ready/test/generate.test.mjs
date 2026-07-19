/**
 * generate.test.mjs
 *
 * Tests for the file generator module.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateGitattributes,
  generateReadme,
  generateContributing,
  generateCodeOfConduct,
  generateSecurity,
  generateBugReportTemplate,
  generateFeatureRequestTemplate,
  generateIssueTemplateConfig,
  generatePRTemplate,
  generateDependabot,
  generateCIWorkflow,
  generateCodeowners,
  generateFunding,
  generateEditorconfig,
  generateChangelog,
  safeWrite,
  generateAll,
} from '../scripts/generate.mjs';

let tmpDir;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'repo-ready-gen-'));
}

function teardown() {
  rmSync(tmpDir, { recursive: true, force: true });
}

// Test: generateGitattributes includes universal rules
{
  const content = generateGitattributes([]);
  assert(content.includes('* text=auto'));
  assert(content.includes('*.sh text eol=lf'));
  assert(content.includes('*.bat text eol=crlf'));
  assert(content.includes('*.png binary'));
  assert(content.includes('*.min.js linguist-generated'));
  console.log('PASS: gitattributes includes universal rules');
}

// Test: generateGitattributes adds node-specific linguist overrides
{
  const content = generateGitattributes(['node']);
  assert(content.includes('pnpm-lock.yaml linguist-generated'));
  assert(content.includes('package-lock.json linguist-generated'));
  assert(content.includes('yarn.lock linguist-generated'));
  console.log('PASS: gitattributes adds node linguist overrides');
}

// Test: generateGitattributes adds go-specific linguist overrides
{
  const content = generateGitattributes(['go']);
  assert(content.includes('go.sum linguist-generated'));
  console.log('PASS: gitattributes adds go linguist overrides');
}

// Test: generateReadme includes project name
{
  const content = generateReadme({ name: 'My Project', stacks: ['node'] });
  assert(content.includes('# My Project'));
  assert(content.includes('npm install'));
  assert(content.includes('CONTRIBUTING.md'));
  console.log('PASS: readme includes project name and install command');
}

// Test: generateReadme adapts install to stack
{
  const py = generateReadme({ name: 'PyTool', stacks: ['python'] });
  assert(py.includes('pip install'));

  const go = generateReadme({ name: 'GoTool', stacks: ['go'] });
  assert(go.includes('go mod download'));

  const rs = generateReadme({ name: 'RsTool', stacks: ['rust'] });
  assert(rs.includes('cargo build'));
  console.log('PASS: readme adapts install command to stack');
}

// Test: generateContributing tailors to stack
{
  const content = generateContributing({ name: 'MyLib', stacks: ['node'], pkgManager: 'pnpm' });
  assert(content.includes('pnpm install'));
  assert(content.includes('pnpm test'));
  assert(content.includes('Conventional Commits'));
  assert(content.includes('Code of Conduct'));
  console.log('PASS: contributing tailors to node/pnpm stack');
}

// Test: generateCodeOfConduct includes Contributor Covenant
{
  const content = generateCodeOfConduct({ contactEmail: 'test@example.com' });
  assert(content.includes('Contributor Covenant'));
  assert(content.includes('test@example.com'));
  assert(content.includes('Temporary Ban'));
  assert(content.includes('Permanent Ban'));
  console.log('PASS: code of conduct is Contributor Covenant v2.1');
}

// Test: generateSecurity includes contact
{
  const content = generateSecurity({ contactEmail: 'sec@example.com', name: 'MyApp' });
  assert(content.includes('sec@example.com'));
  assert(content.includes('do **not** open a public GitHub issue'));
  console.log('PASS: security policy includes contact and non-disclosure warning');
}

// Test: generateBugReportTemplate is valid YAML form
{
  const content = generateBugReportTemplate();
  assert(content.includes('name: Bug Report'));
  assert(content.includes('type: textarea'));
  assert(content.includes('required: true'));
  assert(content.includes('Code of Conduct'));
  console.log('PASS: bug report template is YAML form format');
}

// Test: generateFeatureRequestTemplate is valid YAML form
{
  const content = generateFeatureRequestTemplate();
  assert(content.includes('name: Feature Request'));
  assert(content.includes('type: textarea'));
  assert(content.includes('alternatives'));
  console.log('PASS: feature request template is YAML form format');
}

// Test: generateIssueTemplateConfig
{
  const content = generateIssueTemplateConfig({ blankIssues: false, discussionsUrl: 'https://github.com/org/repo/discussions' });
  assert(content.includes('blank_issues_enabled: false'));
  assert(content.includes('Questions and Discussions'));
  assert(content.includes('https://github.com/org/repo/discussions'));
  console.log('PASS: issue template config has correct fields');
}

// Test: generatePRTemplate
{
  const content = generatePRTemplate();
  assert(content.includes('## Description'));
  assert(content.includes('Type of Change'));
  assert(content.includes('Checklist'));
  assert(content.includes('Bug fix'));
  console.log('PASS: PR template has standard sections');
}

// Test: generateDependabot
{
  const content = generateDependabot(['npm', 'github-actions', 'docker']);
  assert(content.includes('version: 2'));
  assert(content.includes('package-ecosystem: "npm"'));
  assert(content.includes('package-ecosystem: "github-actions"'));
  assert(content.includes('package-ecosystem: "docker"'));
  assert(content.includes('interval: "weekly"'));
  console.log('PASS: dependabot config has correct ecosystems');
}

// Test: generateCIWorkflow for Node.js
{
  const content = generateCIWorkflow(['node'], { pkgManager: 'pnpm' });
  assert(content.includes('name: CI'));
  assert(content.includes('actions/checkout@v4'));
  assert(content.includes('actions/setup-node@v4'));
  assert(content.includes('pnpm/action-setup@v4'));
  assert(content.includes('pnpm install --frozen-lockfile'));
  assert(content.includes('pnpm test'));
  console.log('PASS: CI workflow generated for Node.js with pnpm');
}

// Test: generateCIWorkflow for Python
{
  const content = generateCIWorkflow(['python']);
  assert(content.includes('actions/setup-python@v5'));
  assert(content.includes('pytest'));
  console.log('PASS: CI workflow generated for Python');
}

// Test: generateCIWorkflow for Go
{
  const content = generateCIWorkflow(['go']);
  assert(content.includes('actions/setup-go@v5'));
  assert(content.includes('go build'));
  assert(content.includes('go test'));
  console.log('PASS: CI workflow generated for Go');
}

// Test: generateCIWorkflow for Rust
{
  const content = generateCIWorkflow(['rust']);
  assert(content.includes('cargo build'));
  assert(content.includes('cargo test'));
  assert(content.includes('cargo fmt'));
  assert(content.includes('cargo clippy'));
  console.log('PASS: CI workflow generated for Rust');
}

// Test: generateCIWorkflow returns null for unknown stack
{
  const content = generateCIWorkflow(['unknown-stack']);
  assert.strictEqual(content, null);
  console.log('PASS: CI workflow returns null for unknown stack');
}

// Test: generateCodeowners with entries
{
  const content = generateCodeowners([
    { pattern: '*', owners: ['@octocat'] },
    { pattern: '/docs/', owners: ['@docs-team'] },
  ]);
  assert(content.includes('*  @octocat'));
  assert(content.includes('/docs/  @docs-team'));
  console.log('PASS: codeowners has correct entries');
}

// Test: generateCodeowners with empty entries
{
  const content = generateCodeowners([]);
  assert(content.includes('* @OWNER'));
  console.log('PASS: codeowners defaults to * @OWNER');
}

// Test: generateFunding
{
  const content = generateFunding({ github: ['octocat'], ko_fi: 'octocat' });
  assert(content.includes('github: ["octocat"]'));
  assert(content.includes('ko_fi: octocat'));
  console.log('PASS: funding config has correct platforms');
}

// Test: generateEditorconfig includes universal rules
{
  const content = generateEditorconfig([]);
  assert(content.includes('root = true'));
  assert(content.includes('charset = utf-8'));
  assert(content.includes('indent_style = space'));
  assert(content.includes('indent_size = 2'));
  assert(content.includes('Makefile'));
  console.log('PASS: editorconfig includes universal rules');
}

// Test: generateEditorconfig adds python overrides
{
  const content = generateEditorconfig(['python']);
  assert(content.includes('[*.{py,pyi}]'));
  assert(content.includes('indent_size = 4'));
  console.log('PASS: editorconfig adds python indent override');
}

// Test: generateEditorconfig adds go overrides
{
  const content = generateEditorconfig(['go']);
  assert(content.includes('[*.go]'));
  assert(content.includes('indent_style = tab'));
  console.log('PASS: editorconfig adds go tab override');
}

// Test: generateChangelog
{
  const content = generateChangelog({ name: 'TestProject' });
  assert(content.includes('# Changelog'));
  assert(content.includes('Keep a Changelog'));
  assert(content.includes('Semantic Versioning'));
  assert(content.includes('[Unreleased]'));
  console.log('PASS: changelog has correct format');
}

// Test: safeWrite creates file with parent dirs
{
  setup();
  const p = join(tmpDir, 'a', 'b', 'c.txt');
  const created = safeWrite(p, 'hello');
  assert(created);
  assert(existsSync(p));
  assert.strictEqual(readFileSync(p, 'utf-8'), 'hello');
  teardown();
  console.log('PASS: safeWrite creates file with nested parent dirs');
}

// Test: safeWrite does not overwrite without force
{
  setup();
  const p = join(tmpDir, 'existing.txt');
  writeFileSync(p, 'original', 'utf-8');
  const created = safeWrite(p, 'new content');
  assert(!created, 'should not overwrite');
  assert.strictEqual(readFileSync(p, 'utf-8'), 'original');
  teardown();
  console.log('PASS: safeWrite does not overwrite without force');
}

// Test: safeWrite overwrites with force
{
  setup();
  const p = join(tmpDir, 'existing.txt');
  writeFileSync(p, 'original', 'utf-8');
  const created = safeWrite(p, 'new content', { force: true });
  assert(created);
  assert.strictEqual(readFileSync(p, 'utf-8'), 'new content');
  teardown();
  console.log('PASS: safeWrite overwrites with force');
}

// Test: generateAll creates files in target directory
{
  setup();
  const results = await generateAll(tmpDir, {
    stacks: ['node'],
    license: 'mit',
    owner: 'Test User',
    year: 2026,
    name: 'test-project',
    cocContact: 'test@example.com',
    securityContact: 'sec@example.com',
    pkgManager: 'npm',
  });

  assert(results.length > 0, 'should create files');
  const created = results.filter(r => r.created);
  assert(created.length > 10, `should create many files, got ${created.length}`);

  // Verify key files exist
  assert(existsSync(join(tmpDir, '.gitignore')), '.gitignore should exist');
  assert(existsSync(join(tmpDir, '.gitattributes')), '.gitattributes should exist');
  assert(existsSync(join(tmpDir, 'LICENSE')), 'LICENSE should exist');
  assert(existsSync(join(tmpDir, 'README.md')), 'README.md should exist');
  assert(existsSync(join(tmpDir, 'CONTRIBUTING.md')), 'CONTRIBUTING.md should exist');
  assert(existsSync(join(tmpDir, 'CODE_OF_CONDUCT.md')), 'CODE_OF_CONDUCT.md should exist');
  assert(existsSync(join(tmpDir, 'SECURITY.md')), 'SECURITY.md should exist');
  assert(existsSync(join(tmpDir, '.github/ISSUE_TEMPLATE/bug_report.yml')), 'bug report template should exist');
  assert(existsSync(join(tmpDir, '.github/ISSUE_TEMPLATE/feature_request.yml')), 'feature request template should exist');
  assert(existsSync(join(tmpDir, '.github/PULL_REQUEST_TEMPLATE.md')), 'PR template should exist');
  assert(existsSync(join(tmpDir, '.github/dependabot.yml')), 'dependabot.yml should exist');
  assert(existsSync(join(tmpDir, '.github/workflows/ci.yml')), 'CI workflow should exist');
  assert(existsSync(join(tmpDir, '.editorconfig')), '.editorconfig should exist');
  assert(existsSync(join(tmpDir, 'CHANGELOG.md')), 'CHANGELOG.md should exist');

  teardown();
  console.log('PASS: generateAll creates all expected files');
}

// Test: generateAll respects skip set
{
  setup();
  const results = await generateAll(tmpDir, {
    stacks: ['node'],
    license: 'mit',
    owner: 'Test',
    name: 'test',
    skip: new Set(['license', 'contributing', 'code-of-conduct']),
  });

  assert(!existsSync(join(tmpDir, 'LICENSE')), 'LICENSE should be skipped');
  assert(!existsSync(join(tmpDir, 'CONTRIBUTING.md')), 'CONTRIBUTING should be skipped');
  assert(!existsSync(join(tmpDir, 'CODE_OF_CONDUCT.md')), 'CODE_OF_CONDUCT should be skipped');
  assert(existsSync(join(tmpDir, '.gitignore')), '.gitignore should still exist');

  teardown();
  console.log('PASS: generateAll respects skip set');
}

// Test: generateAll does not overwrite existing files
{
  setup();
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'README.md'), '# My Custom README\n', 'utf-8');

  const results = await generateAll(tmpDir, {
    stacks: ['node'],
    license: 'mit',
    owner: 'Test',
    name: 'test',
  });

  const readmeResult = results.find(r => r.path === 'README.md');
  assert(!readmeResult.created, 'README should not be overwritten');
  assert.strictEqual(readmeResult.skipped, 'already exists');
  assert.strictEqual(readFileSync(join(tmpDir, 'README.md'), 'utf-8'), '# My Custom README\n');

  teardown();
  console.log('PASS: generateAll does not overwrite existing files');
}

console.log('\nAll generate tests passed.');
