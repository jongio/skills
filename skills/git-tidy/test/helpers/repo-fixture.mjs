import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { resolveExecutablePath } from '../../scripts/lib/git.mjs';

const gitPath = resolveExecutablePath('git');
const fixtureParent = path.join(tmpdir(), 'git-tidy-fixtures');
const processFixtureRoot = path.join(fixtureParent, String(process.pid));

function fixtureEnvironment(overrides = {}) {
  const env = {};
  for (const key of [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec',
    'COMSPEC', 'TMP', 'TEMP', 'TMPDIR',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: path.join(processFixtureRoot, 'home'),
    XDG_CONFIG_HOME: path.join(processFixtureRoot, 'xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CEILING_DIRECTORIES: processFixtureRoot,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    LANG: 'C',
    ...overrides,
  };
}

function assertInside(root, relativePath) {
  const result = path.resolve(root, relativePath);
  if (result !== root && !result.startsWith(`${root}${path.sep}`)) {
    throw new Error(`fixture path escapes repository: ${relativePath}`);
  }
  return result;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env ?? fixtureEnvironment(),
    input: options.input,
    shell: false,
    windowsHide: true,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${executable} ${args.join(' ')} failed (${result.status}): ` +
      result.stderr.toString('utf8'),
    );
  }
  return result;
}

async function walk(root, current = root, output = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    const stat = await lstat(absolute);
    if (entry.isDirectory()) {
      output.push({ path: relative, type: 'directory', mode: stat.mode });
      await walk(root, absolute, output);
    } else if (entry.isSymbolicLink()) {
      const target = await readlink(absolute, { encoding: 'buffer' });
      output.push({
        path: relative,
        type: 'symlink',
        mode: stat.mode,
        target: target.toString('base64'),
      });
    } else if (entry.isFile()) {
      const content = await readFile(absolute);
      output.push({
        path: relative,
        type: 'file',
        mode: stat.mode,
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  }
  return output;
}

/**
 * Create a local SHA-1 repository with fixed identity and commit timestamps.
 * All helper Git calls use argv arrays and an isolated environment.
 */
export async function createRepoFixture(label) {
  if (typeof label !== 'string' || !/^[a-z0-9-]+$/.test(label)) {
    throw new TypeError('fixture label must contain only lowercase letters, digits, dashes');
  }
  const root = path.join(processFixtureRoot, label);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const canonicalRoot = realpathSync.native(root);

  const init = run(gitPath, [
    'init', '--quiet', '--initial-branch=main', '--object-format=sha1', root,
  ], { cwd: processFixtureRoot, allowFailure: true });
  if (init.status !== 0) {
    throw new Error(
      `Git SHA-1 fixture capability unavailable: ${init.stderr.toString('utf8')}`,
    );
  }
  run(gitPath, ['config', '--local', 'user.name', 'Git Tidy Fixture'], { cwd: root });
  run(gitPath, ['config', '--local', 'user.email', 'fixture@example.invalid'], {
    cwd: root,
  });
  run(gitPath, ['config', '--local', 'core.autocrlf', 'false'], { cwd: root });
  run(gitPath, ['config', '--local', 'core.filemode', 'true'], { cwd: root });

  let commitIndex = 0;
  return Object.freeze({
    root,

    git(args, options = {}) {
      return run(options.gitPath ?? gitPath, args, {
        cwd: options.cwd ?? root,
        env: fixtureEnvironment(options.env),
        input: options.input,
        allowFailure: options.allowFailure,
      });
    },

    async write(relativePath, content) {
      const absolute = assertInside(root, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
      return absolute;
    },

    async makeSymlink(relativePath, target) {
      const absolute = assertInside(root, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await symlink(target, absolute, 'file');
      return absolute;
    },

    commit(message = `fixture-${commitIndex + 1}`) {
      commitIndex += 1;
      const topLevel = run(gitPath, ['rev-parse', '--show-toplevel'], {
        cwd: root,
      }).stdout.toString('utf8').trim();
      if (realpathSync.native(topLevel) !== canonicalRoot) {
        throw new Error('fixture repository identity changed before commit');
      }
      run(gitPath, ['add', '--all'], { cwd: root });
      const second = String(commitIndex).padStart(2, '0');
      const date = `2001-01-01T00:00:${second}+0000`;
      run(gitPath, ['commit', '--quiet', '-m', message], {
        cwd: root,
        env: fixtureEnvironment({
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        }),
      });
      return this.oid('HEAD');
    },

    oid(revision = 'HEAD') {
      return run(gitPath, ['rev-parse', revision], { cwd: root })
        .stdout.toString('ascii').trim();
    },

    replace(originalOid, replacementOid) {
      run(gitPath, ['replace', originalOid, replacementOid], { cwd: root });
    },

    async snapshot() {
      const commands = {
        refs: ['for-each-ref', '--sort=refname',
          '--format=%(refname)%00%(objectname)%00'],
        reflogs: ['reflog', 'show', '--all', '--format=%gD%x00%H%x00%gs'],
        status: ['status', '--porcelain=v2', '-z', '--branch',
          '--untracked-files=all'],
        config: ['config', '--local', '--null', '--list'],
        objects: ['count-objects', '-v'],
        worktrees: ['worktree', 'list', '--porcelain', '-z'],
      };
      const gitState = {};
      for (const [name, args] of Object.entries(commands)) {
        gitState[name] = run('git', args, { cwd: root }).stdout.toString('base64');
      }
      return Object.freeze({
        gitState,
        files: await walk(root),
      });
    },

    async cleanup() {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  });
}

export async function cleanupRepoFixtures() {
  await rm(processFixtureRoot, { recursive: true, force: true, maxRetries: 3 });
}
