// Crossings as this device remembers them, and where they are kept. A port of
// the desktop app's bridge_crossing.dart (the record) and bridge_store.dart (its
// store), sealed like the Ethereum key (lib/eth/vault.js).
//
// A record is the only thing that ties a BEAM transaction to the Ethereum
// payout it pays for (or an Ethereum lock to the BEAM claim), so the controller
// writes it before every step that cannot be undone and right after each one
// returns, and it survives the page being closed. Stricter than a plain list,
// because a lost record can mean coins nobody claims:
//
// * each record is sealed on its own with AES-256-GCM under a key from the BEAM
//   wallet's database password (app.dbPass): HKDF-SHA256, info
//   "beam-campfire-bridge-data-v1", for created wallets; PBKDF2 >= 600,000 rounds
//   for wallets imported from a wallet.db (their dbPass is a chosen password).
//   Every header field is bound as additional data, and a sealed check value
//   tells a wrong key from a damaged record;
// * a wrong key (another password, another wallet) is refused outright: nothing
//   is read and nothing is written over;
// * a record that does not open, or that this version cannot read, is kept as
//   it was and written back unchanged, never dropped;
// * once a crossing knows its bridge message id, no other crossing of the same
//   route and direction may have it (BridgeStoreError 'conflict');
// * the whole list goes in one write of one key (IndexedDB puts are atomic), and
//   the store only says it has a record once that write succeeded.
//
// Storage is an injected {get, set} (lib/store.js's IndexedDB in the app, a Map
// in tests). Nothing in the clear links this BEAM wallet to an Ethereum address.

import { routeById } from './routes.js';
import { sealingKey, kdfFor, KDF_PBKDF2, VaultError } from '../eth/vault.js';
import { PBKDF2_MIN_ITERATIONS, randomBytes, b64, unb64 } from '../envelope.js';

export const BRIDGE_DATA_INFO = 'beam-campfire-bridge-data-v1';
export const BRIDGE_RECORD_KEY = 'bridge';
const VERSION = 1;
const KIND = 'bridge-crossings';
const CHECK = 'beam-campfire bridge records';

export class BridgeStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'locked' | 'missing' | 'wrong_secret' | 'malformed' | 'weak' | 'mismatch' | 'conflict'
  }
}

// ---------------------------------------------------------------- the record

/**
 * Where a crossing is.
 *
 * To Ethereum: sending → sent → confirmed → paid, or waitingForGas on the way,
 * or failed (nothing left the wallet), or unknown (the BEAM wallet did not say
 * whether it sent).
 *
 * To BEAM: approving → locking → locked → delivered → claiming → claimed, or
 * notDeliveredYet on the way, or lockFailed (nothing was locked), or unknown.
 */
export const STATES = Object.freeze({
  /** To Ethereum: the BEAM transaction is being handed to the wallet (its consent sheet). */
  sending: 'sending',
  /** To Ethereum: the BEAM transaction is sent (beamTxId). */
  sent: 'sent',
  /** To Ethereum: mined at `height` as BEAM-side message msgId; the bridge pays after 61 blocks. */
  confirmed: 'confirmed',
  /** To Ethereum: the coins are in the Ethereum wallet. */
  paid: 'paid',
  /** To Ethereum: due, not paid: Ethereum gas costs more right now than the fee paid; the bridge retries. */
  waitingForGas: 'waitingForGas',
  /** To Ethereum: the BEAM transaction failed or was not approved; nothing left the wallet. */
  failed: 'failed',
  /** To BEAM: letting the bridge take the token (one or two Ethereum transactions before the lock). */
  approving: 'approving',
  /** To BEAM: the lock is being signed, or is sent (lockHash) and not yet mined. */
  locking: 'locking',
  /** To BEAM: locked on Ethereum as message msgId. */
  locked: 'locked',
  /** To BEAM: the bridge brought it to BEAM; it is ready to collect. */
  delivered: 'delivered',
  /** To BEAM: the claim is being sent, or is sent (claimTxId). */
  claiming: 'claiming',
  /** To BEAM: the coins are in the BEAM wallet. */
  claimed: 'claimed',
  /** To BEAM: the lock did not happen; nothing was locked. */
  lockFailed: 'lockFailed',
  /** To BEAM: locked more than 30 minutes ago and not on BEAM yet. */
  notDeliveredYet: 'notDeliveredYet',
  /** A transaction may or may not have gone out. Campfire keeps looking; it never sends again by itself. */
  unknown: 'unknown',
});

