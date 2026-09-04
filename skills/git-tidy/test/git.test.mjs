import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import * as gitApi from '../scripts/lib/git.mjs';
import {
  GitBoundary,
  GitBoundaryError,
  assertReadOnlyGitArgs,
  checkNodeCapability,
  createGitBoundary,
  displayRawBytes,
  encodeRawPath,
  hashFilesystemEntry,
  parseBranchRefs,
  parseFixedNulRecords,
  parseReplacementRefs,
  resolveExecutablePath,
  runBoundedProcess,
  validateObjectFormat,
  validateOid,
} from '../scripts/lib/git.mjs';
import { findUntrustedRepositoryRoot } from '../scripts/lib/git-process.mjs';
import {
  cleanupRepoFixtures,
  createRepoFixture,
} from './helpers/repo-fixture.mjs';

after(cleanupRepoFixtures);

test('facade preserves the complete Git boundary public API', () => {
  assert.deepEqual(Object.keys(gitApi), [
    'DEFAULT_PROCESS_LIMITS',
    'GitBoundary',
    'GitBoundaryError',
    'assertReadOnlyGitArgs',
    'checkNodeCapability',
    'createGitBoundary',
    'displayRawBytes',
    'encodeRawPath',
    'hashFilesystemEntry',
    'parseBranchRefs',
    'parseFixedNulRecords',
    'parseReplacementRefs',
    'resolveExecutablePath',
    'runBoundedProcess',
    'validateObjectFormat',
    'validateOid',
  ]);
});

test('process boundary rejects malformed options and spawn failures', async () => {
  for (const options of [
    { timeoutMs: -1 },
    { maxStdoutBytes: -1 },
    { maxStderrBytes: Number.MAX_SAFE_INTEGER + 1 },
    { input: {} },
  ]) {
    assert.throws(() => runBoundedProcess(process.execPath, [], options), TypeError);
  }
  assert.throws(() => runBoundedProcess(process.execPath, ["bad\0arg"]), TypeError);
  await rejectsCode(
    runBoundedProcess(path.join(tmpdir(), "definitely-missing-executable"), []),
    "SPAWN_FAILED",
  );
  const controller = new AbortController();
  controller.abort();
  await rejectsCode(
    runBoundedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      signal: controller.signal,
    }),
    "CANCELLED",
  );
});

