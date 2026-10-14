// Airdrop v3: voucher codes on the contract whose claims never carry the code
// (ac85d74b…effe, deployed at 4,078,350; the Airdrop repo's contracts/v3, its README's
// "Checklist for wallets" is the spec this follows).
//
// - A code becomes a seed, SHA-256("BeamAirdropV3:" || normalised code). The app shader turns the
//   seed into the voucher's secret x, mixing in the contract id, and its public key P = x·G; only P
//   goes on chain. This module derives the same P itself (vendored noble secp256k1), so every create
//   is checked against keys made here, not against what the shader says it made.
// - A claim is signed by x for a fresh receiving key. Neither the code nor x is in the transaction,
//   so a copied pending claim pays nobody but the claimer. The code itself is still a bearer secret.
// - A creator may prepay each claim's fee (gas_per_voucher, 0.022 BEAM), so a wallet holding nothing
//   can claim. The shared gas pool stays off: claims always pass use_gas_pool=0, and sponsor_gas and
//   every owner action are never offered.
// - Someone who sees a pending create can copy its voucher keys into a batch of their own. So the
//   codes of a new batch count as ready to share only after it has 3 confirmations and every code
//   was found, with its value, under a batch this wallet made (verifyBatch, squatCheck).
// - Network fees follow from the BVM charges the app shader declares, and the wallet never passes a
//   fee of its own (a higher one would make prepaid claims need BEAM): claim 0.021 BEAM; create of n
//   codes 0.001 + 10 groth x (115,000 + 30,000 n); take back n codes
//   max(0.011, 0.001 + 10 groth x (35,000 + 28,000 n)).
//
// Codes and seeds go only to the app shader on this device, never on chain, and are never logged.
// The old contract (lib/airdrop.js) keeps working for the codes it holds; a code is looked up here
// first, then there (createAirdrops).

// The curve and hash code load when an airdrop is used, never with the first paint: every screen is
// imported at start (app.js), and this module came with them (buy.test.mjs, 0.2.16 sweep).
let curveLib = null;
let hashLib = null;
/** Loads the secp256k1 and SHA-256 code this module needs; every service call awaits it first. */
export async function cryptoReady() {
  if (curveLib && hashLib) return;
  const [c, h] = await Promise.all([import('../vendor/noble/noble-curves/secp256k1.js'), import('../vendor/noble/noble-hashes/sha2.js')]);
  curveLib = c.secp256k1;
  hashLib = h.sha256;
}
const loaded = (lib) => {
  if (!lib) throw new Error('airdrop: the curve code is not loaded yet (await cryptoReady())'); // i18n-ignore: a programming error, never shown
  return lib;
};
const sha256 = (data) => loaded(hashLib)(data);
const secp256k1 = { getPublicKey: (x, compressed) => loaded(curveLib).getPublicKey(x, compressed) };
import { nativeApp } from './contracts.js';
import { loadShader } from './shaders.js';
import { readContractTx, toHex, fromHex, le, concat, bytesEqual, InvokeDataError, ArgsReader } from './contract_tx.js';
import {
  AirdropError, airdropLock, builtWrong, checkBuiltCall, expectExactFunds, consentMatches, transactChecked, saveBeforeSigning,
  createAirdrop, generateCode, codeHash, TX_STATUS, CODE_STATUS, CHECK_STATE, CALL_FEE,
} from './airdrop.js';
import { t, tk } from './i18n.js';

/** The v3 contract. The pinned app shader (lib/shaders.js airdropV3) refuses any other. */
export const V3_CID = 'ac85d74b88aca36a8033f19b00b89df55e9c75a45c8a567c0ee158e9c11aeffe';
export const V3_SHADER_ID = '3ed14be85bb30ae3755d9df426283612142265e978813d2ed9fabaf741515070';
export const V3_DEPLOY_HEIGHT = 4078350;

export const V3_METHOD = Object.freeze({ createBatch: 2, redeem: 3, cancelBatch: 4 });
/** BVM units the app shader declares (app.cpp Charge): they set the network fee. */
export const V3_CHARGE = Object.freeze({ redeem: 200000, createBase: 115000, createPerVoucher: 30000, cancelBase: 35000, cancelPerVoucher: 28000 });
export const V3_KERNEL = Object.freeze({ createBatch: 'Create airdrop batch', redeem: 'Redeem airdrop voucher', cancelBatch: 'Cancel airdrop batch' }); // i18n-ignore: kernel comments the app shader writes into the transaction, checked byte for byte

export const V3_MAX_VOUCHERS = 100;
/** The claim fee a creator can prepay per code: 0.022 BEAM, the 0.021 claim fee and 0.001 to spare. */
export const GAS_PER_VOUCHER = 2200000n;
/** Confirmations a new batch waits for before its codes are checked and shown as ready to share. */
export const CONFIRMATIONS_BEFORE_CHECK = 3;

const TAG_CODE = 'BeamAirdropV3:';
const TAG_KEY = 'BeamAirdropV3.key';
const MAX_NORMALISED = 64;
const U64_MAX = (1n << 64n) - 1n;
// The engine writes a call's funds as signed 64-bit numbers.
const I64_MAX = (1n << 63n) - 1n;
const ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const KEY_RE = /^[0-9a-f]{64}0[01]$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const enc = new TextEncoder();

// ---------------------------------------------------------------- fees

/** A standard wallet's fee for a call declaring `units`: 0.001 BEAM + max(0.01 BEAM, 10 groth per unit). */
export function feeForUnits(units) {
  const bvm = 10n * BigInt(units);
  return 100000n + (bvm < 1000000n ? 1000000n : bvm);
}

/** 0.021 BEAM: every claim (use_gas_pool=0). */
export const V3_CLAIM_FEE = feeForUnits(V3_CHARGE.redeem);
export const createCharge = (n) => V3_CHARGE.createBase + V3_CHARGE.createPerVoucher * n;
export const cancelCharge = (n) => V3_CHARGE.cancelBase + V3_CHARGE.cancelPerVoucher * n;
/** The network fee of a batch of n codes: 0.0155 BEAM for 1, 0.3125 for 100. */
export const createFee = (n) => feeForUnits(createCharge(n));
/** The network fee of taking back n codes: 0.011 BEAM up to 2, 0.2845 for 100. */
export const cancelFee = (n) => feeForUnits(cancelCharge(n));

