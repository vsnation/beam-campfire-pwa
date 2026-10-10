// Airdrops: voucher codes that each unlock an amount of an asset, from BEAM's
// voucher Airdrop contract. Claim a code, create a batch of codes, list this
// wallet's batches, cancel a batch to take back what nobody claimed.
//
// A port of the desktop app (lib/wallets/beam/contracts/airdrop/:
// airdrop_constants, airdrop_args, voucher_code, voucher_blob, airdrop_models,
// voucher_code_store, beam_airdrop_service). Every transaction is built by the
// pinned app shader and checked byte for byte (lib/contract_tx.js) before the
// wallet is asked to sign: one call to the live contract, the expected method,
// BVM charge, kernel comment and signing key count, the exact arguments (this
// wallet's key, the exact vouchers, the exact code) and exactly the expected
// funds. The approve sheet must then show the same amounts and fee.
//
// Codes are the only key to a voucher's funds. A new batch's codes are saved,
// encrypted, in this wallet's storage on this device before the wallet is asked
// to sign, and nothing in this module ever deletes a saved code.

import { nativeApp } from './contracts.js';
import { loadShader } from './shaders.js';
import { readContractTx, entryFee, InvokeDataError, toHex, fromHex, le, concat, bytesEqual, spendText } from './contract_tx.js';

/** The live Airdrop contract (deployed at 3,729,281). The pinned shader and this id are a matched pair. */
export const AIRDROP_CID = '8737e0d39575d7015fdea259fa091e41fc293e6c3d54e80d529033c349b5b18e';
/** The v3 build with a different ABI: the pinned shader would build wrong calls for it. Never called. */
export const DEAD_CIDS = new Set(['00c0dc81e42908805d8beeb05f08eab0445e1793813fa10f37bafed6795d5ef9']);
/** Sponsored-gas claims are not deployed on the live contract. */
export const GAS_SUPPORTED = false;

export const METHOD = Object.freeze({ createBatch: 2, redeem: 3, cancelBatch: 4, setPaused: 5, withdrawFees: 6 });
/** BVM charge units the app shader declares; they set the network fee. */
export const CHARGE = Object.freeze({ createBatch: 1200000, redeem: 1200000, cancelBatch: 1800000, withdrawFees: 1200000 });
export const KERNEL = Object.freeze({ createBatch: 'Create airdrop batch', redeem: 'Redeem airdrop voucher', cancelBatch: 'Cancel airdrop batch', withdrawFees: 'Withdraw airdrop fees' });
/** 0.121 BEAM: create and claim (measured on mainnet at 3,980,470 and 3,980,484). */
export const CALL_FEE = entryFee({ argsBytes: 0, spendAssets: [0], charge: CHARGE.createBatch });
/** 0.181 BEAM: cancel (measured at 3,986,872). */
export const CANCEL_FEE = entryFee({ argsBytes: 0, spendAssets: [0], charge: CHARGE.cancelBatch });

export const MAX_VOUCHERS = 100;
export const FEE_BPS = 100n;
export const BPS_TOTAL = 10000n;
export const MAX_CODE_LENGTH = 64;

/** No I, O, 0 or 1, which are easy to misread. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 16;
export const CODE_GROUP = 4;

const U64_MAX = (1n << 64n) - 1n;
const U64_MOD = 1n << 64n;
const HASH_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^[0-9a-f]{64}0[01]$/;

export class AirdropError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    // busy, invalidCode, voucherNotFound, alreadyRedeemed, batchNotFound, notBatchCreator,
    // nothingToCancel, contractNotFound, noCodeStore, codesNotSaved, unexpected, shaderError
    this.code = code;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------- codes

/** A new code, formatted "XXXX-XXXX-XXXX-XXXX": 16 uniform draws over the alphabet (80 bits). */
export function generateCode(randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  const n = CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const b of randomBytes(CODE_LENGTH)) {
      if (b >= limit) continue;
      out += CODE_ALPHABET[b % n];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return formatCode(out);
}

const enc = new TextEncoder();

/**
 * The code exactly as the app shader normalises it before hashing: on UTF-8
 * bytes, a-z upper-cased, every byte that is not A-Z or 0-9 dropped, at most 64 kept.
 */