export const DIRECTIONS = Object.freeze({ toEthereum: 'toEthereum', toBeam: 'toBeam' });

const FINAL = new Set([STATES.paid, STATES.failed, STATES.claimed, STATES.lockFailed]);
const STATE_SET = new Set(Object.values(STATES));
const DIRECTION_SET = new Set(Object.values(DIRECTIONS));

/** Nothing more will happen to it. */
export const isFinal = (state) => FINAL.has(state);
/** It ended with the coins where the person wanted them. */
export const isDone = (state) => state === STATES.paid || state === STATES.claimed;
export const isOpen = (c) => !FINAL.has(c.state);

const BIG = ['amount', 'receives', 'relayerFee', 'beamNetworkFee', 'ethNetworkFee'];
const TEXT = ['id', 'beamWalletId', 'ethWalletId', 'ethAddress'];
const OPTIONAL_TEXT = ['beamReceiveKey', 'lockHash', 'lockRaw', 'beamTxId', 'claimTxId', 'lastError'];
const OPTIONAL_INT = ['msgId', 'countBefore', 'height', 'lockNonce'];
const TIMES = ['createdAt', 'updatedAt'];
const OPTIONAL_TIMES = ['dueAt', 'lockedAt', 'deliveredAt', 'claimStartedAt', 'finishedAt'];

function bad(field) {
  return new TypeError(`crossing: bad ${field}`);
}

/**
 * A checked, frozen crossing record. Amounts are BigInt in each chain's own
 * smallest unit; times are ms since 1970; absent fields are null.
 *   amount        what leaves the source wallet besides the fees (groth to Ethereum, Ethereum units to BEAM)
 *   receives      what arrives (Ethereum units to Ethereum, groth to BEAM)
 *   relayerFee    the bridge fee, source units
 *   beamNetworkFee groth: of the send (to Ethereum) or of the claim (to BEAM)
 *   ethNetworkFee wei: to BEAM, the most the Ethereum transactions could cost
 *   ethAddress    the Ethereum wallet: paid to Ethereum, the sender to BEAM
 *   beamReceiveKey to BEAM: the 33-byte key the BEAM pipe pays, hex
 *   approveHashes to BEAM: the allowance transactions, in order
 *   lockHash, lockRaw, lockNonce  to BEAM: the signed sendFunds, written before it is broadcast
 *   beamTxId      to Ethereum: the BEAM send; claimTxId: to BEAM, the claim
 *   msgId         the bridge's message id (BEAM-side to Ethereum, Ethereum-side to BEAM)
 *   countBefore   to Ethereum: the BEAM pipe's message count just before the send
 *   height        to Ethereum: the BEAM block of the send; to BEAM: the Ethereum block of the lock
 */
export function makeCrossing(f) {
  const c = {};
  routeById(f.route);
  c.route = f.route;
  if (!DIRECTION_SET.has(f.direction)) throw bad('direction');
  c.direction = f.direction;
  if (!STATE_SET.has(f.state)) throw bad('state');
  c.state = f.state;
  for (const k of TEXT) {
    if (typeof f[k] !== 'string' || !f[k]) throw bad(k);
    c[k] = f[k];
  }
  for (const k of BIG) {
    const v = f[k] ?? (k === 'ethNetworkFee' ? 0n : undefined);
    if (typeof v !== 'bigint' || v < 0n) throw bad(k);
    c[k] = v;
  }
  for (const k of OPTIONAL_TEXT) {
    const v = f[k] ?? null;
    if (v !== null && typeof v !== 'string') throw bad(k);
    c[k] = v;
  }
  for (const k of OPTIONAL_INT) {
    const v = f[k] ?? null;
    if (v !== null && (!Number.isSafeInteger(v) || v < 0)) throw bad(k);
    c[k] = v;
  }
  for (const k of TIMES) {
    if (!Number.isSafeInteger(f[k])) throw bad(k);
    c[k] = f[k];
  }
  for (const k of OPTIONAL_TIMES) {
    const v = f[k] ?? null;
    if (v !== null && !Number.isSafeInteger(v)) throw bad(k);
    c[k] = v;
  }
  const hashes = f.approveHashes ?? [];
  if (!Array.isArray(hashes) || hashes.some((h) => typeof h !== 'string')) throw bad('approveHashes');
  c.approveHashes = Object.freeze([...hashes]);
  return Object.freeze(c);
}

/** `c` with `patch` applied (a null clears an optional field). */
export function changeCrossing(c, patch) {
  return makeCrossing({ ...c, ...patch });
}