/** The 1% creation fee as v3 computes it (contract.h CalcFee: no overflow for any 64-bit total), at least 1 groth. */
export function v3CreationFee(total) {
  const tot = BigInt(total);
  if (tot < 0n || tot > U64_MAX) throw new RangeError('not a 64-bit amount'); // i18n-ignore: internal invariant, never shown
  const fee = (tot / 10000n) * 100n + ((tot % 10000n) * 100n) / 10000n;
  return fee ? fee : 1n;
}

/**
 * What claiming `info` costs and brings, in BEAM: the network fee, the BEAM the claim itself
 * releases (prepaid fee, plus the voucher when it is BEAM), how much BEAM this wallet must already
 * hold (0 when the code pays its own fee: claimable from an empty wallet), and the BEAM balance change.
 */
export function claimCost(info) {
  const fee = info.contract === 'v3' ? V3_CLAIM_FEE : CALL_FEE;
  const gas = info.gas || 0n;
  const beamIn = gas + (info.assetId === 0 ? info.value : 0n);
  return { fee, gas, beamIn, need: fee > beamIn ? fee - beamIn : 0n, beamChange: beamIn - fee, codePaysFee: gas >= fee };
}

// ---------------------------------------------------------------- codes, seeds, keys

/**
 * The code exactly as the v3 app shader normalises it (app.cpp ReadCodeSeed): on UTF-8 bytes, a-z
 * upper-cased, every byte that is not A-Z or 0-9 dropped. Never truncated: v3 refuses a code with
 * more than 64 letters and digits, so such a code is not a v3 code.
 */
export function normaliseV3(input) {
  let out = '';
  for (let c of enc.encode(String(input ?? ''))) {
    if (c >= 0x61 && c <= 0x7a) c -= 0x20;
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39)) out += String.fromCharCode(c);
  }
  return out;
}

/** Whether v3 could hold this code at all: 1 to 64 letters and digits once normalised. */
export const isV3Code = (input) => {
  const n = normaliseV3(input).length;
  return n > 0 && n <= MAX_NORMALISED;
};

function normalisedOrThrow(code) {
  const n = normaliseV3(code);
  if (!n || n.length > MAX_NORMALISED) throw new AirdropError('invalidCode', t(MESSAGES.invalidCode));
  return n;
}

/** SHA-256("BeamAirdropV3:" || normalised code): what create_batch takes for each code. As secret as the code. */
export function seedOf(code) {
  return sha256(enc.encode(TAG_CODE + normalisedOrThrow(code)));
}

/**
 * The voucher's secret, as the app shader derives it (SeedToSecret, HashProcessor::get_Challenge):
 * SHA-256("BeamAirdropV3.key" || cid || seed), hashed on with its own output while that is zero or
 * not below the curve order. 32 bytes, big-endian.
 */
export function secretOf(seed, cid = V3_CID) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new RangeError('a seed is 32 bytes'); // i18n-ignore: internal invariant, never shown
  let data = concat(enc.encode(TAG_KEY), fromHex(cid), seed);
  for (;;) {
    const h = sha256(data);
    let v = 0n;
    for (const b of h) v = (v << 8n) | BigInt(b);
    if (v !== 0n && v < ORDER) return h;
    data = concat(data, h);
  }
}

/** A secp256k1 point as BEAM writes a PubKey: X (32 bytes) then 1 when Y is odd, else 0. */
function beamPubKey(compressed) {
  return toHex(compressed.subarray(1)) + (compressed[0] === 3 ? '01' : '00');
}

/** The voucher key P = x·G for a code on contract `cid`: what create_batch puts on chain and check_voucher finds. */
export function voucherKeyOf(code, cid = V3_CID) {
  const x = secretOf(seedOf(code), cid);
  return beamPubKey(secp256k1.getPublicKey(x, true));
}

// ---------------------------------------------------------------- args

function checkCid(cid) {
  if (cid !== V3_CID) throw new RangeError('Airdrop v3 calls go to its own contract only'); // i18n-ignore: internal invariant, never shown
}

function join(action, p = {}, cid = V3_CID) {
  checkCid(cid);
  return [`role=user`, `action=${action}`, `cid=${cid}`, ...Object.entries(p).map(([k, v]) => `${k}=${v}`)].join(',');
}

function u64Arg(v) {
  const b = BigInt(v);
  if (b < 0n || b > U64_MAX) throw new RangeError('not a 64-bit unsigned number'); // i18n-ignore: internal invariant, never shown
  return b.toString();
}

function aidArg(id) {
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new RangeError('asset ids are 0..2^32-1'); // i18n-ignore: internal invariant, never shown
  return String(id);
}

/** 0, or exactly 0.022 BEAM: the wallet offers no other prepaid fee (README checklist 5). */
export function gasArg(gas) {
  const g = BigInt(gas);
  if (g !== 0n && g !== GAS_PER_VOUCHER) throw new RangeError('the prepaid claim fee is 0 or 0.022 BEAM'); // i18n-ignore: internal invariant, never shown
  return g;
}

/** The seeds= bytes: each entry is its 32-byte seed then its 8-byte little-endian value. */
export function seedsBlob(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > V3_MAX_VOUCHERS) throw new RangeError(`a batch holds 1 to ${V3_MAX_VOUCHERS} codes`); // i18n-ignore: internal invariant, never shown (the create screen checks it first)
  const parts = [];
  const seen = new Set();
  for (const e of entries) {
    if (!(e.seed instanceof Uint8Array) || e.seed.length !== 32) throw new RangeError('a seed is 32 bytes'); // i18n-ignore: internal invariant, never shown
    const v = BigInt(e.value);
    if (v <= 0n || v > U64_MAX) throw new RangeError('a code gives 1..2^64-1'); // i18n-ignore: internal invariant, never shown
    const k = toHex(e.seed);
    if (seen.has(k)) throw new RangeError('repeated code'); // i18n-ignore: internal invariant, never shown
    seen.add(k);
    parts.push(e.seed, le(v, 8));
  }
  return concat(...parts);
}

