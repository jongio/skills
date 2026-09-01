import { deflateSync, inflateSync } from "node:zlib";

export const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
export const PNG_WIDTH = 1024;
export const PNG_HEIGHT = 1024;
export const MAX_PNG_BYTES = 12 * 1024 * 1024;

const ALLOWED_CHUNKS = new Set([
  "IHDR",
  "sBIT",
  "PLTE",
  "pHYs",
  "caBX",
  "IDAT",
  "IEND",
]);
const SIGNIFICANT_BITS_LENGTH = new Map([
  [0, 1],
  [2, 3],
  [3, 3],
  [4, 2],
  [6, 4],
]);
const COLOR_FORMATS = new Map([
  [0, { channels: 1, depths: new Set([1, 2, 4, 8, 16]) }],
  [2, { channels: 3, depths: new Set([8, 16]) }],
  [3, { channels: 1, depths: new Set([1, 2, 4, 8]) }],
  [4, { channels: 2, depths: new Set([8, 16]) }],
  [6, { channels: 4, depths: new Set([8, 16]) }],
]);

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.allocUnsafe(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return output;
}

function expectedRasterBytes(width, height, bitDepth, colorType) {
  const format = COLOR_FORMATS.get(colorType);
  const rowBytes = Math.ceil((width * format.channels * bitDepth) / 8);
  return height * (rowBytes + 1);
}

