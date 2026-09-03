import path from 'node:path';

import {
  parseBranchRefs,
  parseReplacementRefs,
  validateObjectFormat,
  validateOid,
} from './git-data.mjs';
import {
  DEFAULT_PROCESS_LIMITS,
  findUntrustedRepositoryRoot,
  GitBoundaryError,
  resolveExecutablePath,
  runBoundedProcess,
} from './git-process.mjs';

const REPLACEMENT_FORMAT =
  '%(refname)%00%(objectname)%00%(objecttype)%00';
const BRANCH_FORMAT =
  '%(refname)%00%(objectname)%00%(objecttype)%00%(upstream)%00';
const TAG_FORMAT =
  '%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00';
const OBJECT_FORMAT =
  '%(objectname) %(objecttype) %(objectsize)';

function requireArgv(args) {
  if (!Array.isArray(args) || args.some(
    (arg) => typeof arg !== 'string' || arg.includes('\0'),
  )) {
    throw new TypeError('args must be an array of NUL-free strings');
  }
}

function isOidExpression(value) {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:\^[123]|\^\{tree\})?$/.test(value);
}

function validateOidExpression(value, objectFormat) {
  const match = /^([0-9a-f]+)(\^[123]|\^\{tree\})?$/.exec(value);
  if (!match) {
    throw new GitBoundaryError('INVALID_OID', 'invalid object expression');
  }
  validateOid(match[1], objectFormat);
}

function exact(args, expected) {
  return args.length === expected.length &&
    args.every((arg, index) => arg === expected[index]);
}

function isForEachRef(args) {
  if (args.includes('-z') || args.includes('--null')) return false;
  const replacement = [
    'for-each-ref', '--sort=refname', `--format=${REPLACEMENT_FORMAT}`,
    'refs/replace/',
  ];
  const branches = [
    'for-each-ref', '--sort=refname', `--format=${BRANCH_FORMAT}`,
    'refs/heads/', 'refs/remotes/',
  ];
  const tags = [
    'for-each-ref', '--sort=refname', `--format=${TAG_FORMAT}`,
    'refs/tags/',
  ];
  return exact(args, replacement) || exact(args, branches) || exact(args, tags);
}

function isArtifactList(args) {
  const prefix = ['ls-files', '-z'];
  const suffix = ['--', '*.orig', '*.rej'];
  if (
    !exact(args.slice(0, prefix.length), prefix) ||
    !exact(args.slice(-suffix.length), suffix)
  ) {
    return false;
  }
  const options = args.slice(prefix.length, -suffix.length);
  return [
    ['--cached'],
    ['--others', '--exclude-standard'],
    ['--others', '--ignored', '--exclude-standard'],
  ].some((expected) => exact(options, expected));
}

function isRevParse(args) {
  if (exact(args, ['rev-parse', '--show-object-format']) ||
      exact(args, [
        'rev-parse', '--path-format=absolute', '--git-common-dir',
      ]) ||
      exact(args, [
        'rev-parse', '--path-format=absolute', '--absolute-git-dir',
      ]) ||
      exact(args, [
        'rev-parse', '--path-format=absolute', '--show-toplevel',
      ])) {
    return true;
  }
  return args.length === 2 && args[0] === 'rev-parse' &&
    isOidExpression(args[1]);
}

function isConfigRead(args) {
  if (exact(args, [
    'config',
    '--local',
    '--null',
    '--get-regexp',
    '^remote\\..*\\.url$',
  ])) {
    return true;
  }
  return [
    'core.sparseCheckout',
    'core.sparseCheckoutCone',
    'index.sparse',
  ].some((key) => exact(args, [
    'config', '--local', '--type=bool', '--get', key,
  ]));
}

function isDiffTree(args) {
  const options = [
    'diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-ext-diff',
    '--no-textconv',
  ];
  return args.length === options.length + 2 &&
    options.every((arg, index) => args[index] === arg) &&
    isOidExpression(args.at(-2)) && isOidExpression(args.at(-1));
}

/**
 * Reject everything except the exact read-only recipes. Repository-derived
 * values are accepted only where they are full OIDs.
 */
