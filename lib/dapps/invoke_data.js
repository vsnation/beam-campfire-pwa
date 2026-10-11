// Reads a contract call's raw_data (bvm2::ContractInvokeData), as the core
// serializes it: yas binary, little-endian, compacted integers. The same
// reader as the desktop's BeamInvokeData.decode.
//
// Compacted unsigned: one byte 0x80 | v when v < 128, else a byte n and n
// little-endian bytes. Compacted signed: one byte 0x40 | sign << 7 | |v|
// when |v| < 64, else sign << 7 | n and n little-endian bytes of |v|.
// Fixed-size arrays (hashes, contract ids) are raw; vectors, strings and
// maps carry a compacted length first.
//
// It reads plain and dependent calls. Advanced, multisigned or
// commitment-carrying entries, unknown flags and trailing bytes are
// refused: a wallet must not wave through what it cannot fully read.
// Only a caller that expects advanced entries opts in ({ allowAdvanced }):
// BEAM names claims, whose Anon-Vault receives the app shader co-signs
// (vault_anon/app_impl.h:396-441). Such an entry carries its own fee and
// validity window (bvm/invoke_data.h:100-113). Multisigned entries are never read.

export class InvokeDataError extends Error {}

export const FLAG_ADVANCED = 0x01;
export const FLAG_DEPENDENT = 0x02;
export const FLAG_MULTISIGNED = 0x08;
export const FLAG_HAS_COMMITMENT = 0x10;
export const FLAG_SAVE_APP_INVOKE = 0x20;
export const FLAG_SAVE_SPEND_MAX = 0x40;
const KNOWN_FLAGS = FLAG_ADVANCED | FLAG_DEPENDENT | FLAG_MULTISIGNED | FLAG_HAS_COMMITMENT | FLAG_SAVE_APP_INVOKE | FLAG_SAVE_SPEND_MAX;
const UNSUPPORTED = FLAG_ADVANCED | FLAG_MULTISIGNED | FLAG_HAS_COMMITMENT;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0;
  }
  get remaining() {
    return this.b.length - this.pos;
  }
  byte() {
    if (this.pos >= this.b.length) throw new InvokeDataError('raw_data: truncated');
    return this.b[this.pos++];
  }
  take(n) {
    if (n < 0 || n > this.remaining) throw new InvokeDataError('raw_data: truncated');
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  le(n) {
    const bytes = this.take(n);
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
    return v;
  }
  unsigned(maxBytes) {
    const h = this.byte();
    if (h & 0x80) return BigInt(h & 0x7f);
    if (h > maxBytes) throw new InvokeDataError(`raw_data: integer of ${h} bytes, max ${maxBytes}`);
    return this.le(h);
  }
  u32() {
    return Number(this.unsigned(4));
  }
  u64() {
    return this.unsigned(8);
  }
  i64() {
    const h = this.byte();
    const negative = (h & 0x80) !== 0;
    let magnitude;
    if (h & 0x40) magnitude = BigInt(h & 0x3f);
    else {
      const n = h & 0x3f;
      if (n > 8) throw new InvokeDataError(`raw_data: integer of ${n} bytes`);
      magnitude = this.le(n);
      if (magnitude >= 1n << 63n) throw new InvokeDataError('raw_data: signed integer overflow');
    }
    return negative ? -magnitude : magnitude;
  }
  seqSize(minElementBytes) {
    const n = this.u64();
    if (n > BigInt(Math.floor(this.remaining / minElementBytes))) throw new InvokeDataError('raw_data: container longer than data');
    return Number(n);
  }
  byteBuffer() {
    return this.take(this.seqSize(1));
  }
  string() {
    return new TextDecoder().decode(this.byteBuffer());
  }
  fundsMap() {
    const n = this.seqSize(2);
    const m = new Map();
    for (let i = 0; i < n; i++) {
      const aid = this.u32();
      const v = this.i64();
      if (m.has(aid)) throw new InvokeDataError('raw_data: duplicate asset in funds');
      m.set(aid, v);
    }
    return m;
  }
}