test('filesystem hashing rejects unsupported and bounded entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), "git-tidy-hash-errors-"));
  try {
    await assert.rejects(
      hashFilesystemEntry(root),
      (error) => error.code === "UNSUPPORTED_FILE_TYPE",
    );
    const file = path.join(root, "large");
    await writeFile(file, "large");
    await assert.rejects(
      hashFilesystemEntry(file, { maxBytes: 1 }),
      (error) => error.code === "HASH_LIMIT",
    );
    const link = path.join(root, "link");
    await symlink("large", link);
    await assert.rejects(
      hashFilesystemEntry(link, { maxBytes: 1 }),
      (error) => error.code === "HASH_LIMIT",
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      hashFilesystemEntry(file, { signal: controller.signal }),
      (error) => error.code === "CANCELLED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolves executables only from absolute PATH directories', () => {
  const resolved = resolveExecutablePath(process.execPath);
  assert.equal(path.isAbsolute(resolved), true);
  assert.throws(
    () => resolveExecutablePath(process.execPath, {
      untrustedRoots: [path.dirname(process.execPath)],
    }),
    (error) => error.code === 'UNTRUSTED_EXECUTABLE',
  );
  assert.throws(
    () => resolveExecutablePath(`missing-${Date.now()}`, {
      env: { PATH: `.${path.delimiter}` },
    }),
    (error) => error.code === 'EXECUTABLE_NOT_FOUND',
  );
  assert.throws(
    () => runBoundedProcess('node', ['--version']),
    /absolute path/u,
  );
});

test('rejects executables from dependency-managed PATH directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'git-tidy-executable-'));
  const externalBin = path.join(root, 'external-bin');
  const dependencyBin = path.join(root, 'repo', 'node_modules', '.bin');
  const executable = path.join(externalBin, path.basename(process.execPath));
  const canonicalDependencyBin = path.join(root, 'deps', 'node_modules', '.bin');
  const aliasBin = path.join(root, 'alias-bin');
  try {
    await mkdir(externalBin, { recursive: true });
    await mkdir(path.dirname(dependencyBin), { recursive: true });
    await mkdir(canonicalDependencyBin, { recursive: true });
    await copyFile(process.execPath, executable);
    await chmod(executable, 0o755);
    await symlink(
      externalBin,
      dependencyBin,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.throws(
      () => resolveExecutablePath(path.basename(executable), {
        env: { ...process.env, PATH: dependencyBin },
      }),
      (error) => error.code === 'UNTRUSTED_EXECUTABLE',
    );

    const dependencyExecutable =
      path.join(canonicalDependencyBin, path.basename(process.execPath));
    await copyFile(process.execPath, dependencyExecutable);
    await chmod(dependencyExecutable, 0o755);
    await symlink(
      canonicalDependencyBin,
      aliasBin,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.throws(
      () => resolveExecutablePath(path.basename(dependencyExecutable), {
        env: { ...process.env, PATH: aliasBin },
      }),
      (error) => error.code === 'UNTRUSTED_EXECUTABLE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repository boundary discovery protects sibling paths from nested invocations', async () => {
  const container = await mkdtemp(path.join(tmpdir(), 'git-tidy-root-'));
  const root = path.join(container, 'repo');
  const nested = path.join(root, 'src', 'nested');
  const toolDir = path.join(root, 'tools');
  const executable = path.join(toolDir, path.basename(process.execPath));
  const alias = path.join(container, 'nested-alias');
  try {
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(nested, { recursive: true });
    await mkdir(toolDir, { recursive: true });
    await copyFile(process.execPath, executable);
    await chmod(executable, 0o755);
    await symlink(
      nested,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.equal(findUntrustedRepositoryRoot(alias), await realpath(root));
    assert.throws(
      () => new GitBoundary(alias, { gitPath: executable }),
      (error) => error.code === 'UNTRUSTED_EXECUTABLE',
    );
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

function blobOid(format, bytes) {
  return createHash(format)
    .update(Buffer.from(`blob ${bytes.length}\0`, 'ascii'))
    .update(bytes)
    .digest('hex');
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof GitBoundaryError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('validates supported object formats and full lowercase OIDs', () => {
  assert.equal(validateObjectFormat('sha1'), 'sha1');
  assert.equal(validateObjectFormat('sha256'), 'sha256');
  assert.equal(validateOid('a'.repeat(40), 'sha1'), 'a'.repeat(40));
  assert.equal(validateOid('0'.repeat(64), 'sha256'), '0'.repeat(64));
  assert.throws(
    () => validateObjectFormat('md5'),
    (error) => error.code === 'UNSUPPORTED_OBJECT_FORMAT',
  );
  for (const oid of ['A'.repeat(40), 'a'.repeat(39), 'z'.repeat(40)]) {
    assert.throws(
      () => validateOid(oid, 'sha1'),
      (error) => error.code === 'INVALID_OID',
    );
  }
});

test('parses fixed NUL fields as bytes and rejects damaged framing', () => {
  const raw = Buffer.from([
    0xff, 0x1b, 0x00, 0x61, 0x00, 0x0a,
    0x62, 0x00, 0x63, 0x00, 0x0a,
  ]);
  assert.deepEqual(
    parseFixedNulRecords(raw, 2),
    [
      [Buffer.from([0xff, 0x1b]), Buffer.from('a')],
      [Buffer.from('b'), Buffer.from('c')],
    ],
  );
  assert.deepEqual(parseFixedNulRecords(Buffer.alloc(0), 3), []);
  const malformed = [
    Buffer.from('a\0b'),
    Buffer.from('a\0b\0'),
    Buffer.from('a\0b\0\r\n'),
    Buffer.from('a\0b\0\0\n'),
    Buffer.from('a\0b\0\ntrailing'),
  ];
  for (const input of malformed) {
    assert.throws(
      () => parseFixedNulRecords(input, 2),
      (error) => error.code === 'MALFORMED_GIT_OUTPUT',
    );
  }
});

test('preserves raw ref and path identity while control-cleaning display text', () => {
  const oid = 'a'.repeat(40);
  const ref = Buffer.from([0x72, 0x65, 0x66, 0x73, 0x2f, 0xff, 0x1b]);
  const framed = Buffer.concat([
    ref, Buffer.from([0]),
    Buffer.from(oid), Buffer.from([0]),
    Buffer.from('commit\0\n'),
  ]);
  const [record] = parseReplacementRefs(framed, 'sha1');
  assert.deepEqual(record.refRaw, ref);
  assert.equal(record.refRawBase64, ref.toString('base64'));
  assert.doesNotMatch(record.displayName, /[\u0000-\u001f]/u);

  const pathBytes = Buffer.from('line\n\u202epath', 'utf8');
  assert.deepEqual(encodeRawPath(pathBytes), {
    rawBase64: pathBytes.toString('base64'),
    display: 'line\uFFFD\uFFFDpath',
  });
  assert.equal(displayRawBytes(Buffer.from('normal')), 'normal');

  assert.throws(
    () => parseReplacementRefs(
      Buffer.from(`refs/x\0${oid}\0unknown\0\n`),
      'sha1',
    ),
    (error) => error.code === 'MALFORMED_GIT_OUTPUT',
  );
});

test('branch records permit only an empty upstream field', () => {
  const oid = 'b'.repeat(40);
  const records = parseBranchRefs(
    Buffer.from(`refs/heads/main\0${oid}\0commit\0\0\n`),
    'sha1',
  );
  assert.equal(records[0].upstreamRaw.length, 0);
  assert.equal(records[0].oid, oid);
  assert.throws(
    () => parseBranchRefs(Buffer.from(`\0${oid}\0commit\0\0\n`), 'sha1'),
    (error) => error.code === 'MALFORMED_GIT_OUTPUT',
  );
});

test('runs binary-safe argv without shell interpolation', async () => {
  const fixture = await createRepoFixture('no-shell');
  try {
    const injected = path.join(fixture.root, 'injected.txt');
    const hostile = `literal & echo injected>${injected}`;
    const result = await runBoundedProcess(process.execPath, [
      '-e', 'process.stdout.write(process.argv[1])', hostile,
    ]);
    assert.deepEqual(result.stdout, Buffer.from(hostile));
    await assert.rejects(access(injected));
  } finally {
    await fixture.cleanup();
  }
});

test('enforces stdout and stderr byte limits before decoding', async () => {
  await rejectsCode(
    runBoundedProcess(
      process.execPath,
      ['-e', 'process.stdout.write(Buffer.alloc(4096))'],
      { maxStdoutBytes: 32 },
    ),
    'OUTPUT_LIMIT',
  );
  await rejectsCode(
    runBoundedProcess(
      process.execPath,
      ['-e', 'process.stderr.write(Buffer.alloc(4096))'],
      { maxStderrBytes: 32 },
    ),
    'OUTPUT_LIMIT',
  );
});

test('terminates timed-out and externally cancelled processes', async () => {
  await rejectsCode(
    runBoundedProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 25 },
    ),
    'TIMEOUT',
  );

  const controller = new AbortController();
  const pending = runBoundedProcess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { timeoutMs: 5_000, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 25);
  await rejectsCode(pending, 'CANCELLED');
});

test('reports process failures without interpreting stderr', async () => {
  await rejectsCode(
    runBoundedProcess(process.execPath, [
      '-e', 'process.stderr.write("untrusted"); process.exit(7)',
    ]),
    'COMMAND_FAILED',
  );
  const result = await runBoundedProcess(process.execPath, [
    '-e', 'process.exit(7)',
  ], { rejectNonZero: false });
  assert.equal(result.exitCode, 7);
});

test('allowlist accepts exact read recipes and rejects forbidden or injected argv', () => {
  const oid = 'a'.repeat(40);
  const allowed = [
    ['version'],
    ['rev-parse', '--show-object-format'],
    ['rev-parse', '--path-format=absolute', '--absolute-git-dir'],
    ['rev-list', '--left-right', '--count', `${oid}...${oid}`],
    ['merge-base', oid, oid],
    ['merge-base', '--is-ancestor', oid, oid],
    ['cat-file', '-p', oid],
    ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
    ['status', '--porcelain=v2', '-z', '--ignored=matching',
      '--untracked-files=all'],
    ['config', '--local', '--type=bool', '--get', 'core.sparseCheckout'],
    ['config', '--local', '--type=bool', '--get', 'core.sparseCheckoutCone'],
    ['config', '--local', '--type=bool', '--get', 'index.sparse'],
    ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
    ['for-each-ref', '--sort=refname',
      '--format=%(refname)%00%(objectname)%00%(objecttype)%00',
      'refs/replace/'],
    ['for-each-ref', '--sort=refname',
      '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00',
      'refs/tags/'],
    ['ls-files', '-z', '--cached', '--', '*.orig', '*.rej'],
    ['ls-files', '-z', '--others', '--exclude-standard', '--',
      '*.orig', '*.rej'],
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--',
      '*.orig', '*.rej'],
    ['cat-file', '--batch-all-objects',
      '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    ['count-objects', '-v'],
  ];
  for (const args of allowed) assert.equal(assertReadOnlyGitArgs(args), args);

  const forbidden = [
    ['fetch'],
    ['status'],
    ['branch', '-D', 'main'],
    ['config', '--local', '--type=bool', '--get', 'credential.helper'],
    ['status', '--porcelain=v2', '-z', '--ignored=matching',
      '--untracked-files=no'],
    ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD;touch owned'],
    ['hash-object', '-w', 'file'],
    ['for-each-ref', '-z', '--format=%(refname)', 'refs/heads/'],
    ['ls-files', '-z', '--others', '--', '*.orig', '*.rej'],
    ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'],
    ['rev-parse', '--absolute-git-dir;touch owned'],
    ['rev-parse', '--show-object-format;touch owned'],
    ['cat-file', '-p', `${oid};echo owned`],
    ['rev-list', '--all', '--objects'],
    ['merge-base', oid, 'HEAD'],
  ];
  for (const args of forbidden) {
    assert.throws(
      () => assertReadOnlyGitArgs(args),
      (error) => error.code === 'FORBIDDEN_COMMAND',
      JSON.stringify(args),
    );
  }
});

test('checks the required Node runtime capability without a shell', async () => {
  const supported = await checkNodeCapability();
  assert.deepEqual(supported, {
    name: 'node-runtime',
    available: true,
    version: process.versions.node,
    gapCode: null,
  });
  const malformed = await checkNodeCapability({ nodePath: 'git' });
  assert.equal(malformed.available, false);
  assert.equal(malformed.version, null);
  assert.equal(malformed.gapCode, 'node-runtime-unavailable');
  const missing = await checkNodeCapability({
    nodePath: path.join(process.cwd(), 'definitely-missing-node'),
  });
  assert.equal(missing.available, false);
  assert.equal(missing.version, null);
});

test('actual Git supports SHA-1, %00 for-each-ref framing, and isolated reads', async () => {
  const fixture = await createRepoFixture('git-boundary');
  try {
    await fixture.write('first.txt', 'first\n');
    const original = fixture.commit('first');
    await fixture.write('second.txt', 'second\n');
    const replacement = fixture.commit('second');
    fixture.git(['branch', 'hostile;$(not-a-shell)', original]);
    fixture.replace(original, replacement);

    const before = await fixture.snapshot();
    const boundary = await createGitBoundary(fixture.root, {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    assert.equal(boundary.objectFormat, 'sha1');
    assert.equal(boundary.replacementRefs.length, 1);
    assert.equal(boundary.replacementRefs[0].oid, replacement);

    const branches = await boundary.run([
      'for-each-ref',
      '--sort=refname',
      '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(upstream)%00',
      'refs/heads/',
      'refs/remotes/',
    ]);
    const parsed = parseBranchRefs(branches.stdout, 'sha1');
    assert.equal(
      parsed.some((ref) => ref.displayName === 'refs/heads/hostile;$(not-a-shell)'),
      true,
    );
    assert.equal(branches.stdout.includes(Buffer.from('\0')), true);

    const isolated = await boundary.run(['cat-file', '-p', original]);
    const expected = fixture.git(['cat-file', '-p', original], {
      env: { GIT_NO_REPLACE_OBJECTS: '1' },
    }).stdout;
    const replaced = fixture.git(['cat-file', '-p', original]).stdout;
    assert.deepEqual(isolated.stdout, expected);
    assert.notDeepEqual(isolated.stdout, replaced);
    const overrideAttempt = await boundary.run(['version'], {
      cwd: path.join(fixture.root, 'missing'),
      env: { GIT_DIR: path.join(fixture.root, 'missing.git') },
      timeoutMs: 60_000,
      maxStdoutBytes: 100 * 1024 * 1024,
    });
    assert.match(overrideAttempt.stdout.toString('ascii'), /^git version /);
    assert.equal(boundary.limits.timeoutMs, 5_000);
    assert.equal(boundary.limits.maxStdoutBytes, 1024 * 1024);
    const batch = await boundary.run([
      'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)',
    ], { input: `${original}\n` });
    assert.match(batch.stdout.toString('ascii'), new RegExp(`^${original} commit \\d+\\n$`));
    await rejectsCode(
      boundary.run([
        'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)',
      ], { input: `${original};injected\n` }),
      'INVALID_OID',
    );
    await rejectsCode(
      boundary.run(['cat-file', '-p', 'a'.repeat(64)]),
      'INVALID_OID',
    );

    const capabilities = await boundary.capabilities();
    for (const name of [
      'git-runtime', 'object-format', 'for-each-ref-nul', 'porcelain-v2',
    ]) {
      assert.equal(
        capabilities.find((capability) => capability.name === name)?.available,
        true,
      );
    }
    assert.deepEqual(await fixture.snapshot(), before);
  } finally {
    await fixture.cleanup();
  }
});

test('requires initialization before boundary reads', async () => {
  const fixture = await createRepoFixture('uninitialized');
  try {
    const boundary = new GitBoundary(fixture.root);
    await rejectsCode(boundary.run(['version']), 'NOT_INITIALIZED');
  } finally {
    await fixture.cleanup();
  }
});

test('hashes regular files and symlinks without Git object writes or following links', async () => {
  const fixture = await createRepoFixture('filesystem-hash');
  try {
    const content = Buffer.from([0x00, 0xff, 0x0a, 0x41]);
    const regularPath = await fixture.write('payload.bin', content);
    const secret = Buffer.alloc(1024, 0x5a);
    await fixture.write('target.bin', secret);
    const linkPath = await fixture.makeSymlink('payload-link', 'target.bin');
    const before = fixture.git(['count-objects', '-v']).stdout;

    const regular = await hashFilesystemEntry(regularPath, {
      objectFormat: 'sha1',
      maxBytes: content.length,
    });
    assert.deepEqual(
      { kind: regular.kind, size: regular.size, oid: regular.oid },
      { kind: 'regular', size: content.length, oid: blobOid('sha1', content) },
    );

    const linkTarget = Buffer.from('target.bin');
    const link = await hashFilesystemEntry(linkPath, {
      objectFormat: 'sha1',
      maxBytes: linkTarget.length,
    });
    assert.deepEqual(
      {
        kind: link.kind,
        size: link.size,
        oid: link.oid,
        targetRawBase64: link.targetRawBase64,
      },
      {
        kind: 'symlink',
        size: linkTarget.length,
        oid: blobOid('sha1', linkTarget),
        targetRawBase64: linkTarget.toString('base64'),
      },
    );
    assert.notEqual(link.oid, blobOid('sha1', secret));

    const sha256 = await hashFilesystemEntry(regularPath, {
      objectFormat: 'sha256',
      maxBytes: content.length,
    });
    assert.equal(sha256.oid, blobOid('sha256', content));
    assert.deepEqual(fixture.git(['count-objects', '-v']).stdout, before);
    await rejectsCode(
      hashFilesystemEntry(regularPath, {
        objectFormat: 'sha1',
        maxBytes: content.length - 1,
      }),
      'HASH_LIMIT',
    );
    const controller = new AbortController();
    controller.abort();
    await rejectsCode(
      hashFilesystemEntry(regularPath, {
        objectFormat: 'sha1',
        signal: controller.signal,
      }),
      'CANCELLED',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('fixture commits are deterministic across repository paths', async () => {
  const left = await createRepoFixture('deterministic-left');
  const right = await createRepoFixture('deterministic-right');
  try {
    await left.write('same.txt', 'same\n');
    await right.write('same.txt', 'same\n');
    assert.equal(left.commit('same'), right.commit('same'));
    assert.deepEqual(
      await readFile(path.join(left.root, 'same.txt')),
      await readFile(path.join(right.root, 'same.txt')),
    );
  } finally {
    await left.cleanup();
    await right.cleanup();
  }
});

test('fixture commits cannot escape after nested Git metadata disappears', async () => {
  const fixture = await createRepoFixture('fixture-ceiling');
  await fixture.write('file.txt', 'fixture\n');
  await rm(path.join(fixture.root, '.git'), { recursive: true });
  assert.throws(
    () => fixture.commit('must-not-escape'),
    /failed/u,
  );
});