/** The normalised code as the app shader takes it: 1 to 64 of A-Z and 0-9 (no comma or equals can reach the args). */
function codeArg(normalised) {
  if (!/^[A-Z0-9]{1,64}$/.test(normalised)) throw new RangeError('a code is 1 to 64 of A-Z and 0-9 (normalise it first)'); // i18n-ignore: internal invariant, never shown
  return normalised;
}

export const v3args = Object.freeze({
  createBatch: ({ assetId, gasPerVoucher, entries }) => join('create_batch', { asset_id: aidArg(assetId), count: String(entries.length), gas_per_voucher: gasArg(gasPerVoucher).toString(), seeds: toHex(seedsBlob(entries)) }),
  /** The pool is off and stays unused: use_gas_pool=0, always. No fee is ever passed. */
  redeem: ({ normalised }) => join('redeem', { code: codeArg(normalised), use_gas_pool: '0' }),
  checkVoucher: ({ normalised }) => join('check_voucher', { code: codeArg(normalised) }),
  voucherKey: ({ normalised }) => join('voucher_key', { code: codeArg(normalised) }),
  viewMyBatches: () => join('view_my_batches'),
  viewBatch: ({ batchId }) => join('view_batch', { batch_id: u64Arg(batchId) }),
  cancelBatch: ({ batchId }) => join('cancel_batch', { batch_id: u64Arg(batchId) }),
});

// ---------------------------------------------------------------- answers

/** what: which part of the shader's answer did not check out, in technical words (never translated). */
function fmt(what) {
  return new AirdropError('unexpected', t('The airdrop answered something this wallet cannot check ({what}). Try again; if it keeps happening, report it.', { what }));
}
const asMap = (v, what) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  throw fmt(`${what}: expected an object`); // i18n-ignore: technical detail inside the sentence fmt() says
};
const asList = (v, what) => {
  if (Array.isArray(v)) return v;
  throw fmt(`${what}: expected a list`); // i18n-ignore: technical detail inside the sentence fmt() says
};
function u64(m, k) {
  const v = m[k];
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v) && BigInt(v) <= U64_MAX) return BigInt(v);
  throw fmt(`${k}: expected an unsigned 64-bit integer`); // i18n-ignore: technical detail inside the sentence fmt() says
}
function u32(m, k) {
  const v = u64(m, k);
  if (v > 0xffffffffn) throw fmt(`${k}: expected an unsigned 32-bit integer`); // i18n-ignore: technical detail inside the sentence fmt() says
  return Number(v);
}
function flag(m, k) {
  const v = u32(m, k);
  if (v > 1) throw fmt(`${k}: expected 0 or 1`); // i18n-ignore: technical detail inside the sentence fmt() says
  return v === 1;
}
function pubKey(m, k) {
  if (typeof m[k] === 'string' && KEY_RE.test(m[k])) return m[k];
  throw fmt(`${k}: not a public key`); // i18n-ignore: technical detail inside the sentence fmt() says
}

/** check_voucher: {"voucher": {key, batch_id, asset_id, value, gas, redeemed, redeemed_at?, pool_gas?, claim_fee?}}. */
export function parseV3Voucher(out) {
  const v = asMap(asMap(out, 'output').voucher, 'voucher');
  const redeemed = flag(v, 'redeemed');
  return {
    contract: 'v3',
    key: pubKey(v, 'key'),
    batchId: u64(v, 'batch_id'),
    assetId: u32(v, 'asset_id'),
    value: u64(v, 'value'),
    gas: u64(v, 'gas'),
    redeemed,
    redeemedAtHeight: redeemed ? u64(v, 'redeemed_at') : null,
  };
}

/** view_my_batches: {"batches": [{id, asset_id, created, unclaimed, redeemed, cancelled, value_unclaimed, gas_per_voucher, created_at}], "truncated": 0|1}. */
export function parseV3Batches(out) {
  const o = asMap(out, 'output');
  const batches = asList(o.batches, 'batches').map((row) => {
    const m = asMap(row, 'batches[]');
    const created = u32(m, 'created');
    const unclaimed = u32(m, 'unclaimed');
    const redeemed = u32(m, 'redeemed');
    const cancelled = u32(m, 'cancelled');
    if (unclaimed + redeemed + cancelled !== created) throw fmt('batch: counts do not add up'); // i18n-ignore: technical detail inside the sentence fmt() says
    return { id: u64(m, 'id'), assetId: u32(m, 'asset_id'), created, unclaimed, redeemed, cancelled, valueUnclaimed: u64(m, 'value_unclaimed'), gasPerVoucher: u64(m, 'gas_per_voucher'), createdAtHeight: u64(m, 'created_at') };
  });
  return { batches, truncated: flag(o, 'truncated') };
}

/** view_batch: {"batch": {creator, asset_id, created, gas_per_voucher, created_at, vouchers: [{key, batch_id, asset_id, value, gas, redeemed}]}}. */
export function parseV3Batch(out) {
  const b = asMap(asMap(out, 'output').batch, 'batch');
  return {
    creator: pubKey(b, 'creator'),
    assetId: u32(b, 'asset_id'),
    created: u32(b, 'created'),
    gasPerVoucher: u64(b, 'gas_per_voucher'),
    createdAtHeight: u64(b, 'created_at'),
    vouchers: asList(b.vouchers, 'vouchers').map((row) => {
      const m = asMap(row, 'vouchers[]');
      return { key: pubKey(m, 'key'), batchId: u64(m, 'batch_id'), assetId: u32(m, 'asset_id'), value: u64(m, 'value'), gas: u64(m, 'gas'), redeemed: flag(m, 'redeemed') };
    }),
  };
}