export function validatePng(input, options = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  const maxBytes = options.maxBytes ?? MAX_PNG_BYTES;
  const expectedWidth = options.width ?? PNG_WIDTH;
  const expectedHeight = options.height ?? PNG_HEIGHT;

  if (bytes.length > maxBytes) {
    throw new Error(`PNG exceeds the ${maxBytes} byte limit`);
  }
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Invalid PNG signature");
  }

  const chunks = [];
  const idat = [];
  let offset = 8;
  let ihdr = null;
  let sawIdat = false;
  let endedIdat = false;
  let sawSbit = false;
  let sawPlte = false;
  let sawPhys = false;
  let sawCaBx = false;
  let sawIend = false;

  while (offset < bytes.length) {
    if (bytes.length - offset < 12) throw new Error("Truncated PNG chunk header");
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("PNG chunk length exceeds available bytes");

    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("latin1");
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("Invalid PNG chunk type");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([typeBytes, data]));
    if (actualCrc !== expectedCrc) throw new Error(`CRC mismatch in ${type} chunk`);
    if (!ALLOWED_CHUNKS.has(type)) {
      throw new Error(`PNG chunk ${type} is not allowed; metadata and ancillary chunks are forbidden`);
    }
    if (sawIend) throw new Error("PNG contains bytes after IEND");

    chunks.push({ type, length });
    if (type === "IHDR") {
      if (chunks.length !== 1) throw new Error("IHDR must be the first PNG chunk");
      if (ihdr !== null) throw new Error("PNG contains multiple IHDR chunks");
      if (length !== 13) throw new Error("IHDR must contain 13 bytes");
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
      const format = COLOR_FORMATS.get(ihdr.colorType);
      if (!format || !format.depths.has(ihdr.bitDepth)) {
        throw new Error("Unsupported PNG color type and bit depth combination");
      }
      if (ihdr.width !== expectedWidth || ihdr.height !== expectedHeight) {
        throw new Error(`PNG must be ${expectedWidth}x${expectedHeight}`);
      }
      if (ihdr.compression !== 0 || ihdr.filter !== 0 || ihdr.interlace !== 0) {
        throw new Error("PNG must use standard compression, filtering, and no interlace");
      }
    } else if (ihdr === null) {
      throw new Error("IHDR must be the first PNG chunk");
    } else if (type === "sBIT") {
      if (sawSbit || sawPlte || sawIdat) {
        throw new Error("sBIT must appear at most once before PLTE and IDAT");
      }
      if (length !== SIGNIFICANT_BITS_LENGTH.get(ihdr.colorType)) {
        throw new Error("sBIT has an invalid length for the PNG color type");
      }
      const maximum = ihdr.colorType === 3 ? 8 : ihdr.bitDepth;
      if ([...data].some((value) => value === 0 || value > maximum)) {
        throw new Error("sBIT values must be nonzero and within the source sample depth");
      }
      sawSbit = true;
    } else if (type === "PLTE") {
      if (sawPlte || sawIdat) throw new Error("PLTE must appear once before IDAT");
      if (ihdr.colorType === 0 || ihdr.colorType === 4) {
        throw new Error("PLTE is forbidden for grayscale PNGs");
      }
      if (length === 0 || length > 768 || length % 3 !== 0) {
        throw new Error("PLTE has an invalid palette length");
      }
      if (ihdr.colorType === 3 && length / 3 > 2 ** ihdr.bitDepth) {
        throw new Error("PLTE has more entries than the indexed bit depth permits");
      }
      sawPlte = true;
    } else if (type === "IDAT") {
      if (endedIdat) throw new Error("IDAT chunks must be consecutive");
      if (ihdr.colorType === 3 && !sawPlte) throw new Error("Indexed PNG requires PLTE before IDAT");
      sawIdat = true;
      idat.push(data);
    } else if (type === "caBX") {
      if (sawIdat || sawCaBx || length === 0) {
        throw new Error("caBX must appear once before IDAT with non-empty content");
      }
      sawCaBx = true;
    } else if (type === "pHYs") {
      if (sawIdat || sawPhys) throw new Error("pHYs must appear at most once before IDAT");
      if (length !== 9) throw new Error("pHYs must contain 9 bytes");
      if (data[8] > 1) throw new Error("pHYs has an invalid unit specifier");
      sawPhys = true;
    } else if (type === "IEND") {
      if (length !== 0) throw new Error("IEND must be empty");
      if (!sawIdat) throw new Error("PNG requires at least one IDAT chunk");
      sawIend = true;
    }

    if (sawIdat && type !== "IDAT" && type !== "IEND") endedIdat = true;
    offset = end;
    if (type === "IEND" && offset !== bytes.length) throw new Error("PNG contains trailing bytes");
  }

  if (ihdr === null) throw new Error("PNG is missing IHDR");
  if (!sawIend) throw new Error("PNG is missing IEND");

  const rasterLength = expectedRasterBytes(
    ihdr.width,
    ihdr.height,
    ihdr.bitDepth,
    ihdr.colorType,
  );
  let raster;
  try {
    raster = inflateSync(Buffer.concat(idat), { maxOutputLength: rasterLength + 1 });
  } catch {
    throw new Error("PNG IDAT data is not a valid bounded zlib stream");
  }
  if (raster.length !== rasterLength) throw new Error("PNG raster length does not match IHDR");

  const rowBytes = rasterLength / ihdr.height;
  for (let row = 0; row < ihdr.height; row += 1) {
    if (raster[row * rowBytes] > 4) throw new Error(`PNG row ${row} uses an invalid filter`);
  }

  return Object.freeze({
    width: ihdr.width,
    height: ihdr.height,
    bitDepth: ihdr.bitDepth,
    colorType: ihdr.colorType,
    bytes: bytes.length,
    chunks: Object.freeze(chunks),
  });
}

export function assertValidPng(input, options) {
  validatePng(input, options);
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

export function encodeDeterministicPlaceholderPng() {
  const bytesPerRow = PNG_WIDTH * 4;
  const raster = Buffer.allocUnsafe(PNG_HEIGHT * (bytesPerRow + 1));
  for (let y = 0; y < PNG_HEIGHT; y += 1) {
    const row = y * (bytesPerRow + 1);
    raster[row] = 0;
    for (let x = 0; x < PNG_WIDTH; x += 1) {
      const pixel = row + 1 + x * 4;
      const panel = x > 175 && x < 849 && y > 223 && y < 801;
      const line = panel && ((y - 300) % 92 < 18) && x > 270 && x < 754;
      const check = panel && x > 685 && x < 742 && y > 645 && y < 702;
      raster[pixel] = line ? 72 : check ? 38 : panel ? 242 : 250;
      raster[pixel + 1] = line ? 96 : check ? 166 : panel ? 245 : 250;
      raster[pixel + 2] = line ? 128 : check ? 91 : panel ? 249 : 252;
      raster[pixel + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(PNG_WIDTH, 0);
  ihdr.writeUInt32BE(PNG_HEIGHT, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const output = Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raster, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  validatePng(output);
  return output;
}
