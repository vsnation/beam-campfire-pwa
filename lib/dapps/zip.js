// A small reader for .dapp packages (zip archives), entirely in memory.
// Inflating uses the browser's own DecompressionStream('deflate-raw'): no
// zip library in the app.
//
// The packages BEAM Campfire opens are pinned by SHA-256 before they get
// here, so this is not the only line of defence, but it still refuses what a
// package has no business containing (the same rules as the desktop's
// DappPackage): zip64, multi-disk, encryption, methods other than stored and
// deflate, names that are absolute, climb out with "..", use odd characters
// or collide when case is ignored, symlinks and other non-regular files,
// local and central names that differ, a CRC or size mismatch, and anything
// over the size, count and compression limits. A deflate stream is cut off
// at its declared size, so a lying header cannot make it expand further.
// macOS metadata (__MACOSX/..., .DS_Store) is checked like any entry, then
// dropped.

export class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'format' | 'unsupported' | 'unsafe_path' | 'too_large' | 'corrupt'
  }
}

export const DEFAULT_LIMITS = Object.freeze({
  maxPackageBytes: 50 * 1024 * 1024,
  maxEntries: 4096,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxCentralDirectoryBytes: 2 * 1024 * 1024,
  maxRatio: 100,
  ratioFloorBytes: 1024 * 1024,
});

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const UNIX_CREATORS = new Set([3, 19]);
const TYPE_MASK = 0xf000;
const TYPE_REGULAR = 0x8000;
const TYPE_DIRECTORY = 0x4000;

// ---------------------------------------------------------------- names
const SEGMENT = /^[A-Za-z0-9 ._\-+@~(),!=[\]]+$/;
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** The segments of a package path, or a ZipError('unsafe_path'). */
export function pathSegments(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) throw new ZipError('unsafe_path', `path length ${String(path).length}`);
  if (path.startsWith('/')) throw new ZipError('unsafe_path', 'absolute path');
  const segs = path.split('/');
  if (segs.length > 32) throw new ZipError('unsafe_path', 'path too deep');
  for (const s of segs) {
    if (s === '') throw new ZipError('unsafe_path', 'empty path segment');
    if (s === '.' || s === '..') throw new ZipError('unsafe_path', 'dot segment');
    if (s.length > 255) throw new ZipError('unsafe_path', 'segment too long');
    if (!SEGMENT.test(s)) throw new ZipError('unsafe_path', 'character not allowed in a file name');
    if (s.startsWith(' ') || s.endsWith(' ') || s.endsWith('.')) throw new ZipError('unsafe_path', 'segment starts or ends with a space or dot');
    if (DEVICE.test(s)) throw new ZipError('unsafe_path', 'reserved device name');
  }
  return segs;
}

// ---------------------------------------------------------------- CRC-32
let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- inflate
/** Inflates a raw deflate stream, refusing to produce more than `max` bytes. */
export async function inflateRaw(data, max) {
  if (typeof DecompressionStream !== 'function') throw new ZipError('unsupported', 'This browser cannot unpack zip files (no DecompressionStream).');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const out = new Uint8Array(max);
  let n = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (n + value.length > max) throw new ZipError('too_large', 'an entry inflates beyond its declared size');
      out.set(value, n);
      n += value.length;
    }
  } catch (e) {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    if (e instanceof ZipError) throw e;
    throw new ZipError('corrupt', 'a compressed entry is damaged');
  }
  return n === max ? out : out.subarray(0, n);
}

