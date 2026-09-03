import { spawn } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

export const DEFAULT_PROCESS_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxStdoutBytes: 20 * 1024 * 1024,
  maxStderrBytes: 2 * 1024 * 1024,
});

export class GitBoundaryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GitBoundaryError';
    this.code = code;
    this.details = details;
  }
}

function requireByteLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function requireArgv(args) {
  if (!Array.isArray(args) || args.some(
    (arg) => typeof arg !== 'string' || arg.includes('\0'),
  )) {
    throw new TypeError('args must be an array of NUL-free strings');
  }
}

function executableExtensions(executable, platform, env) {
  if (platform !== 'win32') return [''];
  const extension = path.extname(executable).toUpperCase();
  if (extension) {
    return ['.EXE', '.COM'].includes(extension) ? [''] : [];
  }
  const configured = String(env.PATHEXT ?? '.COM;.EXE')
    .split(';')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry === '.EXE' || entry === '.COM');
  return [...new Set(configured.length > 0 ? configured : ['.COM', '.EXE'])];
}

function verifiedExecutable(candidate) {
  try {
    const resolved = realpathSync.native(candidate);
    if (!path.isAbsolute(resolved) || !statSync(resolved).isFile()) return null;
    accessSync(resolved, fsConstants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function normalizeUntrustedRoots(roots) {
  if (!Array.isArray(roots) || roots.some(
    (root) => typeof root !== 'string' || !path.isAbsolute(root),
  )) {
    throw new TypeError('untrustedRoots must be absolute paths');
  }
  try {
    return [...new Set(roots.flatMap((root) => {
      const lexical = path.resolve(root);
      const canonical = realpathSync.native(root);
      if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
      return [lexical, canonical];
    }))];
  } catch {
    throw new TypeError('untrustedRoots must identify existing directories');
  }
}

function isUntrustedExecutable(candidate, source, roots) {
  const lexical = path.resolve(source);
  const lexicalPortable = lexical.replaceAll('\\', '/').toLowerCase();
  const canonicalPortable = candidate.replaceAll('\\', '/').toLowerCase();
  return lexicalPortable.includes('/node_modules/.bin/') ||
    canonicalPortable.includes('/node_modules/.bin/') ||
    roots.some((root) =>
      pathIsWithin(candidate, root) || pathIsWithin(lexical, root));
}

export function findUntrustedRepositoryRoot(startPath) {
  if (typeof startPath !== 'string' || startPath.length === 0) {
    throw new TypeError('startPath must be a non-empty string');
  }
  let start;
  try {
    start = realpathSync.native(path.resolve(startPath));
    if (!statSync(start).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new TypeError('startPath must identify an existing directory');
  }
  let current = start;
  let boundary = start;
  while (true) {
    if (existsSync(path.join(current, '.git'))) boundary = current;
    const parent = path.dirname(current);
    if (parent === current) return boundary;
    current = parent;
  }
}

export function resolveExecutablePath(
  executable,
  {
    env = process.env,
    platform = process.platform,
    untrustedRoots = [],
  } = {},
) {
  if (typeof executable !== 'string' || executable.length === 0 ||
      executable.includes('\0')) {
    throw new TypeError('executable must be a non-empty NUL-free string');
  }
  const roots = normalizeUntrustedRoots(untrustedRoots);
  if (path.isAbsolute(executable)) {
    const resolved = verifiedExecutable(executable);
    if (resolved && !isUntrustedExecutable(resolved, executable, roots)) return resolved;
    if (resolved) {
      throw new GitBoundaryError(
        'UNTRUSTED_EXECUTABLE',
        'executable resolves inside an untrusted directory',
      );
    }
    throw new GitBoundaryError(
      'EXECUTABLE_NOT_FOUND',
      'absolute executable path is unavailable',
    );
  }
  if (executable.includes('/') || executable.includes('\\')) {
    throw new TypeError('executable must be an absolute path or bare name');
  }

  const extensions = executableExtensions(executable, platform, env);
  let skippedUntrusted = false;
  for (const directory of String(env.PATH ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const source = path.join(directory, `${executable}${extension}`);
      const resolved = verifiedExecutable(source);
      if (!resolved) continue;
      if (!isUntrustedExecutable(resolved, source, roots)) return resolved;
      skippedUntrusted = true;
    }
  }
  if (skippedUntrusted) {
    throw new GitBoundaryError(
      'UNTRUSTED_EXECUTABLE',
      'executable was found only in untrusted directories',
    );
  }
  throw new GitBoundaryError(
    'EXECUTABLE_NOT_FOUND',
    'executable was not found in an absolute PATH directory',
  );
}

/**
 * Execute one process without a shell while bounding all captured data.
 * The promise rejects only after the child has closed.
 */
export function runBoundedProcess(executable, args, options = {}) {
  if (typeof executable !== 'string' || executable.length === 0 ||
      executable.includes('\0')) {
    throw new TypeError('executable must be a non-empty NUL-free string');
  }
  if (!path.isAbsolute(executable)) {
    throw new TypeError('executable must be an absolute path');
  }
  requireArgv(args);

  const {
    cwd,
    env,
    input,
    signal,
    rejectNonZero = true,
    timeoutMs = DEFAULT_PROCESS_LIMITS.timeoutMs,
    maxStdoutBytes = DEFAULT_PROCESS_LIMITS.maxStdoutBytes,
    maxStderrBytes = DEFAULT_PROCESS_LIMITS.maxStderrBytes,
  } = options;
  requireByteLimit(timeoutMs, 'timeoutMs');
  requireByteLimit(maxStdoutBytes, 'maxStdoutBytes');
  requireByteLimit(maxStderrBytes, 'maxStderrBytes');
  if (input !== undefined && !Buffer.isBuffer(input) &&
      typeof input !== 'string' && !(input instanceof Uint8Array)) {
    throw new TypeError('input must be a string, Buffer, or Uint8Array');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure;
    let spawnError;
    let escalationTimer;

    const stop = (nextFailure) => {
      failure ??= nextFailure;
      if (!child.killed) {
        child.kill();
        escalationTimer = setTimeout(() => child.kill('SIGKILL'), 250);
        escalationTimer.unref?.();
      }
    };
    const capture = (chunks, streamName, limit) => (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const used = streamName === 'stdout' ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, limit - used);
      if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
      if (streamName === 'stdout') stdoutBytes += buffer.length;
      else stderrBytes += buffer.length;
      if (used + buffer.length > limit) {
        stop(new GitBoundaryError(
          'OUTPUT_LIMIT',
          `${streamName} exceeded ${limit} bytes`,
          { stream: streamName, limit },
        ));
      }
    };

    child.stdout.on('data', capture(stdout, 'stdout', maxStdoutBytes));
    child.stderr.on('data', capture(stderr, 'stderr', maxStderrBytes));
    child.on('error', (error) => {
      spawnError = error;
    });

    const timer = setTimeout(() => {
      stop(new GitBoundaryError(
        'TIMEOUT',
        `process exceeded ${timeoutMs} ms`,
        { timeoutMs },
      ));
    }, timeoutMs);
    timer.unref?.();

    const abort = () => stop(new GitBoundaryError('CANCELLED', 'process cancelled'));
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') spawnError ??= error;
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);

    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      signal?.removeEventListener('abort', abort);
      if (failure) {
        reject(failure);
        return;
      }
      if (spawnError) {
        reject(new GitBoundaryError(
          'SPAWN_FAILED',
          `unable to execute ${executable}`,
          { cause: spawnError },
        ));
        return;
      }
      const result = Object.freeze({
        exitCode,
        signal: exitSignal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
      if (rejectNonZero && exitCode !== 0) {
        reject(new GitBoundaryError(
          'COMMAND_FAILED',
          `${executable} exited with status ${exitCode}`,
          result,
        ));
        return;
      }
      resolve(result);
    });
  });
}

export async function checkNodeCapability(options = {}) {
  let result;
  try {
    result = await runBoundedProcess(
      options.nodePath ?? process.execPath,
      ['--version'],
      {
        ...options,
        maxStdoutBytes: options.maxStdoutBytes ?? 128,
        maxStderrBytes: options.maxStderrBytes ?? 1024,
        rejectNonZero: false,
      },
    );
  } catch {
    return Object.freeze({
      name: 'node-runtime',
      available: false,
      version: null,
      gapCode: 'node-runtime-unavailable',
    });
  }
  const output = result.stdout.toString('ascii').trim();
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(output);
  const available = result.exitCode === 0 && match !== null &&
    Number(match[1]) >= 22;
  return Object.freeze({
    name: 'node-runtime',
    available,
    version: match ? output.slice(1) : null,
    gapCode: available ? null : 'node-runtime-unavailable',
  });
}
