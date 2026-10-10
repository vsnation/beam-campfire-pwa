// What a built contract transaction costs and moves, read from its bytes.
//
// lib/dapps/invoke_data.js decodes raw_data. This adds what the wallet's own
// features (names, airdrops) check before a transaction goes on to consent:
// - the fee the core charges for every call, so a screen can predict the
//   approve sheet's fee exactly (a port of the desktop's invoke_data.dart);
// - the net funds over all calls: what leaves the wallet, what arrives;
// - a reader for a contract method's packed argument struct, and the byte
//   helpers to build the arguments a call must carry, to compare byte for byte.

import { decodeInvokeData, InvokeDataError, FLAG_DEPENDENT } from './dapps/invoke_data.js';

export { InvokeDataError };

// ---------------------------------------------------------------- fees

/**
 * The fee the core charges for one contract call (ContractInvokeEntry::get_FeeMin
 * with the post-HF3 fee settings). process_invoke_data pays exactly this.
 */
export function entryFee({ argsBytes, dataBytes = 0, spendAssets, charge }) {
  const assets = new Set(spendAssets);
  // The core assumes there is always a BEAM output (direct or change).
  const outputs = assets.size + (assets.has(0) ? 0 : 1);
  let std = 18000 * outputs + 10000;
  const extra = argsBytes + dataBytes;
  if (extra > 32768) std += 50 * (extra - 32768);
  if (std < 100000) std = 100000;
  let bvm = 10 * charge;
  if (bvm < 1000000) bvm = 1000000;
  return BigInt(std) + BigInt(bvm);
}

/** 0.011 BEAM: any call with a charge up to 100,000 units and small arguments. */
export const CONTRACT_CALL_FEE = 1100000n;

// ---------------------------------------------------------------- the transaction

/**
 * raw_data decoded completely (or InvokeDataError), with what it does:
 *   entries[]: decodeInvokeData's, plus fee, signatureCount and isDependent;
 *   spend: Map(assetId -> net amount, positive = paid), zeros dropped;
 *   pays / receives: Map(assetId -> positive amount); fee: the sum of the calls' fees.
 */
export function readContractTx(raw) {
  if (!(raw instanceof Uint8Array)) {
    if (!raw || typeof raw.length !== 'number') throw new InvokeDataError('raw_data: missing');
    for (const b of raw) if (!Number.isInteger(b) || b < 0 || b > 255) throw new InvokeDataError('raw_data: not bytes');
  }
  const d = decodeInvokeData(raw);
  const entries = d.entries.map((e) => ({
    ...e,
    signatureCount: e.signatureKeyHashes.length,
    isDependent: (e.flags & FLAG_DEPENDENT) !== 0,
    fee: entryFee({ argsBytes: e.argsLength, dataBytes: e.dataLength, spendAssets: [...e.spend.keys()], charge: e.charge }),
  }));
  const spend = new Map();
  for (const e of entries) for (const [aid, v] of e.spend) spend.set(aid, (spend.get(aid) || 0n) + v);
  for (const [aid, v] of [...spend]) if (v === 0n) spend.delete(aid);
  return {
    ...d,
    entries,
    spend,
    pays: new Map([...spend].filter(([, v]) => v > 0n)),
    receives: new Map([...spend].filter(([, v]) => v < 0n).map(([k, v]) => [k, -v])),
    fee: entries.reduce((s, e) => s + e.fee, 0n),
  };
}

/** The one call of a single-call transaction, checked for contract and method; fail(what) throws. */
export function singleEntry(d, cid, method, fail) {
  if (d.entries.length !== 1) fail('one contract call');
  const e = d.entries[0];
  if (e.contractId !== cid) fail(`contract ${cid}`);
  if (e.method !== method) fail(`method ${method}`);
  return e;
}

/** The spend map as plain text, for messages and tests. */
export function spendText(m) {
  return JSON.stringify(Object.fromEntries([...m].map(([k, v]) => [k, String(v)])));
}

// ---------------------------------------------------------------- bytes

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]*$/i.test(hex)) throw new InvokeDataError('not hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** value (number or bigint) as n little-endian bytes; refuses what does not fit. */
export function le(value, n) {
  const v = BigInt(value);
  if (v < 0n || v >= 1n << BigInt(8 * n)) throw new InvokeDataError(`${value} does not fit in ${n} bytes`);
  const out = new Uint8Array(n);
  let rest = v;
  for (let i = 0; i < n; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Reads a contract method's packed (#pragma pack(1)) little-endian argument struct. */
export class ArgsReader {
  constructor(bytes) {
    this.b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.pos = 0;
  }

  get remaining() {
    return this.b.length - this.pos;
  }

  get atEnd() {
    return this.pos === this.b.length;
  }

  bytes(n) {
    if (n < 0 || n > this.remaining) throw new InvokeDataError('contract args: truncated');
    const out = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u8() {
    return this.bytes(1)[0];
  }

  u32() {
    return Number(this.leBig(4));
  }

  u64() {
    return this.leBig(8);
  }

  leBig(n) {
    const b = this.bytes(n);
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  }

  /** A 33-byte public key (X[32] || Y[1]) as 66 lowercase hex characters. */
  pubKey() {
    return toHex(this.bytes(33));
  }
}