export function normaliseCode(input) {
  let out = '';
  for (let c of enc.encode(String(input ?? ''))) {
    if (out.length === MAX_CODE_LENGTH) break;
    if (c >= 0x61 && c <= 0x7a) c -= 0x20;
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39)) out += String.fromCharCode(c);
  }
  return out;
}

/** Normalised and grouped for display: "ABCD-EFGH-…". */
export function formatCode(input) {
  const s = normaliseCode(input);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && i % CODE_GROUP === 0) out += '-';
    out += s[i];
  }
  return out;
}

/** 16 symbols of the alphabet: a code this wallet would have made. For hints, not a gate. */
export function isWellFormedCode(input) {
  const s = normaliseCode(input);
  return s.length === CODE_LENGTH && [...s].every((c) => CODE_ALPHABET.includes(c));
}

/** Lowercase hex SHA-256 of the normalised code: the contract's key for the voucher. */
export async function codeHash(code) {
  const s = normaliseCode(code);
  if (!s) throw new AirdropError('invalidCode', 'A code has letters and digits, like ABCD-EFGH-JKLM-NPQR.');
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(s))));
}

// ---------------------------------------------------------------- fee and blob

/** The largest total whose total * 100 still fits in 64 bits. */
export const MAX_TOTAL = U64_MAX / FEE_BPS;

/**
 * The 1% creation fee exactly as the shader and the contract compute it
 * (uint64 arithmetic, wrap-around included): fee = total * 100 / 10000, at least 1.
 */
export function creationFee(total) {
  const t = BigInt(total);
  if (t < 0n || t > U64_MAX) throw new RangeError('not a 64-bit amount');
  let fee = ((t * FEE_BPS) % U64_MOD) / BPS_TOTAL;
  if (fee === 0n && t > 0n) fee = 1n;
  return fee;
}

function checkEntry(e) {
  if (!HASH_RE.test(e.hash)) throw new RangeError('voucher hash: 64 lowercase hex');
  const v = BigInt(e.value);
  if (v <= 0n || v > U64_MAX) throw new RangeError('voucher value must be 1..2^64-1');
  return { hash: e.hash, value: v };
}

/** The vouchers= bytes: each entry is its 32-byte hash then its 8-byte little-endian value. */
export function voucherBlob(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_VOUCHERS) throw new RangeError(`a batch holds 1 to ${MAX_VOUCHERS} vouchers`);
  const checked = entries.map(checkEntry);
  if (new Set(checked.map((e) => e.hash)).size !== checked.length) throw new RangeError('repeated voucher');
  const sum = checked.reduce((s, e) => s + e.value, 0n);
  if (sum > MAX_TOTAL) throw new RangeError('total above the amount the contract fee can be computed for');
  return concat(...checked.map((e) => concat(fromHex(e.hash), le(e.value, 8))));
}

export function decodeVoucherBlob(bytes) {
  if (bytes.length % 40) throw new RangeError(`voucher blob of ${bytes.length} bytes`);
  const out = [];
  for (let o = 0; o < bytes.length; o += 40) {
    let v = 0n;
    for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(bytes[o + 32 + j]);
    out.push(checkEntry({ hash: toHex(bytes.subarray(o, o + 32)), value: v }));
  }
  return out;
}

// ---------------------------------------------------------------- args

const CID_RE = /^[0-9a-f]{64}$/;

export function checkContractId(cid) {
  if (!CID_RE.test(cid)) throw new RangeError('contract id: 64 lowercase hex');
  if (DEAD_CIDS.has(cid)) throw new RangeError('the dead v3 Airdrop contract; its ABI does not match the shader');
}

function join(role, action, cid, p = {}) {
  checkContractId(cid);
  return [`role=${role}`, `action=${action}`, `cid=${cid}`, ...Object.entries(p).map(([k, v]) => `${k}=${v}`)].join(',');
}

function u64Arg(v) {
  const b = BigInt(v);
  if (b < 0n || b > U64_MAX) throw new RangeError('not a 64-bit unsigned number');
  return b.toString();
}

function aidArg(id) {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new RangeError('asset ids are 0..2^32-1');
  return String(id);
}