function readEntry(r, allowAdvanced = false) {
  const HAS_FLAGS = 0x80000000;
  const first = r.u32();
  let flags = 0;
  let method = first;
  if (first >= HAS_FLAGS) {
    flags = first - HAS_FLAGS;
    method = r.u32() % HAS_FLAGS;
  }
  if (flags & ~KNOWN_FLAGS) throw new InvokeDataError(`raw_data: unknown entry flags 0x${flags.toString(16)}`);
  if (flags & (allowAdvanced ? FLAG_MULTISIGNED : UNSUPPORTED)) throw new InvokeDataError(`raw_data: unsupported entry flags 0x${flags.toString(16)} (advanced, multisig or commitment)`);
  // The core stores a commitment only for an advanced kernel (invoke_data.cpp:148-152).
  if (flags & FLAG_HAS_COMMITMENT && !(flags & FLAG_ADVANCED)) throw new InvokeDataError('raw_data: a kernel commitment on a non-advanced entry');
  const args = r.byteBuffer();
  const sigs = r.seqSize(32);
  const signatureKeyHashes = [];
  for (let i = 0; i < sigs; i++) signatureKeyHashes.push(hex(r.take(32)));
  const charge = r.u32();
  const comment = r.string();
  const spend = r.fundsMap();
  let contractId = null;
  let dataLength = 0;
  if (method !== 0) contractId = hex(r.take(32));
  else dataLength = r.byteBuffer().length;
  let advancedFee = null;
  let minHeight = null;
  let maxHeight = null;
  if (flags & FLAG_ADVANCED) {
    // m_Adv: HeightRange (min, then max - min), fee, signature (nonce point 33 + scalar 32), key preimage hash 32.
    minHeight = r.u64();
    maxHeight = (minHeight + r.u64()) & ((1n << 64n) - 1n);
    advancedFee = r.u64();
    r.take(33 + 32 + 32);
  }
  let parentHeight = null;
  if (flags & FLAG_DEPENDENT) {
    parentHeight = r.u64();
    r.take(32); // parent context hash
  }
  if (flags & FLAG_HAS_COMMITMENT) r.take(33); // the kernel commitment
  // args: a copy of the packed method arguments, for callers that check them byte for byte.
  return { flags, method, contractId, args: args.slice(), argsLength: args.length, dataLength, signatureKeyHashes, charge, comment, spend, parentHeight, advancedFee, minHeight, maxHeight };
}

/**
 * Decodes raw_data completely or throws InvokeDataError. allowAdvanced: also read
 * advanced entries (only BEAM names claims expect them).
 * @returns {{entries: object[], appPrivilege: number|null, appArgs: object|null, spendMax: Map|null}}
 */
export function decodeInvokeData(raw, { allowAdvanced = false } = {}) {
  const r = new Reader(raw instanceof Uint8Array ? raw : Uint8Array.from(raw));
  const count = r.seqSize(4);
  const entries = [];
  for (let i = 0; i < count; i++) entries.push(readEntry(r, allowAdvanced));
  let appPrivilege = null;
  let appArgs = null;
  let spendMax = null;
  if (entries.length) {
    const flags = entries[0].flags;
    if (flags & FLAG_SAVE_APP_INVOKE) {
      r.byteBuffer(); // app shader
      r.byteBuffer(); // contract shader
      const n = r.seqSize(2);
      appArgs = {};
      for (let i = 0; i < n; i++) {
        const k = r.string();
        appArgs[k] = r.string();
      }
      appPrivilege = r.u32();
    }
    if (flags & FLAG_SAVE_SPEND_MAX) spendMax = r.fundsMap();
  }
  if (r.remaining !== 0) throw new InvokeDataError(`raw_data: ${r.remaining} unread bytes after the invoke data`);
  return { entries, appPrivilege, appArgs, spendMax };
}