export function crossingToJson(c) {
  const j = { v: VERSION };
  for (const [k, v] of Object.entries(c)) {
    if (v === null) continue;
    if (k === 'approveHashes' && v.length === 0) continue;
    j[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return j;
}

const DECIMAL = /^(0|[1-9]\d*)$/;

/** Throws for anything this version cannot read (an unknown state is refused, never guessed). */
export function crossingFromJson(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.v !== VERSION) throw new TypeError('crossing: not a version 1 record');
  const f = { ...j };
  delete f.v;
  for (const k of BIG) {
    if (f[k] === undefined && k === 'ethNetworkFee') continue;
    if (typeof f[k] !== 'string' || !DECIMAL.test(f[k])) throw bad(k);
    f[k] = BigInt(f[k]);
  }
  const known = new Set(['route', 'direction', 'state', 'approveHashes', ...BIG, ...TEXT, ...OPTIONAL_TEXT, ...OPTIONAL_INT, ...TIMES, ...OPTIONAL_TIMES]);
  for (const k of Object.keys(f)) if (!known.has(k)) throw bad(k);
  return makeCrossing(f);
}

/** Throws (conflict) when c's message id belongs to another crossing of the same route and direction in `others`. */
export function checkUnique(c, others) {
  if (c.msgId === null || c.msgId === undefined) return;
  for (const o of others) {
    if (o.id !== c.id && o.msgId === c.msgId && o.route === c.route && o.direction === c.direction) {
      throw new BridgeStoreError('conflict', `${c.route} ${c.direction} message ${c.msgId} is already crossing ${o.id}`);
    }
  }
}

const newestFirst = (list) => [...list].sort((a, b) => b.createdAt - a.createdAt);

// ---------------------------------------------------------------- stores

/** In memory, for tests: every save in order on .writes. */
export class MemoryBridgeStore {
  constructor() {
    this.byIdMap = new Map();
    this.writes = [];
    this.failWrites = false;
  }

  async all() {
    return newestFirst(this.byIdMap.values());
  }

  async byId(id) {
    return this.byIdMap.get(id) || null;
  }

  async save(c) {
    if (this.failWrites) throw new Error('storage is full');
    checkUnique(c, this.byIdMap.values());
    this.byIdMap.set(c.id, c);
    this.writes.push(c);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

function aad(h, purpose) {
  return enc.encode(JSON.stringify([h.v, h.kind, h.walletId, h.kdf, h.iterations || 0, h.salt, purpose]));
}

function header(h) {
  return { v: h.v, kind: h.kind, walletId: h.walletId, kdf: h.kdf, ...(h.iterations !== undefined ? { iterations: h.iterations } : {}), salt: h.salt };
}

const isSealed = (b) => b && typeof b === 'object' && typeof b.iv === 'string' && typeof b.ct === 'string';

async function seal(key, h, purpose, text) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(h, purpose) }, key, enc.encode(text));
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function open(key, h, purpose, box) {
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: aad(h, purpose) }, key, unb64(box.ct));
  return dec.decode(pt);
}

function vaultToStore(e) {
  if (e instanceof VaultError) return new BridgeStoreError(e.code, e.message);
  return e;
}

/**
 * The crossings of the BEAM wallet `walletId`, sealed under its dbPass, in
 * kv[BRIDGE_RECORD_KEY]. imported: whether that wallet came from a wallet.db.
 */
export class SealedBridgeStore {
  #key = null;
  #header = null;
  #check = null;
  #byId = null;
  #sealed = new Map();
  #unreadable = [];
  #loading = null;
  #queue = Promise.resolve();

  constructor({ kv, walletId, imported, dbPass, iterations = PBKDF2_MIN_ITERATIONS }) {
    if (!kv || typeof kv.get !== 'function' || typeof kv.set !== 'function') throw new TypeError('SealedBridgeStore needs a {get, set} storage');
    if (typeof walletId !== 'string' || !walletId) throw new BridgeStoreError('missing', 'No BEAM wallet to keep crossings for.');
    if (typeof dbPass !== 'string' || !dbPass) throw new BridgeStoreError('locked', 'Unlock the wallet first.');
    this.kv = kv;
    this.walletId = walletId;
    this.imported = Boolean(imported);
    this.dbPass = dbPass;
    this.iterations = iterations;
  }

  /** How many records were kept as they were because they did not open or could not be read. */
  get unreadableCount() {
    return this.#unreadable.length;
  }