export const args = Object.freeze({
  createBatch: ({ assetId, vouchers, cid = AIRDROP_CID }) => join('user', 'create_batch', cid, { asset_id: aidArg(assetId), count: String(vouchers.length), vouchers: toHex(voucherBlob(vouchers)) }),
  /** The normalised code itself (the preimage), never its hash. */
  redeem: ({ normalisedCode, cid = AIRDROP_CID }) => {
    if (!/^[A-Z0-9]{1,64}$/.test(normalisedCode)) throw new RangeError('a code is 1 to 64 of A-Z and 0-9 (normalise it first)');
    return join('user', 'redeem', cid, { code: normalisedCode });
  },
  checkVoucher: ({ hash, cid = AIRDROP_CID }) => {
    if (!HASH_RE.test(hash)) throw new RangeError('hash: 64 lowercase hex');
    return join('user', 'check_voucher', cid, { hash });
  },
  viewMyBatches: ({ cid = AIRDROP_CID } = {}) => join('user', 'view_my_batches', cid),
  viewBatchVouchers: ({ batchId, cid = AIRDROP_CID }) => join('user', 'view_batch_vouchers', cid, { batch_id: u64Arg(batchId) }),
  cancelBatch: ({ batchId, cid = AIRDROP_CID }) => join('user', 'cancel_batch', cid, { batch_id: u64Arg(batchId) }),
  getMyKey: ({ cid = AIRDROP_CID } = {}) => join('user', 'get_my_key', cid),
});

// ---------------------------------------------------------------- answers

function fmt(what) {
  return new AirdropError('unexpected', `The airdrop answered something this wallet cannot check (${what}). Try again; if it keeps happening, report it.`);
}
const asMap = (v, what) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  throw fmt(`${what}: expected an object`);
};
const asList = (v, what) => {
  if (Array.isArray(v)) return v;
  throw fmt(`${what}: expected a list`);
};
function u64(m, k) {
  const v = m[k];
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v) && BigInt(v) <= U64_MAX) return BigInt(v);
  throw fmt(`${k}: expected an unsigned 64-bit integer`);
}
function u32(m, k) {
  const v = u64(m, k);
  if (v > 0xffffffffn) throw fmt(`${k}: expected an unsigned 32-bit integer`);
  return Number(v);
}
function flag(m, k) {
  const v = u32(m, k);
  if (v > 1) throw fmt(`${k}: expected 0 or 1`);
  return v === 1;
}
function key(m, k) {
  if (typeof m[k] === 'string' && KEY_RE.test(m[k])) return m[k];
  throw fmt(`${k}: not a public key`);
}
function hash(m, k) {
  if (typeof m[k] === 'string' && HASH_RE.test(m[k])) return m[k];
  throw fmt(`${k}: not a hash`);
}

export function parseMyKey(out) {
  return key(asMap(out, 'output'), 'pk');
}

/** check_voucher: {"voucher": {batch_id, asset_id, value, redeemed, redeemer?, redeemed_at?}}. */
export function parseVoucherInfo(out, hashHex) {
  const v = asMap(asMap(out, 'output').voucher, 'voucher');
  const redeemed = flag(v, 'redeemed');
  return {
    hash: hashHex,
    batchId: u64(v, 'batch_id'),
    assetId: u32(v, 'asset_id'),
    value: u64(v, 'value'),
    redeemed,
    redeemerKey: redeemed ? key(v, 'redeemer') : null,
    redeemedAtHeight: redeemed ? u64(v, 'redeemed_at') : null,
  };
}

/** view_my_batches: {"batches": [{id, asset_id, value_per_voucher, total_count, redeemed_count, created_at}]}. */
export function parseBatches(out) {
  return asList(asMap(out, 'output').batches, 'batches').map((row) => {
    const m = asMap(row, 'batches[]');
    const totalCount = u32(m, 'total_count');
    const redeemedCount = u32(m, 'redeemed_count');
    if (redeemedCount > totalCount) throw fmt('batch: more claimed than issued');
    return { id: u64(m, 'id'), assetId: u32(m, 'asset_id'), valuePerVoucher: u64(m, 'value_per_voucher'), totalCount, redeemedCount, unclaimedCount: totalCount - redeemedCount, createdAtHeight: u64(m, 'created_at') };
  });
}

/** view_batch_vouchers: {"vouchers": [{hash, value, redeemed, redeemer?, redeemed_at?}]}. */
export function parseBatchVouchers(out) {
  return asList(asMap(out, 'output').vouchers, 'vouchers').map((row) => {
    const m = asMap(row, 'vouchers[]');
    const redeemed = flag(m, 'redeemed');
    return { hash: hash(m, 'hash'), value: u64(m, 'value'), redeemed, redeemerKey: redeemed ? key(m, 'redeemer') : null, redeemedAtHeight: redeemed ? u64(m, 'redeemed_at') : null };
  });
}

