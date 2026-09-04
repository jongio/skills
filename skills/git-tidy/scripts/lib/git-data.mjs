import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';

import { GitBoundaryError } from './git-process.mjs';

const OBJECT_FORMAT_LENGTHS = Object.freeze({ sha1: 40, sha256: 64 });
const OBJECT_TYPES = new Set(['blob', 'commit', 'tag', 'tree']);

function requireByteLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

export function validateObjectFormat(value) {
  if (!Object.hasOwn(OBJECT_FORMAT_LENGTHS, value)) {
    throw new GitBoundaryError(
      'UNSUPPORTED_OBJECT_FORMAT',
      `unsupported Git object format: ${String(value)}`,
    );
  }
  return value;
}

export function validateOid(value, objectFormat) {
  validateObjectFormat(objectFormat);
  const length = OBJECT_FORMAT_LENGTHS[objectFormat];
  if (typeof value !== 'string' ||
      !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new GitBoundaryError(
      'INVALID_OID',
      `expected a lowercase ${length}-hex ${objectFormat} object ID`,
    );
  }
  return value;
}

function asciiField(field, label) {
  if (field.length === 0 || field.some((byte) => byte > 0x7f)) {
    throw new GitBoundaryError('MALFORMED_GIT_OUTPUT', `${label} is not ASCII`);
  }
  return field.toString('ascii');
}

/**
 * Parse records whose every field is NUL-terminated and whose record suffix is
 * exactly LF. Git for-each-ref emits this framing for a %00-ended format.
 */
export function parseFixedNulRecords(buffer, fieldCount) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
  if (!Number.isSafeInteger(fieldCount) || fieldCount < 1) {
    throw new TypeError('fieldCount must be a positive integer');
  }
  const records = [];
  let offset = 0;
  while (offset < buffer.length) {
    const fields = [];
    for (let index = 0; index < fieldCount; index += 1) {
      const nul = buffer.indexOf(0, offset);
      if (nul < 0) {
        throw new GitBoundaryError(
          'MALFORMED_GIT_OUTPUT',
          'missing NUL field terminator',
        );
      }
      fields.push(Buffer.from(buffer.subarray(offset, nul)));
      offset = nul + 1;
    }
    if (offset >= buffer.length || buffer[offset] !== 0x0a) {
      throw new GitBoundaryError(
        'MALFORMED_GIT_OUTPUT',
        'record must end in exactly LF',
      );
    }
    offset += 1;
    records.push(fields);
  }
  return records;
}

export function displayRawBytes(raw) {
  if (!Buffer.isBuffer(raw)) throw new TypeError('raw must be a Buffer');
  const decoded = raw.toString('utf8');
  return decoded
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, '\uFFFD')
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, '\uFFFD');
}

export function encodeRawPath(raw) {
  if (!Buffer.isBuffer(raw)) throw new TypeError('raw path must be a Buffer');
  return Object.freeze({
    rawBase64: raw.toString('base64'),
    display: displayRawBytes(raw),
  });
}

export function parseReplacementRefs(buffer, objectFormat) {
  validateObjectFormat(objectFormat);
  return parseFixedNulRecords(buffer, 3).map(([ref, oidBytes, typeBytes]) => {
    if (ref.length === 0) {
      throw new GitBoundaryError('MALFORMED_GIT_OUTPUT', 'empty replacement ref');
    }
    const oid = validateOid(asciiField(oidBytes, 'object name'), objectFormat);
    const objectType = asciiField(typeBytes, 'object type');
    if (!OBJECT_TYPES.has(objectType)) {
      throw new GitBoundaryError(
        'MALFORMED_GIT_OUTPUT',
        `unsupported object type: ${objectType}`,
      );
    }
    return Object.freeze({
      refRaw: Buffer.from(ref),
      refRawBase64: ref.toString('base64'),
      displayName: displayRawBytes(ref),
      oid,
      objectType,
    });
  });
}