  #load() {
    if (!this.#loading) {
      this.#loading = this.#read().catch((e) => {
        this.#loading = null;
        throw vaultToStore(e);
      });
    }
    return this.#loading;
  }

  async #read() {
    const env = await this.kv.get(BRIDGE_RECORD_KEY);
    const kdf = kdfFor(this.imported);
    if (env === undefined || env === null) {
      // Nothing yet: a header and a key now, the check value on the first write.
      const h = { v: VERSION, kind: KIND, walletId: this.walletId, kdf, salt: b64(randomBytes(16)) };
      if (kdf === KDF_PBKDF2) h.iterations = this.iterations;
      this.#key = await sealingKey(h, this.dbPass, BRIDGE_DATA_INFO);
      this.#header = h;
      this.#check = await seal(this.#key, h, 'check', CHECK);
      this.#byId = new Map();
      return;
    }
    if (!env || typeof env !== 'object' || env.v !== VERSION || env.kind !== KIND || typeof env.walletId !== 'string' || typeof env.salt !== 'string' || !isSealed(env.check) || !Array.isArray(env.records)) {
      throw new BridgeStoreError('malformed', 'The bridge records on this device are not readable by this version.');
    }
    if (env.walletId !== this.walletId) throw new BridgeStoreError('mismatch', 'These bridge records belong to another BEAM wallet.');
    if (env.kdf !== kdf) throw new BridgeStoreError(kdf === KDF_PBKDF2 ? 'weak' : 'malformed', 'The bridge records use the wrong key derivation for this wallet; refusing them.');
    if (kdf !== KDF_PBKDF2 && env.iterations !== undefined) throw new BridgeStoreError('malformed', 'Unexpected round count.');
    const h = header(env);
    const key = await sealingKey(h, this.dbPass, BRIDGE_DATA_INFO);
    let check;
    try {
      check = await open(key, h, 'check', env.check);
    } catch {
      check = null;
    }
    // Another password or a changed header: refuse it all, overwrite nothing.
    if (check !== CHECK) throw new BridgeStoreError('wrong_secret', 'The bridge records on this device did not open with this wallet.');
    const byId = new Map();
    for (const box of env.records) {
      try {
        if (!isSealed(box)) throw new Error('not sealed');
        const c = crossingFromJson(JSON.parse(await open(key, h, 'record', box)));
        if (byId.has(c.id)) throw new Error('duplicate');
        byId.set(c.id, c);
        this.#sealed.set(c.id, { iv: box.iv, ct: box.ct });
      } catch {
        // Damaged, or from a newer version: kept exactly as it was.
        this.#unreadable.push(box);
      }
    }
    this.#key = key;
    this.#header = h;
    this.#check = { iv: env.check.iv, ct: env.check.ct };
    this.#byId = byId;
  }

  /** Every crossing, newest first. */
  async all() {
    await this.#load();
    return newestFirst(this.#byId.values());
  }

  async byId(id) {
    await this.#load();
    return this.#byId.get(id) || null;
  }

  /** Writes c, replacing the one with its id; one write at a time, in order. */
  save(c) {
    const done = this.#queue.then(() => this.#save(c));
    this.#queue = done.catch(() => {});
    return done;
  }

  async #save(c) {
    await this.#load();
    const record = makeCrossing(c);
    checkUnique(record, this.#byId.values());
    const box = await seal(this.#key, this.#header, 'record', JSON.stringify(crossingToJson(record)));
    const sealed = new Map(this.#sealed);
    sealed.set(record.id, box);
    const byId = new Map(this.#byId);
    byId.set(record.id, record);
    const order = newestFirst(byId.values()).map((x) => sealed.get(x.id));
    await this.kv.set(BRIDGE_RECORD_KEY, { ...this.#header, check: this.#check, records: [...order, ...this.#unreadable] });
    // Only once it is stored does the store say it has it.
    this.#sealed = sealed;
    this.#byId = byId;
  }
}

/** The store for the unlocked wallet `app` ({record: {id, imported}, dbPass}) over `kv` ({get, set}). */
export function bridgeStoreFor(app, kv) {
  if (!app || !app.record || typeof app.record.id !== 'string') throw new BridgeStoreError('missing', 'There is no BEAM wallet on this device.');
  if (!app.dbPass) throw new BridgeStoreError('locked', 'Unlock the wallet first.');
  return new SealedBridgeStore({ kv, walletId: app.record.id, imported: Boolean(app.record.imported), dbPass: app.dbPass });
}