/** The shader's error strings -> a code a screen can act on. */
export function codeFor(shaderMessage) {
  switch (shaderMessage) {
    case 'Voucher not found':
      return 'voucherNotFound';
    case 'Voucher already redeemed':
      return 'alreadyRedeemed';
    case 'Batch not found':
      return 'batchNotFound';
    case 'Not batch creator':
      return 'notBatchCreator';
    case 'No unclaimed vouchers':
      return 'nothingToCancel';
    case 'Contract not found':
      return 'contractNotFound';
    case 'Missing or invalid code':
    case 'Empty code after normalization':
      return 'invalidCode';
    default:
      return 'shaderError';
  }
}

const MESSAGES = {
  invalidCode: 'A code has letters and digits, like ABCD-EFGH-JKLM-NPQR.',
  voucherNotFound: 'No voucher has this code. Check it letter by letter; codes never contain I, O, 0 or 1.',
  alreadyRedeemed: 'This code was already claimed. Ask whoever gave it to you for a new one.',
  batchNotFound: 'This wallet has no batch with codes left under that number. Refresh the list.',
  notBatchCreator: 'This batch was made by another wallet, so this wallet cannot cancel it.',
  nothingToCancel: 'Every code of this batch was already claimed, so there is nothing to take back.',
  contractNotFound: 'The airdrop contract did not answer. Check your connection and try again.',
};

export function mapError(e) {
  if (e instanceof AirdropError) return e;
  if (e instanceof InvokeDataError) return new AirdropError('unexpected', 'The airdrop built a different transaction than requested, so it was not sent. Try again; if it keeps happening, report it.', { detail: e.message });
  if (e && e.code === 'shader') {
    const code = codeFor(e.message);
    return new AirdropError(code, MESSAGES[code] || `The airdrop could not do that (${e.message}). Try again; if it keeps happening, report it.`, { shaderText: e.message });
  }
  return e;
}

// ---------------------------------------------------------------- saved codes

export const TX_STATUS = Object.freeze({ unconfirmed: 'unconfirmed', broadcast: 'broadcast', confirmed: 'confirmed', failed: 'failed' });
export const CODE_STATUS = Object.freeze({ unknown: 'unknown', available: 'available', claimed: 'claimed', notFound: 'notFound' });

/** A stored batch record, checked: every code must hash to its stored hash. */
export async function readSavedBatch(json) {
  const j = asMap(json, 'saved batch');
  if (typeof j.localId !== 'string' || typeof j.contractId !== 'string' || !Number.isInteger(j.assetId) || typeof j.createdAt !== 'string' || !Array.isArray(j.codes) || !j.codes.length) {
    throw new AirdropError('unexpected', 'saved batch: missing field');
  }
  const codes = [];
  for (const c of j.codes) {
    if (!c || typeof c.code !== 'string' || typeof c.hash !== 'string' || typeof c.value !== 'string' || !/^\d+$/.test(c.value) || BigInt(c.value) <= 0n) {
      throw new AirdropError('unexpected', 'saved code: missing field');
    }
    if (!normaliseCode(c.code) || (await codeHash(c.code)) !== c.hash) throw new AirdropError('unexpected', 'saved code: hash does not match code');
    codes.push({ code: formatCode(c.code), hash: c.hash, value: c.value, status: Object.values(CODE_STATUS).includes(c.status) ? c.status : CODE_STATUS.unknown });
  }
  return {
    localId: j.localId,
    contractId: j.contractId,
    assetId: j.assetId,
    createdAt: j.createdAt,
    txId: typeof j.txId === 'string' ? j.txId : null,
    // An unreadable status must not look settled.
    txStatus: Object.values(TX_STATUS).includes(j.txStatus) ? j.txStatus : TX_STATUS.unconfirmed,
    codes,
  };
}

export const batchTotal = (b) => b.codes.reduce((s, c) => s + BigInt(c.value), 0n);

const VAULT_KEY = 'airdropCodes';
const VAULT_INFO = 'beam-campfire-airdrop-codes-v1';