/** voucher_key: {"seed": 64 hex, "key": 66 hex}. For checking this module against the shader. */
export function parseVoucherKey(out) {
  const o = asMap(out, 'output');
  if (typeof o.seed !== 'string' || !HEX64_RE.test(o.seed)) throw fmt('seed: not 32 bytes'); // i18n-ignore: technical detail inside the sentence fmt() says
  return { seed: o.seed, key: pubKey(o, 'key') };
}

/** The v3 app shader's error texts (app.cpp) -> a code a screen can act on. */
export function v3CodeFor(text) {
  const said = String(text || '');
  if (said === 'voucher not found') return 'voucherNotFound';
  if (said === 'voucher already redeemed') return 'alreadyRedeemed';
  if (said === 'batch not found') return 'batchNotFound';
  if (said === 'this wallet did not create the batch') return 'notBatchCreator';
  if (said === 'no unclaimed vouchers in this batch') return 'nothingToCancel';
  if (said === 'contract is paused: no new batches') return 'paused';
  if (said === 'code has no letters or digits' || said === 'code is longer than 64 letters and digits') return 'invalidCode';
  if (said.startsWith('no Airdrop v3 contract at this cid') || said.startsWith('this cid is not derived from') || said === 'contract settings not found' || said === 'gas pool not found') return 'contractNotFound';
  return 'shaderError';
}

// Translated where an error is made: t(MESSAGES[code]).
const MESSAGES = {
  invalidCode: tk('A code has letters and digits, like ABCD-EFGH-JKLM-NPQR.'),
  voucherNotFound: tk('No voucher has this code. Check it letter by letter; codes never contain I, O, 0 or 1.'),
  alreadyRedeemed: tk('This code was already claimed. Ask whoever gave it to you for a new one.'),
  batchNotFound: tk('This wallet has no batch with codes left under that number. Refresh the list.'),
  notBatchCreator: tk('This batch was made by another wallet, so this wallet cannot take it back.'),
  nothingToCancel: tk('Every code of this batch was already claimed or taken back, so there is nothing to take back.'),
  paused: tk('New codes cannot be made right now: the airdrop contract is paused. Claims and take-backs still work. Try again later.'),
  contractNotFound: tk('The airdrop contract could not be checked on the network. Check your connection and try again.'),
};

export function mapV3Error(e) {
  if (e instanceof AirdropError) return e;
  if (e instanceof InvokeDataError) return new AirdropError('unexpected', t('The airdrop built a different transaction than requested, so it was not sent. Try again; if it keeps happening, report it.'), { detail: e.message });
  if (e && e.code === 'shader') {
    const code = v3CodeFor(e.message);
    return new AirdropError(code, MESSAGES[code] ? t(MESSAGES[code]) : t('The airdrop could not do that ({reason}). Try again; if it keeps happening, report it.', { reason: e.message }), { shaderText: e.message });
  }
  return e;
}

// ---------------------------------------------------------------- the check before sharing

/** What a failed check says, in plain words (the screen adds what to do next). Shown as t(CHECK_PROBLEM_TEXT[problem]). */
export const CHECK_PROBLEM_TEXT = Object.freeze({
  notFound: tk('A code is not on the network.'),
  otherKey: tk('A code points somewhere other than where this wallet put it.'),
  otherValue: tk('A code holds a different amount than this batch locked.'),
  otherBatch: tk('A code belongs to a batch other than the one this wallet made.'),
  notMine: tk('The codes belong to a batch another wallet made.'),
});

/**
 * The check before a new batch's codes are shared (README checklist 11). Someone who saw the
 * pending create may have copied its voucher keys into a batch of their own with tiny values; the
 * real create then fails, nobody loses funds, but the codes point at the copy. So every code must be
 * found by check_voucher with exactly the key derived here, the asset, value and prepaid fee locked,
 * all under one batch id, and that batch must be one view_my_batches lists for this wallet with this
 * batch's count, asset and prepaid fee. view_my_batches lists at most 200 batches: when it says
 * truncated and does not list the id, a missing batch proves nothing, so view_batch of that id must
 * name this wallet's creator key: the one the batch was built with (saved with it), and the creator
 * view_batch names for a batch the list does show (they are all this wallet's; README checklist 11).
 * Every key known must match; with none known, it is not proven.
 *   batch: { assetId, gasPerVoucher, creatorKey, codes: [{ code, value, key }] }
 *   lookup(code) -> v3 voucher info or null; myBatches() -> { batches, truncated }; viewBatch(id) -> batch
 * -> { ok: true, batchId } | { ok: false, problem, index }. A lookup that fails throws (try again).
 */
export async function squatCheck({ batch, lookup, myBatches, viewBatch, onProgress = () => {} }) {
  const gas = BigInt(batch.gasPerVoucher || '0');
  const n = batch.codes.length;
  const no = (problem, index = null) => ({ ok: false, problem, index });
  let batchId = null;
  for (let i = 0; i < n; i++) {
    const c = batch.codes[i];
    const info = await lookup(c.code);
    if (!info) return no('notFound', i);
    if (!c.key || info.key !== c.key) return no('otherKey', i);
    if (info.assetId !== batch.assetId || info.value !== BigInt(c.value) || info.gas !== gas) return no('otherValue', i);
    if (batchId === null) batchId = info.batchId;
    else if (info.batchId !== batchId) return no('otherBatch', i);
    onProgress(i + 1, n);
  }
  const same = (b) => b.assetId === batch.assetId && b.created === n && b.gasPerVoucher === gas;
  const mine = await myBatches();
  const row = mine.batches.find((b) => b.id === batchId);
  if (row) return same(row) ? { ok: true, batchId } : no('otherBatch');
  if (!mine.truncated) return no('notMine');
  let b;
  try {
    b = await viewBatch(batchId);
  } catch (e) {
    if (e && e.code === 'batchNotFound') return no('notMine');
    throw e;
  }
  const known = [];
  if (batch.creatorKey) known.push(batch.creatorKey);
  if (mine.batches.length) known.push((await viewBatch(mine.batches[0].id)).creator);
  if (!b || !known.length || known.some((k) => k !== b.creator)) return no('notMine');
  return same(b) ? { ok: true, batchId } : no('otherBatch');
}