export function parseBranchRefs(buffer, objectFormat) {
  validateObjectFormat(objectFormat);
  return parseFixedNulRecords(buffer, 4).map(
    ([ref, oidBytes, typeBytes, upstream]) => {
      if (ref.length === 0) {
        throw new GitBoundaryError('MALFORMED_GIT_OUTPUT', 'empty branch ref');
      }
      const oid = validateOid(asciiField(oidBytes, 'object name'), objectFormat);
      const objectType = asciiField(typeBytes, 'object type');
      if (!OBJECT_TYPES.has(objectType)) {
        throw new GitBoundaryError(
          'MALFORMED_GIT_OUTPUT',
          `unsupported object type: ${objectType}`,
        );
      }
      return Object.freeze({
        refRaw: Buffer.from(ref),
        refRawBase64: ref.toString('base64'),
        displayName: displayRawBytes(ref),
        oid,
        objectType,
        upstreamRaw: Buffer.from(upstream),
        upstreamRawBase64: upstream.toString('base64'),
      });
    },
  );
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function blobHash(objectFormat, size) {
  const hash = createHash(objectFormat);
  hash.update(Buffer.from(`blob ${size}\0`, 'ascii'));
  return hash;
}

/**
 * Hash a regular file or symlink as a Git blob without invoking Git. Regular
 * files are opened no-follow where supported and checked before and after I/O.
 */
export async function hashFilesystemEntry(filePath, options = {}) {
  const objectFormat = validateObjectFormat(options.objectFormat ?? 'sha1');
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  requireByteLimit(maxBytes, 'maxBytes');
  if (options.signal?.aborted) {
    throw new GitBoundaryError('CANCELLED', 'file hashing cancelled');
  }
  const before = await lstat(filePath, { bigint: true });

  if (before.isSymbolicLink()) {
    const target = await readlink(filePath, { encoding: 'buffer' });
    if (options.signal?.aborted) {
      throw new GitBoundaryError('CANCELLED', 'file hashing cancelled');
    }
    if (target.length > maxBytes) {
      throw new GitBoundaryError('HASH_LIMIT', 'symlink target exceeds hash limit');
    }
    const after = await lstat(filePath, { bigint: true });
    if (!sameFile(before, after)) {
      throw new GitBoundaryError('FILE_CHANGED', 'symlink changed while hashing');
    }
    const oid = blobHash(objectFormat, target.length).update(target).digest('hex');
    return Object.freeze({
      kind: 'symlink',
      mode: Number(before.mode & 0o177777n),
      size: target.length,
      oid,
      targetRawBase64: target.toString('base64'),
    });
  }
  if (!before.isFile()) {
    throw new GitBoundaryError(
      'UNSUPPORTED_FILE_TYPE',
      'only regular files and symlinks may be hashed',
    );
  }
  if (before.size > BigInt(maxBytes) ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new GitBoundaryError('HASH_LIMIT', 'regular file exceeds hash limit');
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw new GitBoundaryError('FILE_CHANGED', 'file became a symlink');
    }
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened) || !opened.isFile()) {
      throw new GitBoundaryError('FILE_CHANGED', 'file changed before hashing');
    }
    const hash = blobHash(objectFormat, Number(opened.size));
    let readBytes = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      if (options.signal?.aborted) {
        throw new GitBoundaryError('CANCELLED', 'file hashing cancelled');
      }
      readBytes += chunk.length;
      if (readBytes > maxBytes) {
        throw new GitBoundaryError('HASH_LIMIT', 'regular file exceeds hash limit');
      }
      hash.update(chunk);
    }
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(filePath, { bigint: true });
    if (readBytes !== Number(opened.size) ||
        !sameFile(opened, afterHandle) ||
        !sameFile(opened, afterPath)) {
      throw new GitBoundaryError('FILE_CHANGED', 'file changed while hashing');
    }
    return Object.freeze({
      kind: 'regular',
      mode: Number(opened.mode & 0o177777n),
      size: readBytes,
      oid: hash.digest('hex'),
    });
  } finally {
    await handle.close();
  }
}