function b64(u8) {
  let s = '';
  for (const x of u8) s += String.fromCharCode(x);
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Where a batch's codes live: this wallet's own storage on this device
 * (lib/store.js), AES-256-GCM under a key derived (HKDF-SHA256) from the
 * wallet's database secret, which exists only while the wallet is unlocked.
 * The record is bound to the wallet id. There is put and all, and no delete.
 *   kv: { get(key), set(key, value) }   secret: the wallet's database password
 */
export function codeVault({ kv, walletId, secret }) {
  if (!kv || !walletId || !secret) throw new AirdropError('noCodeStore', 'This wallet has nowhere safe to keep codes right now. Unlock it and try again.');
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
  const aad = (salt) => enc.encode(JSON.stringify([1, walletId, salt]));

  async function keyFor(salt) {
    const base = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
    return globalThis.crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unb64(salt), info: enc.encode(VAULT_INFO) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /** The raw records (objects), decrypted. */
  async function readRaw() {
    const env = await kv.get(VAULT_KEY);
    if (!env) return { salt: null, list: [] };
    if (env.v !== 1 || env.walletId !== walletId || typeof env.salt !== 'string' || typeof env.iv !== 'string' || typeof env.ct !== 'string') {
      throw new AirdropError('noCodeStore', 'Saved airdrop codes on this device belong to another wallet, so they were left untouched.');
    }
    let pt;
    try {
      pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: aad(env.salt) }, await keyFor(env.salt), unb64(env.ct));
    } catch {
      throw new AirdropError('noCodeStore', 'The saved airdrop codes on this device could not be opened with this wallet, so they were left untouched.');
    }
    const list = JSON.parse(new TextDecoder().decode(pt));
    if (!Array.isArray(list)) throw new AirdropError('noCodeStore', 'The saved airdrop codes are unreadable, so they were left untouched.');
    return { salt: env.salt, list };
  }

  async function writeRaw(salt, list) {
    const s = salt || b64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(s) }, await keyFor(s), enc.encode(JSON.stringify(list)));
    await kv.set(VAULT_KEY, { v: 1, walletId, salt: s, iv: b64(iv), ct: b64(new Uint8Array(ct)) });
  }

  return {
    /** Every readable saved batch, newest first. Records that do not check out are kept, not shown. */
    async all() {
      const { list } = await serial(readRaw);
      const out = [];
      for (const raw of list) {
        try {
          out.push(await readSavedBatch(raw));
        } catch {
          /* kept in storage untouched; never shown as if it were fine */
        }
      }
      return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    },

    /** Inserts or replaces one batch by localId. Every other record is written back as it was. */
    put(batch) {
      return serial(async () => {
        const { salt, list } = await readRaw();
        const rec = JSON.parse(JSON.stringify(batch));
        const i = list.findIndex((r) => r && r.localId === batch.localId);
        if (i >= 0) {
          // A status update may never drop a code the record had.
          const before = new Set((list[i].codes || []).map((c) => c && c.hash));
          const after = new Set(rec.codes.map((c) => c.hash));
          for (const h of before) if (!after.has(h)) throw new AirdropError('codesNotSaved', 'refusing to drop a saved code');
          list[i] = rec;
        } else list.push(rec);
        await writeRaw(salt, list);
      });
    },
  };
}

// ---------------------------------------------------------------- service

/**
 * The airdrop over one wallet session.
 *   deps.view(args) -> parsed shader output (App.view)
 *   deps.transact(args, {inspect, expect, intent}) -> txId (App.transact)
 *   deps.vault() -> a codeVault (needed to create batches and read saved codes)
 *   deps.now() -> Date.now() (tests)
 *   deps.randomBytes(n) (tests; defaults to the platform's secure random)
 */