// ---------------------------------------------------------------- the service

const bytesIn = (hay, needle) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

/** asset -> net amount (positive = paid) for `value` of `assetId` plus `gas` BEAM, moving `sign`. */
function fundsOf(assetId, value, gas, sign) {
  const m = new Map();
  const add = (k, v) => v && m.set(k, (m.get(k) || 0n) + sign * v);
  add(assetId, value);
  add(0, gas);
  return m;
}

/**
 * Airdrop v3 over one wallet session.
 *   deps.view(args) -> parsed shader output (App.view);  deps.transact(args, {inspect, expect, intent}) -> txId
 *   deps.vault() -> a codeVault (lib/airdrop.js);  deps.lock -> airdropLock() shared with the old contract
 *   deps.txStatus(txId) -> the wallet's tx_status ({status, confirmations, ...})
 *   deps.now(), deps.randomBytes(n) (tests)
 */
export function createAirdropV3(deps) {
  const lock = deps.lock || airdropLock();
  const now = () => new Date((deps.now || Date.now)());
  const random = deps.randomBytes || ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const transact = (a, opts) => transactChecked(deps, a, opts, mapV3Error);

  async function view(a) {
    try {
      return await deps.view(a);
    } catch (e) {
      throw mapV3Error(e);
    }
  }

  const svc = {
    get busy() {
      return lock.busy;
    },

    /** What `code` unlocks on v3, or null when v3 has no voucher for it. */
    async checkVoucher(code) {
      if (!isV3Code(code)) return null;
      try {
        return parseV3Voucher(await view(v3args.checkVoucher({ normalised: normaliseV3(code) })));
      } catch (e) {
        if (e.code === 'voucherNotFound' || e.code === 'invalidCode') return null;
        throw e;
      }
    },

    /** What the app shader derives for a code (seed and key); never on chain. */
    async voucherKey(code) {
      return parseVoucherKey(await view(v3args.voucherKey({ normalised: normalisedOrThrow(code) })));
    },

    async myBatches() {
      return parseV3Batches(await view(v3args.viewMyBatches()));
    },

    async viewBatch(batchId) {
      return parseV3Batch(await view(v3args.viewBatch({ batchId })));
    },

    async savedBatches() {
      return (await deps.vault()).all();
    },

    /**
     * Claims what `code` unlocks into this wallet. The transaction carries the voucher key, a fresh
     * receiving key and a signature, never the code: that is checked on the built bytes. Prepaid
     * claim fees come out of the voucher, so no fee is passed; the wallet pays what the charge sets.
     */
    redeem(code) {
      return lock.run(async () => {
        const normalised = normalisedOrThrow(code);
        const info = await svc.checkVoucher(normalised);
        if (!info) throw new AirdropError('voucherNotFound', t(MESSAGES.voucherNotFound));
        if (info.redeemed) throw new AirdropError('alreadyRedeemed', t(MESSAGES.alreadyRedeemed));
        const seed = seedOf(normalised);
        const secret = secretOf(seed);
        const key = beamPubKey(secp256k1.getPublicKey(secret, true));
        if (info.key !== key) throw new AirdropError('unexpected', t('The network answered for a different voucher than this code. Nothing was sent. Try again; if it keeps happening, report it.'));
        const a = v3args.redeem({ normalised });
        const cost = claimCost(info);
        let built = null;
        const txId = await transact(a, {
          intent: { action: 'airdropClaim', assetId: info.assetId, notes: cost.codePaysFee ? [t('This code brings {amount} BEAM that pays the network fee, so no BEAM leaves your wallet.', { amount: groth8(info.gas) })] : [] },
          inspect: (raw, output) => {
            const d = checkBuiltCall(raw, { cid: V3_CID, args: a, method: V3_METHOD.redeem, charge: V3_CHARGE.redeem, comment: V3_KERNEL.redeem });
            const r = new ArgsReader(d.entries[0].args);
            if (r.remaining !== 33 + 33 + 8 + 65) builtWrong('the claim arguments have the wrong size'); // i18n-ignore: builtWrong() detail for logs, never shown
            if (r.pubKey() !== key) builtWrong('the claim names another voucher'); // i18n-ignore: builtWrong() detail for logs, never shown
            if (!KEY_RE.test(r.pubKey())) builtWrong('the claim has no receiving key'); // i18n-ignore: builtWrong() detail for logs, never shown
            if (r.u64() !== 0n) builtWrong('the claim asks the gas pool'); // i18n-ignore: builtWrong() detail for logs, never shown
            // The code, its seed and its secret stay on this device.
            for (const secretBytes of [enc.encode(normalised), seed, secret]) if (bytesIn(raw, secretBytes)) builtWrong('the claim carries the code'); // i18n-ignore: builtWrong() detail for logs, never shown
            if (output && output.gas_source !== undefined && output.gas_source !== (info.gas ? 'voucher' : 'none')) builtWrong('the claim takes its fee from the gas pool'); // i18n-ignore: builtWrong() detail for logs, never shown
            expectExactFunds(d, fundsOf(info.assetId, info.value, info.gas, -1n), 'the claim'); // i18n-ignore: builtWrong() detail for logs, never shown
            if (d.fee !== V3_CLAIM_FEE) builtWrong(`a network fee of ${d.fee} groth`); // i18n-ignore: builtWrong() detail for logs, never shown
            built = d;
          },
          expect: consentMatches(() => built),
        });
        return { txId, info, built };
      });
    },

    /**
     * Creates a batch: one fresh 16-symbol code per entry of `values` (smallest units of `assetId`),
     * each optionally with the claim fee prepaid (gas: 0.022 BEAM per code). Locks the values plus
     * the 1% creation fee, and the prepaid fees in BEAM; the network fee is paid in BEAM. The codes
     * are saved before the wallet is asked to sign; the batch's keys are checked against keys
     * derived here. @returns {{ txId, batch, total, fee, gasTotal, built }}
     */
    createBatch({ assetId, values, gas = true }) {
      return lock.run(async () => {
        const vault = await deps.vault();
        if (!Array.isArray(values) || values.length === 0 || values.length > V3_MAX_VOUCHERS) throw new RangeError(`1 to ${V3_MAX_VOUCHERS} codes`); // i18n-ignore: internal invariant, never shown (the create screen checks it first)
        const gasPerVoucher = gas ? GAS_PER_VOUCHER : 0n;
        const codes = [];
        const seen = new Set();
        while (codes.length < values.length) {
          const code = generateCode(random);
          const hash = await codeHash(code);
          if (seen.has(hash)) continue;
          seen.add(hash);
          const seed = seedOf(code);
          codes.push({ code, hash, seed, key: beamPubKey(secp256k1.getPublicKey(secretOf(seed), true)), value: BigInt(values[codes.length]) });
        }
        const total = codes.reduce((s, c) => s + c.value, 0n);
        const fee = v3CreationFee(total);
        const gasTotal = gasPerVoucher * BigInt(codes.length);
        if (total + fee + (assetId === 0 ? gasTotal : 0n) > I64_MAX) throw new RangeError('more than one batch can hold'); // i18n-ignore: internal invariant, never shown (the create screen checks it first)
        const a = v3args.createBatch({ assetId, gasPerVoucher, entries: codes });
        const at = now();
        const batch = {
          localId: `batch_${at.getTime()}_${toHex(random(4))}`,
          contractId: V3_CID,
          assetId,
          createdAt: at.toISOString(),
          txId: null,
          txStatus: TX_STATUS.unconfirmed,
          gasPerVoucher: String(gasPerVoucher),
          creatorKey: null,
          batchId: null,
          check: null,
          codes: codes.map((c) => ({ code: c.code, hash: c.hash, key: c.key, value: String(c.value), status: CODE_STATUS.unknown })),
        };
        for (const c of codes) c.seed.fill(0);
        let built = null;
        let saved = false;
        let shown = false;
        let txId;
        try {
          txId = await transact(a, {
            intent: { action: 'airdropCreate', count: codes.length, notes: gasTotal ? [t('{amount} BEAM of this pays the claim fee of each code, so people with an empty wallet can claim. Whoever claims keeps what is left of it.', { amount: groth8(gasTotal) })] : [] },
            inspect: async (raw, output) => {
              const d = checkBuiltCall(raw, { cid: V3_CID, args: a, method: V3_METHOD.createBatch, charge: createCharge(codes.length), comment: V3_KERNEL.createBatch });
              const got = d.entries[0].args;
              const r = new ArgsReader(got);
              const creatorKey = r.pubKey();
              if (!KEY_RE.test(creatorKey)) builtWrong('no creator key'); // i18n-ignore: builtWrong() detail for logs, never shown
              const want = concat(fromHex(creatorKey), le(assetId, 4), le(codes.length, 4), le(gasPerVoucher, 8), ...codes.flatMap((c) => [fromHex(c.key), le(c.value, 8)]));
              if (!bytesEqual(got, want)) builtWrong('the batch arguments differ from the request'); // i18n-ignore: builtWrong() detail for logs, never shown
              if (output && ((output.total !== undefined && BigInt(output.total) !== total) || (output.fee !== undefined && BigInt(output.fee) !== fee) || (output.gas_total !== undefined && BigInt(output.gas_total) !== gasTotal))) builtWrong('the batch totals differ'); // i18n-ignore: builtWrong() detail for logs, never shown
              expectExactFunds(d, fundsOf(assetId, total + fee, gasTotal, 1n), 'the batch'); // i18n-ignore: builtWrong() detail for logs, never shown
              if (d.fee !== createFee(codes.length)) builtWrong(`a network fee of ${d.fee} groth`); // i18n-ignore: builtWrong() detail for logs, never shown
              built = d;
              batch.creatorKey = creatorKey;
              await saveBeforeSigning(vault, batch);
              saved = true;
            },
            expect: (req) => {
              const problem = consentMatches(() => built)(req);
              if (!problem) shown = true;
              return problem;
            },
          });
        } catch (e) {
          // Never shown for approval, declined, or refused by the wallet: it cannot have reached the
          // network. Anything else (a timeout, a lock after approving) does not prove that.
          if (saved && (!shown || e.code === 'rejected' || e.code === 'rpc' || e.code === 'privileged')) await vault.put({ ...batch, txStatus: TX_STATUS.failed }).catch(() => {});
          throw e;
        }
        const sent = { ...batch, txId, txStatus: TX_STATUS.broadcast };
        await vault.put(sent).catch(() => {});
        return { txId, batch: sent, total, fee, gasTotal, built };
      });
    },

    /**
     * Where a saved v3 batch stands, and the check before its codes are shared, run when it is due:
     *   ready     checked: every code is on the network under this wallet's batch (saved, never re-run)
     *   failed    checked and refused (problem: CHECK_PROBLEM_TEXT key); new codes are needed
     *   notSent   the create never went through: the codes hold nothing (onChain: it reached the network)
     *   waiting   the create is not confirmed CONFIRMATIONS_BEFORE_CHECK times yet (confirmations)
     *   checking  reported through onProgress(done, total) while the codes are looked up
     * A lookup that fails throws; nothing is saved then, and the next call tries again.
     */
    async verifyBatch(localId, { onProgress = () => {} } = {}) {
      /**
       * A checked batch's codes as the network has them now: claimed, still claimable, or taken back (a
       * voucher no longer in the batch). One read each time the codes are shown; a failed read keeps the saved
       * statuses. Without it a batch read "Ready to share" with every code "Not claimed" forever (audit 0.2.16).
       */
      async function liveCodes(vault, rec) {
        if (!rec.batchId) return rec;
        let b;
        try {
          b = await svc.viewBatch(rec.batchId);
        } catch {
          return rec;
        }
        const byKey = new Map(b.vouchers.map((v) => [v.key, v]));
        const codes = rec.codes.map((c) => {
          const v = byKey.get(c.key);
          const status = !v ? CODE_STATUS.takenBack : v.redeemed ? CODE_STATUS.claimed : CODE_STATUS.available;
          return status === c.status ? c : { ...c, status };
        });
        if (codes.every((c, i) => c === rec.codes[i])) return rec;
        const next = { ...rec, codes };
        await vault.put(next);
        return next;
      }
      const vault = await deps.vault();
      const rec = (await vault.all()).find((b) => b.localId === localId);
      if (!rec) throw new AirdropError('unexpected', t('This batch is not among the codes saved on this device.'));
      if (rec.contractId !== V3_CID) return { state: 'old', batch: rec };
      if (rec.check && rec.check.state === CHECK_STATE.ok) return { state: 'ready', batch: await liveCodes(vault, rec) };
      if (rec.check && rec.check.state === CHECK_STATE.failed) return { state: 'failed', batch: rec, problem: rec.check.problem };
      if (rec.txStatus === TX_STATUS.failed) return { state: 'notSent', batch: rec, onChain: false };
      let mined = false;
      if (rec.txId && deps.txStatus) {
        const txs = await deps.txStatus(rec.txId);
        const st = Number(txs && txs.status);
        if (st === 2 || st === 4) {
          const failed = { ...rec, txStatus: TX_STATUS.failed };
          await vault.put(failed);
          return { state: 'notSent', batch: failed, onChain: st === 4 };
        }
        if (st !== 3) return { state: 'waiting', batch: rec, confirmations: 0 };
        const confirmations = Number(txs.confirmations) || 0;
        if (confirmations < CONFIRMATIONS_BEFORE_CHECK) return { state: 'waiting', batch: rec, confirmations };
        mined = true;
      }
      onProgress(0, rec.codes.length);
      const r = await squatCheck({ batch: rec, lookup: (c) => svc.checkVoucher(c), myBatches: () => svc.myBatches(), viewBatch: (id) => svc.viewBatch(id), onProgress });
      // Without its transaction id (a timeout while sending), a batch nowhere to be found may still be on its way.
      if (!r.ok && !mined && !rec.txId && r.problem === 'notFound' && r.index === 0) return { state: 'waiting', batch: rec, confirmations: null };
      // Found without its transaction id: it still waits the same confirmations, counted from the block that
      // holds it (a short reorganisation could undo a batch seen in the newest block; release audit 0.2.16).
      if (r.ok && !mined && !rec.txId && deps.tipHeight) {
        const [b, tip] = await Promise.all([svc.viewBatch(r.batchId), deps.tipHeight()]);
        const confirmations = Math.max(0, Number(tip) - (Number(b.createdAtHeight) + 1));
        if (!(confirmations >= CONFIRMATIONS_BEFORE_CHECK)) return { state: 'waiting', batch: rec, confirmations };
      }
      const next = {
        ...rec,
        txStatus: r.ok || mined ? TX_STATUS.confirmed : rec.txStatus,
        batchId: r.ok ? String(r.batchId) : rec.batchId || null,
        check: { state: r.ok ? CHECK_STATE.ok : CHECK_STATE.failed, at: now().toISOString(), problem: r.ok ? null : r.problem, index: r.ok ? null : r.index },
        codes: rec.codes.map((c) => ({ ...c, status: r.ok && c.status === CODE_STATUS.unknown ? CODE_STATUS.available : c.status })),
      };
      await vault.put(next);
      return r.ok ? { state: 'ready', batch: next } : { state: 'failed', batch: next, problem: r.problem, mined };
    },

    /**
     * Takes back every unclaimed code of a v3 batch of this wallet. Their codes stop working, their
     * values and prepaid fees come back. A claim that lands while this is prepared changes what the
     * shader lists: refused ('changed'), so the screen reads the batch again. A claim mined first
     * makes the sent take-back fail on the network, with nothing moved.
     */
    cancelBatch(batchId) {
      return lock.run(async () => {
        const id = BigInt(batchId);
        const mine = await svc.myBatches();
        let row = mine.batches.find((b) => b.id === id) || null;
        if (!row && mine.truncated) {
          const b = await svc.viewBatch(id);
          const open = b.vouchers.filter((v) => !v.redeemed);
          row = { id, assetId: b.assetId, unclaimed: open.length, valueUnclaimed: open.reduce((s, v) => s + v.value, 0n), gasPerVoucher: b.gasPerVoucher };
        }
        if (!row) throw new AirdropError('batchNotFound', t(MESSAGES.batchNotFound));
        if (!row.unclaimed) throw new AirdropError('nothingToCancel', t(MESSAGES.nothingToCancel));
        const n = row.unclaimed;
        const gasBack = row.gasPerVoucher * BigInt(n);
        const saved = (await deps.vault().then((v) => v.all()).catch(() => [])).find((s) => s.contractId === V3_CID && s.batchId === String(id)) || null;
        const a = v3args.cancelBatch({ batchId: id });
        let built = null;
        const txId = await transact(a, {
          intent: { action: 'airdropCancel', count: n },
          inspect: (raw) => {
            // How many codes the shader found unclaimed now, before anything else: a claim in between is not a fault.
            let listed = null;
            try {
              const e = readContractTx(raw).entries;
              if (e.length === 1 && e[0].contractId === V3_CID && e[0].method === V3_METHOD.cancelBatch && e[0].args.length >= 45) listed = Number(new ArgsReader(e[0].args.subarray(41, 45)).u32());
            } catch {
              /* checked in full below */
            }
            if (listed !== null && listed !== n) throw new AirdropError('changed', t('Some codes were claimed while this was being prepared. Nothing was sent. Look at the batch again, then take back what is left.'));
            const d = checkBuiltCall(raw, { cid: V3_CID, args: a, method: V3_METHOD.cancelBatch, charge: cancelCharge(n), comment: V3_KERNEL.cancelBatch });
            const r = new ArgsReader(d.entries[0].args);
            const creator = r.pubKey();
            if (!KEY_RE.test(creator)) builtWrong('no creator key'); // i18n-ignore: builtWrong() detail for logs, never shown
            if (saved && saved.creatorKey && creator !== saved.creatorKey) builtWrong('another creator key'); // i18n-ignore: builtWrong() detail for logs, never shown
            if (r.u64() !== id) builtWrong('another batch'); // i18n-ignore: builtWrong() detail for logs, never shown
            if (r.u32() !== n || r.remaining !== 33 * n) builtWrong('the batch changed while preparing; try again'); // i18n-ignore: builtWrong() detail for logs, never shown
            const keys = new Set();
            for (let i = 0; i < n; i++) keys.add(r.pubKey());
            if (keys.size !== n || [...keys].some((k) => !KEY_RE.test(k))) builtWrong('repeated or broken voucher keys'); // i18n-ignore: builtWrong() detail for logs, never shown
            if (saved && saved.codes.every((c) => c.key) && ![...keys].every((k) => saved.codes.some((c) => c.key === k))) builtWrong('a voucher that is not one of this batch\'s codes'); // i18n-ignore: builtWrong() detail for logs, never shown
            expectExactFunds(d, fundsOf(row.assetId, row.valueUnclaimed, gasBack, -1n), 'the take-back'); // i18n-ignore: builtWrong() detail for logs, never shown
            if (d.fee !== cancelFee(n)) builtWrong(`a network fee of ${d.fee} groth`); // i18n-ignore: builtWrong() detail for logs, never shown
            built = d;
          },
          expect: consentMatches(() => built),
        });
        return { txId, batch: row, count: n, total: row.valueUnclaimed, gas: gasBack, built };
      });
    },
  };
  // Every call first loads the curve code (cryptoReady): none of it comes with the first paint. Getters
  // (busy) stay as they are.
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(svc))) {
    if (typeof d.value !== 'function') continue;
    const f = d.value;
    // Once loaded, straight through: a create takes its lock in the same tick, as before.
    svc[k] = (...args) => (curveLib && hashLib ? f.apply(svc, args) : cryptoReady().then(() => f.apply(svc, args)));
  }
  return svc;
}