// ---------------------------------------------------------------- reader
function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function findEndRecord(b) {
  // The end record is 22 bytes plus a comment of up to 65535.
  const stop = Math.max(0, b.length - 22 - 0xffff);
  for (let i = b.length - 22; i >= stop; i--) {
    if (u32(b, i) === SIG_EOCD && i + 22 + u16(b, i + 20) === b.length) return i;
  }
  throw new ZipError('format', 'not a zip archive (no end record)');
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');

/**
 * Reads every regular file of a zip archive.
 * @returns {Promise<Map<string, Uint8Array>>} path -> bytes, in archive order.
 */
export async function readZip(input, limits = DEFAULT_LIMITS) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length > limits.maxPackageBytes) throw new ZipError('too_large', `package is ${b.length} bytes`);
  if (b.length < 22) throw new ZipError('format', 'not a zip archive (too short)');
  const eocd = findEndRecord(b);
  if (eocd >= 20 && u32(b, eocd - 20) === SIG_ZIP64_LOCATOR) throw new ZipError('unsupported', 'zip64 archives are not supported');
  const disk = u16(b, eocd + 4);
  const cdDisk = u16(b, eocd + 6);
  const countHere = u16(b, eocd + 8);
  const count = u16(b, eocd + 10);
  const cdSize = u32(b, eocd + 12);
  const cdOffset = u32(b, eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || countHere !== count) throw new ZipError('unsupported', 'multi-disk archives are not supported');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('unsupported', 'zip64 archives are not supported');
  if (count === 0) throw new ZipError('format', 'empty archive');
  if (count > limits.maxEntries) throw new ZipError('too_large', `${count} entries`);
  if (cdSize > limits.maxCentralDirectoryBytes) throw new ZipError('too_large', 'central directory too large');
  if (cdOffset + cdSize > eocd) throw new ZipError('format', 'central directory outside the archive');

  const out = new Map();
  const folded = new Set();
  const dirs = new Set();
  let total = 0;
  let packedTotal = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOffset + cdSize || u32(b, p) !== SIG_CENTRAL) throw new ZipError('format', 'damaged central directory');
    const creator = b[p + 5];
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const crc = u32(b, p + 16);
    const packed = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const startDisk = u16(b, p + 34);
    const external = u32(b, p + 38);
    const localOffset = u32(b, p + 42);
    const nameBytes = b.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (p > cdOffset + cdSize) throw new ZipError('format', 'damaged central directory');
    if (startDisk !== 0) throw new ZipError('unsupported', 'multi-disk archives are not supported');
    if (packed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('unsupported', 'zip64 entries are not supported');
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw new ZipError('unsupported', 'encrypted entry');
    if (method !== 0 && method !== 8) throw new ZipError('unsupported', `compression method ${method} is not supported`);
    let name;
    try {
      name = flags & 0x0800 ? utf8.decode(nameBytes) : latin1.decode(nameBytes);
    } catch {
      throw new ZipError('unsafe_path', 'a file name is not valid UTF-8');
    }
    const isDir = name.endsWith('/');
    const segs = pathSegments(isDir ? name.slice(0, -1) : name);
    if (UNIX_CREATORS.has(creator)) {
      const type = (external >>> 16) & TYPE_MASK;
      if (type !== 0 && type !== (isDir ? TYPE_DIRECTORY : TYPE_REGULAR)) throw new ZipError('unsafe_path', 'symlink or other special file');
    }
    // Local header: same name, then the data.
    if (localOffset + 30 > cdOffset || u32(b, localOffset) !== SIG_LOCAL) throw new ZipError('format', 'damaged local header');
    const lNameLen = u16(b, localOffset + 26);
    const lExtraLen = u16(b, localOffset + 28);
    const lName = b.subarray(localOffset + 30, localOffset + 30 + lNameLen);
    if (lName.length !== nameBytes.length || lName.some((x, k) => x !== nameBytes[k])) throw new ZipError('format', "an entry's local and central names differ");
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + packed > cdOffset) throw new ZipError('format', 'entry data outside the archive');
    packedTotal += packed;
    if (packedTotal > b.length) throw new ZipError('format', 'entries claim more data than the archive holds');

    const key = segs.join('/').toLowerCase();
    if (isDir) {
      if (size !== 0) throw new ZipError('format', 'a directory entry with data');
      dirs.add(key);
      continue;
    }
    if (folded.has(key) || dirs.has(key)) throw new ZipError('unsafe_path', 'two entries collide when case is ignored');
    folded.add(key);
    for (let k = 1; k < segs.length; k++) dirs.add(segs.slice(0, k).join('/').toLowerCase());
    if (size > limits.maxFileBytes) throw new ZipError('too_large', `${name} is ${size} bytes`);
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError('too_large', 'unpacked size over the limit');
    if (size > limits.ratioFloorBytes && size > packed * limits.maxRatio) throw new ZipError('too_large', `${name} compresses too well`);

    const raw = b.subarray(dataStart, dataStart + packed);
    let data;
    if (method === 0) {
      if (packed !== size) throw new ZipError('corrupt', `${name}: stored size mismatch`);
      data = raw.slice();
    } else {
      data = await inflateRaw(raw, size);
      if (data.length !== size) throw new ZipError('corrupt', `${name}: inflated size mismatch`);
    }
    if (crc32(data) !== crc) throw new ZipError('corrupt', `${name}: CRC mismatch`);
    const path = segs.join('/');
    if (segs[0] === '__MACOSX' || segs[segs.length - 1] === '.DS_Store') continue;
    out.set(path, data);
  }
  for (const k of folded) if (dirs.has(k)) throw new ZipError('unsafe_path', 'a file where a directory is needed');
  return out;
}