export function createAirdrop(deps) {
  let myKeyCache = null;
  let flow = null; // one airdrop transaction at a time

  async function view(a) {
    let out;
    try {
      out = await deps.view(a);
    } catch (e) {
      throw mapError(e);
    }
    return out;
  }

  /** Claims the service synchronously, before the first await: a second tap finds it busy. */
  function flowed(fn) {
    if (flow) return Promise.reject(new AirdropError('busy', 'Another airdrop transaction is in progress. Finish or cancel it first.'));
    const token = {};
    flow = token;
    return (async () => {
      try {
        return await fn();
      } finally {
        if (flow === token) flow = null;
      }
    })();
  }

  const fail = (what) => {
    throw new AirdropError('unexpected', 'The airdrop built a different transaction than requested, so it was not sent. Try again; if it keeps happening, report it.', { detail: what });
  };

  /** Decodes and checks a built transaction: one call, this contract, this method, charge, comment, one signing key. */
  function checkBuilt(raw, a, method, charge, comment) {
    let d;
    try {
      d = readContractTx(raw);
    } catch (e) {
      fail(`cannot read the prepared transaction: ${e.message}`);
    }
    if (d.entries.length !== 1) fail('expected one contract call');
    const e = d.entries[0];
    if (e.contractId !== AIRDROP_CID) fail(`the call targets ${e.contractId}, not the airdrop`);
    if (e.method !== method) fail(`contract method ${e.method}, not ${method}`);
    if (e.isDependent) fail('a dependent call');
    if (e.charge !== charge) fail(`BVM charge ${e.charge}, expected ${charge}`);
    if (e.comment !== comment) fail(`kernel comment "${e.comment}"`);
    if (e.signatureCount !== 1) fail(`${e.signatureCount} signing keys`);
    if (d.appArgs) {
      for (const kv of a.split(',')) {
        const i = kv.indexOf('=');
        const k = kv.slice(0, i);
        if (!Object.prototype.hasOwnProperty.call(d.appArgs, k) || d.appArgs[k] !== kv.slice(i + 1)) fail('stored shader args differ from the request');
      }
    }
    return d;
  }

  function expectFunds(d, expected, what) {
    const s = d.spend;
    const ok = s.size === expected.size && [...expected].every(([k, v]) => s.get(k) === v);
    if (!ok) fail(`${what} moves ${spendText(s)}, expected exactly ${spendText(expected)}`);
  }

  function consentExpectation(getBuilt) {
    return (req) => {
      const d = getBuilt();
      const bad = { code: 'unexpected', message: 'The wallet built something other than what this screen shows. Nothing was sent.' };
      if (!d || req.kind !== 'contract') return bad;
      const same = (list, map) => list.length === map.size && list.every((x) => map.get(x.assetId) === x.amount);
      if (!same(req.spends, d.pays) || !same(req.receives, d.receives)) return bad;
      if (req.fee !== d.fee) return { code: 'unexpected', message: 'The network fee is not the one this screen expected. Nothing was sent.' };
      return null;
    };
  }

  /**
   * deps.transact with this module's inspect: it returns nothing to let the
   * transaction on (saving the codes never hands the record back), and what it
   * throws comes back to the caller as thrown (lib/contracts.js would otherwise
   * report every refusal as 'unexpected').
   */
  async function transact(a, opts) {
    let thrown = null;
    const inspect = async (bytes, output) => {
      try {
        await opts.inspect(bytes, output);
      } catch (e) {
        thrown = e;
        throw e;
      }
      return null;
    };
    try {
      return await deps.transact(a, { ...opts, inspect });
    } catch (e) {
      throw mapError(thrown || e);
    }
  }

  const svc = {
    get busy() {
      return Boolean(flow);
    },

    async myKey() {
      if (!myKeyCache) myKeyCache = parseMyKey(await view(args.getMyKey()));
      return myKeyCache;
    },

    /** What `code` unlocks, or null when no voucher has it. */
    async checkVoucher(code) {
      return svc.checkVoucherHash(await codeHash(code));
    },

    async checkVoucherHash(h) {
      try {
        return parseVoucherInfo(await view(args.checkVoucher({ hash: h })), h);
      } catch (e) {
        if (e.code === 'voucherNotFound') return null;
        throw e;
      }
    },

    async myBatches() {
      return parseBatches(await view(args.viewMyBatches()));
    },

    async batchVouchers(batchId) {
      return parseBatchVouchers(await view(args.viewBatchVouchers({ batchId })));
    },

    async savedBatches() {
      return (await deps.vault()).all();
    },

    /**
     * Re-reads a saved batch from the chain (its codes with check_voucher, its
     * transaction when known) and saves the result. Never removes a code; a code
     * found on chain proves the batch exists, whatever the record says.
     */
    async refreshSavedBatch(batch, { txStatusOf = null } = {}) {
      const vault = await deps.vault();
      const current = (await vault.all()).find((b) => b.localId === batch.localId) || batch;
      let status = current.txStatus;
      if (txStatusOf && current.txId && (status === TX_STATUS.unconfirmed || status === TX_STATUS.broadcast)) {
        const t = await txStatusOf(current.txId).catch(() => null);
        if (t === 3) status = TX_STATUS.confirmed;
        else if (t === 4 || t === 2) status = TX_STATUS.failed;
      }
      let anyOnChain = false;
      const codes = [];
      for (const c of current.codes) {
        const info = await svc.checkVoucherHash(c.hash);
        if (info) anyOnChain = true;
        codes.push({ ...c, status: !info ? CODE_STATUS.notFound : info.redeemed ? CODE_STATUS.claimed : CODE_STATUS.available });
      }
      if (anyOnChain) status = TX_STATUS.confirmed;
      const updated = { ...current, txStatus: status, codes };
      await vault.put(updated);
      return updated;
    },

    /**
     * Creates a batch: one fresh code per entry of `values` (smallest units of
     * `assetId`). Locks the values plus the 1% creation fee; the network fee is
     * paid in BEAM. The codes are saved before the wallet is asked to sign.
     * @returns {{ txId, batch, total, fee, built }}
     */
    createBatch({ assetId, values }) {
      return flowed(async () => {
        const vault = await deps.vault();
        if (!Array.isArray(values) || values.length === 0 || values.length > MAX_VOUCHERS) throw new RangeError(`1 to ${MAX_VOUCHERS} codes`);
        const codes = [];
        const hashes = [];
        while (codes.length < values.length) {
          const c = generateCode(deps.randomBytes);
          const h = await codeHash(c);
          if (hashes.includes(h)) continue;
          codes.push(c);
          hashes.push(h);
        }
        const entries = values.map((v, i) => ({ hash: hashes[i], value: BigInt(v) }));
        const blob = voucherBlob(entries);
        const total = entries.reduce((s, e) => s + e.value, 0n);
        const fee = creationFee(total);
        const myKey = await svc.myKey();
        const a = args.createBatch({ assetId, vouchers: entries });
        const now = new Date((deps.now || Date.now)());
        const rnd = (deps.randomBytes || ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n))))(4);
        const batch = {
          localId: `batch_${now.getTime()}_${toHex(rnd)}`,
          contractId: AIRDROP_CID,
          assetId,
          createdAt: now.toISOString(),
          txId: null,
          txStatus: TX_STATUS.unconfirmed,
          codes: codes.map((c, i) => ({ code: c, hash: hashes[i], value: String(values[i]), status: CODE_STATUS.unknown })),
        };
        let built = null;
        let saved = false;
        let shown = false;
        let txId;
        try {
          txId = await transact(a, {
            intent: { action: 'airdropCreate', count: values.length },
            inspect: async (raw) => {
              const d = checkBuilt(raw, a, METHOD.createBatch, CHARGE.createBatch, KERNEL.createBatch);
              const want = concat(fromHex(myKey), le(assetId, 4), le(entries.length, 4), blob);
              if (!bytesEqual(d.entries[0].args, want)) fail('the batch arguments differ from the request');
              expectFunds(d, new Map([[assetId, total + fee]]), 'the batch');
              built = d;
              await saveBeforeSigning(vault, batch);
              saved = true;
            },
            expect: (req) => {
              const problem = consentExpectation(() => built)(req);
              if (!problem) shown = true;
              return problem;
            },
          });
        } catch (e) {
          // Never shown for approval, declined on the sheet, or refused by the wallet:
          // it cannot have reached the network. Anything else (a timeout, a lock after
          // approving) does not prove that, so the record stays unconfirmed.
          if (saved && (!shown || e.code === 'rejected' || e.code === 'rpc')) await vault.put({ ...batch, txStatus: TX_STATUS.failed }).catch(() => {});
          throw e;
        }
        const sent = { ...batch, txId, txStatus: TX_STATUS.broadcast };
        await vault.put(sent).catch(() => {});
        return { txId, batch: sent, total, fee, built };
      });
    },

    /** Claims what `code` unlocks into this wallet. The code goes out as the normalised preimage. */
    redeem(code) {
      return flowed(async () => {
        const normalised = normaliseCode(code);
        if (!normalised) throw new AirdropError('invalidCode', MESSAGES.invalidCode);
        const info = await svc.checkVoucherHash(await codeHash(normalised));
        if (!info) throw new AirdropError('voucherNotFound', MESSAGES.voucherNotFound);
        if (info.redeemed) throw new AirdropError('alreadyRedeemed', MESSAGES.alreadyRedeemed);
        const myKey = await svc.myKey();
        const a = args.redeem({ normalisedCode: normalised });
        let built = null;
        const txId = await transact(a, {
          intent: { action: 'airdropClaim' },
          inspect: (raw) => {
            const d = checkBuilt(raw, a, METHOD.redeem, CHARGE.redeem, KERNEL.redeem);
            const want = concat(fromHex(myKey), le(normalised.length, 4), enc.encode(normalised));
            if (!bytesEqual(d.entries[0].args, want)) fail('the claim arguments differ from the request');
            expectFunds(d, new Map([[info.assetId, -info.value]]), 'the claim');
            built = d;
          },
          expect: consentExpectation(() => built),
        });
        return { txId, info, built };
      });
    },

    /** Takes back every unclaimed voucher of `batchId`. Their codes stop working. */
    cancelBatch(batchId) {
      return flowed(async () => {
        const id = BigInt(batchId);
        const batch = (await svc.myBatches()).find((b) => b.id === id);
        if (!batch) throw new AirdropError('batchNotFound', MESSAGES.batchNotFound);
        const unclaimed = (await svc.batchVouchers(id)).filter((v) => !v.redeemed);
        if (!unclaimed.length) throw new AirdropError('nothingToCancel', MESSAGES.nothingToCancel);
        const total = unclaimed.reduce((s, v) => s + v.value, 0n);
        const myKey = await svc.myKey();
        const a = args.cancelBatch({ batchId: id });
        let built = null;
        const txId = await transact(a, {
          intent: { action: 'airdropCancel', count: unclaimed.length },
          inspect: (raw) => {
            const d = checkBuilt(raw, a, METHOD.cancelBatch, CHARGE.cancelBatch, KERNEL.cancelBatch);
            const got = d.entries[0].args;
            const head = concat(fromHex(myKey), le(id, 8), le(unclaimed.length, 4));
            if (got.length !== head.length + 32 * unclaimed.length || !bytesEqual(got.subarray(0, head.length), head)) fail('the batch changed while preparing; try again');
            const sent = new Set();
            for (let o = head.length; o < got.length; o += 32) sent.add(toHex(got.subarray(o, o + 32)));
            if (sent.size !== unclaimed.length || !unclaimed.every((v) => sent.has(v.hash))) fail('the batch changed while preparing; try again');
            expectFunds(d, new Map([[batch.assetId, -total]]), 'the cancel');
            built = d;
          },
          expect: consentExpectation(() => built),
        });
        return { txId, batch, count: unclaimed.length, total, built };
      });
    },
  };

  /** Writes the codes and reads them back; if that fails nothing is signed. */
  async function saveBeforeSigning(vault, batch) {
    try {
      await vault.put(batch);
      const back = (await vault.all()).find((b) => b.localId === batch.localId);
      const ok = back && back.codes.length === batch.codes.length && back.codes.every((c, i) => c.hash === batch.codes[i].hash && normaliseCode(c.code) === normaliseCode(batch.codes[i].code));
      if (!ok) throw new Error('read-back mismatch');
    } catch (e) {
      throw new AirdropError('codesNotSaved', `The codes could not be saved on this device, so nothing was sent. (${e.message})`);
    }
  }

  return svc;
}

// ---------------------------------------------------------------- live wiring

let live = null;

/** The airdrop on the running wallet's own app and the pinned shader. One per wallet session. */
export function airdropFor(session, { vault }) {
  if (live && live.session === session) return live.svc;
  const withApp = async () => {
    const [app, shader] = await Promise.all([nativeApp(), loadShader('airdrop')]);
    return { app, shader };
  };
  const svc = createAirdrop({
    view: async (a) => {
      const { app, shader } = await withApp();
      return app.view(a, shader, { timeoutMs: 120000 });
    },
    transact: async (a, opts) => {
      const { app, shader } = await withApp();
      return app.transact(a, shader, { ...opts, timeoutMs: 120000 });
    },
    vault,
  });
  live = { session, svc };
  return svc;
}