/** groth as BEAM text with every digit ("0.022"), for the approve sheet's notes. */
function groth8(g) {
  const v = BigInt(g);
  const whole = v / 100000000n;
  const frac = (v % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

// ---------------------------------------------------------------- both contracts

/**
 * The airdrop as the screens see it: new codes on v3 only; a code is looked up on v3 first and then
 * on the old contract (README Migration), and claimed where it was found; each contract's batches
 * are listed and taken back on their own contract.
 */
export function createAirdrops({ v3, old }) {
  const busy = () => new AirdropError('busy', t('Another airdrop transaction is in progress. Finish or cancel it first.'));
  const svc = {
    v3,
    old,
    get busy() {
      return v3.busy || old.busy;
    },

    /** v3 first, then the old contract: info with contract 'v3' or 'v2', or null when neither has the code. */
    async checkVoucher(code) {
      const a = await v3.checkVoucher(code);
      if (a) return a;
      const b = await old.checkVoucher(code);
      return b ? { ...b, contract: 'v2', gas: 0n } : null;
    },

    /**
     * Claims on whichever contract has the code. A second claim while one is open is refused at once.
     * The old contract's claim carries the code itself, so the network sees it; and v3 and old codes
     * look alike, so a node that lies ("not on v3", "found on the old one") could make a v3 code go
     * out that way (release audit 1.3.0, B2). An old-contract claim is therefore refused unless the
     * person agreed to it on the screen that says so (oldConsent: true).
     */
    async redeem(code, { oldConsent = false } = {}) {
      if (svc.busy) throw busy();
      const info = await svc.checkVoucher(code);
      if (!info) throw new AirdropError('voucherNotFound', t(MESSAGES.voucherNotFound));
      if (info.contract === 'v3') return v3.redeem(code);
      if (oldConsent !== true) throw new AirdropError('oldNeedsConsent', t('This code is from the old airdrop contract. Claiming it there shows the code to the network.'));
      const r = await old.redeem(code);
      return { ...r, info: { ...r.info, contract: 'v2', gas: 0n } };
    },

    /** Every new batch is made on v3. */
    createBatch(opts) {
      return v3.createBatch(opts);
    },

    savedBatches: () => v3.savedBatches(),
    verifyBatch: (localId, opts) => v3.verifyBatch(localId, opts),

    /** Takes a batch back on its own contract: contract 'v3' or 'v2'. */
    cancelBatch({ contract, batchId }) {
      return contract === 'v3' ? v3.cancelBatch(batchId) : old.cancelBatch(batchId);
    },
  };
  return svc;
}

// ---------------------------------------------------------------- live wiring

let live = null;

/**
 * Both airdrop contracts on the running wallet's own app, each with its pinned shader, sharing one
 * transaction at a time. One per wallet session.
 *   vault() -> the code vault;  txStatus(txId) -> the wallet's tx_status
 */
export function airdropFor(session, { vault, txStatus, tipHeight }) {
  if (live && live.session === session) return live.svc;
  const lock = airdropLock();
  const wire = (key) => {
    const withApp = () => Promise.all([nativeApp(), loadShader(key)]);
    return {
      view: async (a) => {
        const [app, shader] = await withApp();
        return app.view(a, shader, { timeoutMs: 120000 });
      },
      transact: async (a, opts) => {
        const [app, shader] = await withApp();
        return app.transact(a, shader, { ...opts, timeoutMs: 120000 });
      },
    };
  };
  const old = createAirdrop({ ...wire('airdrop'), vault, lock });
  const v3 = createAirdropV3({ ...wire('airdropV3'), vault, lock, txStatus, tipHeight });
  const svc = createAirdrops({ v3, old });
  live = { session, svc };
  return svc;
}