export function assertReadOnlyGitArgs(args) {
  requireArgv(args);
  const allowed =
    exact(args, ['version']) ||
    isRevParse(args) ||
    isForEachRef(args) ||
    exact(args, [
      'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all',
    ]) ||
    exact(args, [
      'status', '--porcelain=v2', '-z', '--ignored=matching',
      '--untracked-files=all',
    ]) ||
    isConfigRead(args) ||
    exact(args, [
      'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD',
    ]) ||
    exact(args, ['worktree', 'list', '--porcelain', '-z']) ||
    isArtifactList(args) ||
    exact(args, ['sparse-checkout', 'list']) ||
    isDiffTree(args) ||
    (args.length === 3 && exact(args.slice(0, 2), ['cat-file', '-p']) &&
      isOidExpression(args[2])) ||
    (args.length === 2 && args[0] === 'cat-file' &&
      args[1] === '--batch-check=%(objectname) %(objecttype) %(objectsize)') ||
    exact(args, [
      'cat-file', '--batch-all-objects', `--batch-check=${OBJECT_FORMAT}`,
    ]) ||
    exact(args, ['count-objects', '-v']) ||
    exact(args, [
      'reflog', 'show', '--format=%gD%x00%H', '-z', 'refs/stash',
    ]);

  const revList = args.length === 4 &&
    exact(args.slice(0, 3), ['rev-list', '--left-right', '--count']) &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})\.\.\.(?:[0-9a-f]{40}|[0-9a-f]{64})$/
      .test(args[3]);
  const mergeBase = args.length === 4 &&
    exact(args.slice(0, 2), ['merge-base', '--is-ancestor']) &&
    isOidExpression(args[2]) && isOidExpression(args[3]);
  const findMergeBase = args.length === 3 &&
    args[0] === 'merge-base' &&
    isOidExpression(args[1]) && isOidExpression(args[2]);

  if (!allowed && !revList && !mergeBase && !findMergeBase) {
    throw new GitBoundaryError(
      'FORBIDDEN_COMMAND',
      `Git argv is not an allowlisted read-only recipe: ${JSON.stringify(args)}`,
    );
  }
  return args;
}

function validateInvocationOids(args, input, objectFormat) {
  if (args[0] === 'rev-parse' && args.length === 2 &&
      !args[1].startsWith('--')) {
    validateOidExpression(args[1], objectFormat);
  } else if (args[0] === 'rev-list') {
    const [left, right, extra] = args[3].split('...');
    if (extra !== undefined) {
      throw new GitBoundaryError('INVALID_OID', 'invalid revision range');
    }
    validateOid(left, objectFormat);
    validateOid(right, objectFormat);
  } else if (args[0] === 'merge-base') {
    const firstOidIndex = args[1] === '--is-ancestor' ? 2 : 1;
    validateOidExpression(args[firstOidIndex], objectFormat);
    validateOidExpression(args[firstOidIndex + 1], objectFormat);
  } else if (args[0] === 'diff-tree') {
    validateOidExpression(args.at(-2), objectFormat);
    validateOidExpression(args.at(-1), objectFormat);
  } else if (args[0] === 'cat-file' && args[1] === '-p') {
    validateOidExpression(args[2], objectFormat);
  } else if (args[0] === 'cat-file' && args[1].startsWith('--batch-check=')) {
    if (input === undefined) {
      throw new GitBoundaryError(
        'INVALID_OID',
        'cat-file batch input must contain validated OIDs',
      );
    }
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
      throw new GitBoundaryError(
        'INVALID_OID',
        'cat-file batch input must be LF-terminated',
      );
    }
    const lines = bytes.subarray(0, -1).toString('ascii').split('\n');
    if (lines.some((line) => line.length === 0) ||
        bytes.some((byte) => byte > 0x7f || byte === 0x0d)) {
      throw new GitBoundaryError('INVALID_OID', 'invalid cat-file batch input');
    }
    for (const oid of lines) validateOid(oid, objectFormat);
  }
}

function isolatedEnvironment(repoPath, isolationRoot, noReplaceObjects) {
  const env = {};
  const inherited = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec',
    'COMSPEC', 'TMP', 'TEMP', 'TMPDIR',
  ];
  for (const key of inherited) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const root = path.resolve(isolationRoot ?? path.join(repoPath, '.git-tidy-env'));
  Object.assign(env, {
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    LC_ALL: 'C',
    LANG: 'C',
  });
  if (noReplaceObjects) env.GIT_NO_REPLACE_OBJECTS = '1';
  return env;
}

