import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PNG_BYTES,
  PNG_HEIGHT,
  PNG_SIGNATURE,
  PNG_WIDTH,
  assertValidPng,
  encodeDeterministicPlaceholderPng,
  validatePng,
} from "../scripts/png.mjs";

function crc32(buffer) {
  const table = Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return crc >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  output.write(type, 4, "ascii");
  data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, 8 + data.length)), 8 + data.length);
  return output;
}

test("deterministic placeholder is a strict 1024 PNG", () => {
  const first = encodeDeterministicPlaceholderPng();
  const second = encodeDeterministicPlaceholderPng();
  assert.ok(first.equals(second));
  assert.ok(first.subarray(0, 8).equals(PNG_SIGNATURE));
  assert.equal(PNG_WIDTH, 1024);
  assert.equal(PNG_HEIGHT, 1024);
  assert.equal(MAX_PNG_BYTES, 12 * 1024 * 1024);
  const report = validatePng(first);
  assert.equal(report.width, 1024);
  assert.equal(report.height, 1024);
  assert.deepEqual(report.chunks.map(({ type }) => type), ["IHDR", "IDAT", "IEND"]);
  assert.equal(assertValidPng(first), first);
});

test("validator rejects malformed structure and forbidden chunks", () => {
  const valid = encodeDeterministicPlaceholderPng();
  assert.throws(() => validatePng(Buffer.alloc(0)), /signature/);
  assert.throws(() => validatePng(Buffer.concat([valid, Buffer.from([0])])), /trailing/);
  assert.throws(() => validatePng(valid.subarray(0, valid.length - 12)), /missing IEND/);

  const badCrc = Buffer.from(valid);
  badCrc[29] ^= 1;
  assert.throws(() => validatePng(badCrc), /CRC mismatch/);

  const wrongSize = Buffer.from(valid);
  wrongSize.writeUInt32BE(512, 16);
  wrongSize.writeUInt32BE(crc32(wrongSize.subarray(12, 29)), 29);
  assert.throws(() => validatePng(wrongSize), /1024x1024/);

  const metadata = makeChunk("tEXt", Buffer.from("Author\0secret"));
  const withMetadata = Buffer.concat([valid.subarray(0, 33), metadata, valid.subarray(33)]);
  assert.throws(() => validatePng(withMetadata), /not allowed/);
  const nonAsciiType = Buffer.from(valid);
  const iendOffset = nonAsciiType.length - 12;
  nonAsciiType[iendOffset + 4] |= 0x80;
  nonAsciiType.writeUInt32BE(
    crc32(nonAsciiType.subarray(iendOffset + 4, iendOffset + 8)),
    iendOffset + 8,
  );
  assert.throws(() => validatePng(nonAsciiType), /Invalid PNG chunk type/);
  assert.throws(() => validatePng(valid, { maxBytes: valid.length - 1 }), /byte limit/);
  assert.throws(() => validatePng(valid, { width: 1, height: 1 }), /1x1/);
});

test("validator accepts bounded provider provenance and image property chunks", () => {
  const valid = encodeDeterministicPlaceholderPng();
  const credentials = makeChunk("caBX", Buffer.from("c2pa"));
  const physicalDimensions = makeChunk(
    "pHYs",
    Buffer.from([0, 0, 14, 196, 0, 0, 14, 196, 1]),
  );
  const significantBits = makeChunk("sBIT", Buffer.from([8, 8, 8, 8]));
  const withProviderChunks = Buffer.concat([
    valid.subarray(0, 33),
    significantBits,
    credentials,
    physicalDimensions,
    valid.subarray(33),
  ]);

  assert.deepEqual(
    validatePng(withProviderChunks).chunks.map(({ type }) => type),
    ["IHDR", "sBIT", "caBX", "pHYs", "IDAT", "IEND"],
  );
  assert.throws(
    () =>
      validatePng(
        Buffer.concat([
          valid.subarray(0, 33),
          credentials,
          credentials,
          valid.subarray(33),
        ]),
      ),
    /caBX must appear once/,
  );
  assert.throws(
    () =>
      validatePng(
        Buffer.concat([
          valid.subarray(0, valid.length - 12),
          credentials,
          valid.subarray(valid.length - 12),
        ]),
      ),
    /caBX must appear once before IDAT/,
  );
  assert.throws(
    () =>
      validatePng(
        Buffer.concat([
          valid.subarray(0, 33),
          makeChunk("caBX", Buffer.alloc(0)),
          valid.subarray(33),
        ]),
      ),
    /non-empty content/,
  );
  assert.throws(
    () =>
      validatePng(
        Buffer.concat([
          valid.subarray(0, 33),
          physicalDimensions,
          physicalDimensions,
          valid.subarray(33),
        ]),
      ),
    /pHYs must appear at most once before IDAT/,
  );
  assert.throws(
    () =>
      validatePng(
        Buffer.concat([
          valid.subarray(0, 33),
          makeChunk("pHYs", Buffer.alloc(8)),
          valid.subarray(33),
        ]),
      ),
    /pHYs must contain 9 bytes/,
  );
  assert.throws(
    () =>
      validatePng(
        Buffer.concat([
          valid.subarray(0, 33),
          makeChunk("pHYs", Buffer.from([0, 0, 14, 196, 0, 0, 14, 196, 2])),
          valid.subarray(33),
        ]),
      ),
    /pHYs has an invalid unit specifier/,
  );
  assert.throws(
    () =>
      validatePng(
        Buffer.concat([
          valid.subarray(0, valid.length - 12),
          physicalDimensions,
          valid.subarray(valid.length - 12),
        ]),
      ),
    /pHYs must appear at most once before IDAT/,
  );
  assert.throws(
    () =>
      validatePng(
        Buffer.concat([
          valid.subarray(0, 33),
          significantBits,
          significantBits,
          valid.subarray(33),
        ]),
      ),
    /sBIT must appear at most once before PLTE and IDAT/,
  );
  assert.throws(
    () =>
      validatePng(
        Buffer.concat([
          valid.subarray(0, 33),
          makeChunk("sBIT", Buffer.from([8, 8, 8])),
          valid.subarray(33),
        ]),
      ),
    /sBIT has an invalid length/,
  );
  assert.throws(
    () =>
      validatePng(
        Buffer.concat([
          valid.subarray(0, 33),
          makeChunk("sBIT", Buffer.from([8, 8, 8, 0])),
          valid.subarray(33),
        ]),
      ),
    /sBIT values must be nonzero/,
  );
  assert.throws(
    () =>
      validatePng(
        Buffer.concat([
          valid.subarray(0, valid.length - 12),
          significantBits,
          valid.subarray(valid.length - 12),
        ]),
      ),
    /sBIT must appear at most once before PLTE and IDAT/,
  );
});

test("validator rejects truncated chunks and invalid raster data", () => {
  const valid = encodeDeterministicPlaceholderPng();
  assert.throws(() => validatePng(valid.subarray(0, 15)), /chunk header/);
  const badLength = Buffer.from(valid);
  badLength.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => validatePng(badLength), /length exceeds/);

  const idatOffset = 33;
  const idatLength = valid.readUInt32BE(idatOffset);
  const badData = Buffer.from(valid);
  badData[idatOffset + 8] ^= 1;
  badData.writeUInt32BE(
    crc32(badData.subarray(idatOffset + 4, idatOffset + 8 + idatLength)),
    idatOffset + 8 + idatLength,
  );
  assert.throws(() => validatePng(badData), /zlib stream/);
});