function configuredArgs(args, isolationRoot) {
  const command = args[0];
  return [
    '-c', `core.hooksPath=${path.join(isolationRoot, 'hooks')}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.pager=cat',
    '-c', `pager.${command}=false`,
    '-c', 'diff.external=',
    '-c', 'diff.trustExitCode=false',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.file.allow=always',
    ...args,
  ];
}

export class GitBoundary {
  constructor(repoPath, options = {}) {
    if (typeof repoPath !== 'string' || repoPath.length === 0) {
      throw new TypeError('repoPath must be a non-empty string');
    }
    this.repoPath = path.resolve(repoPath);
    const untrustedRoot = findUntrustedRepositoryRoot(this.repoPath);
    this.gitPath = resolveExecutablePath(options.gitPath ?? 'git', {
      untrustedRoots: [untrustedRoot],
    });
    this.isolationRoot = path.resolve(
      options.isolationRoot ?? path.join(this.repoPath, '.git-tidy-env'),
    );
    this.limits = {
      timeoutMs: Math.min(
        options.timeoutMs ?? DEFAULT_PROCESS_LIMITS.timeoutMs,
        DEFAULT_PROCESS_LIMITS.timeoutMs,
      ),
      maxStdoutBytes: Math.min(
        options.maxStdoutBytes ?? DEFAULT_PROCESS_LIMITS.maxStdoutBytes,
        DEFAULT_PROCESS_LIMITS.maxStdoutBytes,
      ),
      maxStderrBytes: Math.min(
        options.maxStderrBytes ?? DEFAULT_PROCESS_LIMITS.maxStderrBytes,
        DEFAULT_PROCESS_LIMITS.maxStderrBytes,
      ),
    };
    this.objectFormat = null;
    this.replacementRefs = null;
  }

  async #execute(args, options = {}, noReplaceObjects = true) {
    assertReadOnlyGitArgs(args);
    if (this.objectFormat !== null) {
      validateInvocationOids(args, options.input, this.objectFormat);
    }
    const limits = {
      timeoutMs: Math.min(
        options.timeoutMs ?? this.limits.timeoutMs,
        this.limits.timeoutMs,
      ),
      maxStdoutBytes: Math.min(
        options.maxStdoutBytes ?? this.limits.maxStdoutBytes,
        this.limits.maxStdoutBytes,
      ),
      maxStderrBytes: Math.min(
        options.maxStderrBytes ?? this.limits.maxStderrBytes,
        this.limits.maxStderrBytes,
      ),
    };
    return runBoundedProcess(
      this.gitPath,
      configuredArgs(args, this.isolationRoot),
      {
        ...options,
        ...limits,
        cwd: this.repoPath,
        env: isolatedEnvironment(
          this.repoPath,
          this.isolationRoot,
          noReplaceObjects,
        ),
      },
    );
  }

  async initialize(options = {}) {
    const formatResult = await this.#execute(
      ['rev-parse', '--show-object-format'],
      options,
      false,
    );
    const formatMatch = /^(sha1|sha256)\n$/.exec(
      formatResult.stdout.toString('ascii'),
    );
    if (!formatMatch) {
      throw new GitBoundaryError(
        'UNSUPPORTED_OBJECT_FORMAT',
        'Git returned malformed object-format output',
      );
    }
    this.objectFormat = validateObjectFormat(formatMatch[1]);

    const replaceResult = await this.#execute([
      'for-each-ref',
      '--sort=refname',
      `--format=${REPLACEMENT_FORMAT}`,
      'refs/replace/',
    ], options, false);
    this.replacementRefs = Object.freeze(
      parseReplacementRefs(replaceResult.stdout, this.objectFormat),
    );
    return this;
  }

  async run(args, options = {}) {
    if (this.objectFormat === null || this.replacementRefs === null) {
      throw new GitBoundaryError(
        'NOT_INITIALIZED',
        'initialize the Git boundary before running commands',
      );
    }
    return this.#execute(args, options, true);
  }

  async capabilities(options = {}) {
    const capabilities = [];
    const probe = async (name, args, validate = () => {}) => {
      try {
        const result = await this.run(args, options);
        validate(result);
        capabilities.push(Object.freeze({
          name,
          available: true,
          version: null,
          gapCode: null,
        }));
      } catch {
        capabilities.push(Object.freeze({
          name,
          available: false,
          version: null,
          gapCode: `${name}-unavailable`,
        }));
      }
    };
    const version = await this.run(['version'], options);
    const versionText = version.stdout.toString('ascii').trim();
    const versionAvailable = /^git version \d+\.\d+(?:\.\d+)?/.test(versionText);
    capabilities.push(Object.freeze({
      name: 'git-runtime',
      available: versionAvailable,
      version: versionText.replace(/^git version /, '') || null,
      gapCode: versionAvailable ? null : 'git-runtime-unavailable',
    }));
    capabilities.push(Object.freeze({
      name: 'object-format',
      available: true,
      version: this.objectFormat,
      gapCode: null,
    }));
    await probe('for-each-ref-nul', [
      'for-each-ref',
      '--sort=refname',
      `--format=${BRANCH_FORMAT}`,
      'refs/heads/',
      'refs/remotes/',
    ], (result) => parseBranchRefs(result.stdout, this.objectFormat));
    await probe('porcelain-v2', [
      'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all',
    ]);
    return Object.freeze(capabilities);
  }
}

export async function createGitBoundary(repoPath, options = {}) {
  return new GitBoundary(repoPath, options).initialize(options);
}
