// The Ethereum key at rest. The Ethereum wallet has its own recovery words
// (as in the desktop app); they are never stored, only the 32-byte key
// derived from them, sealed under the BEAM wallet's database password
// (app.dbPass). The password and passkey envelopes in lib/session.js already
// open dbPass, so unlocking, Face ID and Change password need nothing new,
// and locking (which forgets dbPass) also locks the Ethereum key.
//
// Key-encryption key:
//   created or restored-from-words wallets: dbPass is 32 random bytes (64 hex)
//     → HKDF-SHA256(dbPass bytes, random 16-byte salt, info "beam-campfire-eth-key-v1")
//   wallets imported from a wallet.db: dbPass is that file's password, which a
//     person chose and can be guessed → PBKDF2-SHA256(dbPass, salt, >= 600,000
//     rounds), no easier to attack than the password envelope itself.
// The envelope is AES-256-GCM over sk ‖ address (52 bytes) with every
// envelope field bound as additional data, so a lowered round count, a
// swapped KDF or another wallet's id makes it fail to open. The address is
// derived again from the opened key and must match.

import { privateKeyToAddress, wipe, ETH_PATH } from './crypto.js';
import { hexToBytes, bytesToHex, concatBytes } from './hex.js';
import { PBKDF2_MIN_ITERATIONS, randomBytes, toHex, b64, unb64 } from '../envelope.js';
import { store } from '../store.js';
import { ETH_RECORD_KEY } from './record.js';

export { ETH_RECORD_KEY };
export const ETH_KEY_INFO = 'beam-campfire-eth-key-v1';
export const KDF_HKDF = 'hkdf-sha256';
export const KDF_PBKDF2 = 'pbkdf2-sha256';
const VERSION = 1;
const KIND = 'eth-key';
// Above this, opening would hang the page for minutes: a corrupted or hostile record.
const MAX_ITERATIONS = 20000000;

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'locked' | 'missing' | 'exists' | 'wrong_secret' | 'malformed' | 'weak' | 'mismatch'
  }
}

/** Which KDF a wallet's Ethereum envelope must use. */
export function kdfFor(imported) {
  return imported ? KDF_PBKDF2 : KDF_HKDF;
}

function aad(env) {
  return enc.encode(JSON.stringify([env.v, env.kind, env.walletId, env.ethId, env.kdf, env.iterations || 0, env.salt]));
}

/**
 * The AES-256-GCM key-encryption key for an envelope {kdf, salt, iterations?}
 * under dbPass. `info` separates uses (the key itself, the data sealed beside it).
 */
export async function deriveWrappingKey(env, dbPass, info = ETH_KEY_INFO) {
  if (typeof dbPass !== 'string' || dbPass.length === 0) throw new VaultError('locked', 'Unlock the wallet first.');
  const salt = unb64(env.salt);
  if (env.kdf === KDF_HKDF) {
    if (!/^[0-9a-f]{64}$/.test(dbPass)) throw new VaultError('malformed', "This wallet's database password is not a random one; it cannot use HKDF.");
    const ikm = hexToBytes(dbPass);
    try {
      const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
      return await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } finally {
      wipe(ikm);
    }
  }
  const pw = enc.encode(dbPass.normalize('NFC'));
  try {
    const base = await subtle().importKey('raw', pw, 'PBKDF2', false, ['deriveKey']);
    return await subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: env.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    wipe(pw);
  }
}

/**
 * The AES-256-GCM key for another envelope sealed under the same dbPass (the
 * bridge's crossing records): env {kdf, salt, iterations?}, a different HKDF
 * `info` per purpose. The same derivation and checks as the Ethereum key's.
 */
export async function sealingKey(env, dbPass, info) {
  if (typeof info !== 'string' || !info || info === ETH_KEY_INFO) throw new VaultError('malformed', 'A sealing key needs its own purpose.');
  if (env.kdf !== KDF_HKDF && env.kdf !== KDF_PBKDF2) throw new VaultError('malformed', 'Unknown key derivation.');
  if (env.kdf === KDF_PBKDF2) checkIterations(env.iterations);
  return deriveWrappingKey(env, dbPass, info);
}

export function checkIterations(n) {
  if (!Number.isSafeInteger(n)) throw new VaultError('malformed', 'Bad PBKDF2 round count.');
  if (n < PBKDF2_MIN_ITERATIONS) throw new VaultError('weak', 'Too few PBKDF2 rounds; refusing.');
  if (n > MAX_ITERATIONS) throw new VaultError('malformed', 'Implausible PBKDF2 round count.');
}

function addressMatches(sk, address) {
  try {
    return privateKeyToAddress(sk).toLowerCase() === String(address).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Seals {sk, address} for the BEAM wallet `walletId`.
 * imported: whether that wallet came from a wallet.db (see the top of this file).
 */
export async function sealEthKey({ sk, address, dbPass, walletId, imported, ethId = toHex(randomBytes(8)), iterations = PBKDF2_MIN_ITERATIONS }) {
  if (typeof walletId !== 'string' || !walletId) throw new VaultError('missing', 'No BEAM wallet to seal the Ethereum key under.');
  if (!(sk instanceof Uint8Array) || sk.length !== 32 || !addressMatches(sk, address)) throw new VaultError('mismatch', 'The key does not belong to that address.');
  const kdf = kdfFor(imported);
  const env = { v: VERSION, kind: KIND, walletId, ethId, kdf, salt: b64(randomBytes(16)) };
  if (kdf === KDF_PBKDF2) {
    checkIterations(iterations);
    env.iterations = iterations;
  }
  const iv = randomBytes(12);
  const pt = concatBytes(sk, hexToBytes(address));
  try {
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(env) }, await deriveWrappingKey(env, dbPass), pt);
    return { ...env, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  } finally {
    wipe(pt);
  }
}

/**
 * Opens an envelope → {sk, address}. The caller zeroes sk (wipe) when done;
 * withEthKey() does it for you.
 */
export async function openEthKey(env, { dbPass, walletId, imported }) {
  if (!env || env.v !== VERSION || env.kind !== KIND || typeof env.walletId !== 'string' || typeof env.ethId !== 'string') throw new VaultError('malformed', 'Not an Ethereum key envelope.');
  if (typeof env.salt !== 'string' || typeof env.iv !== 'string' || typeof env.ct !== 'string') throw new VaultError('malformed', 'Envelope fields missing.');
  if (env.walletId !== walletId) throw new VaultError('mismatch', 'This Ethereum key belongs to another BEAM wallet.');
  const want = kdfFor(imported);
  if (env.kdf !== want) {
    // An imported wallet's key under HKDF would be one guessed password away.
    throw new VaultError(want === KDF_PBKDF2 ? 'weak' : 'malformed', 'This envelope uses the wrong key derivation for this wallet; refusing it.');
  }
  if (env.kdf === KDF_PBKDF2) checkIterations(env.iterations);
  else if (env.iterations !== undefined) throw new VaultError('malformed', 'Unexpected round count.');
  const key = await deriveWrappingKey(env, dbPass);
  let pt;
  try {
    pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: aad(env) }, key, unb64(env.ct)));
  } catch {
    throw new VaultError('wrong_secret', 'The Ethereum key did not open.');
  }
  try {
    if (pt.length !== 52) throw new VaultError('malformed', 'Bad Ethereum key length.');
    const sk = pt.slice(0, 32);
    const address = privateKeyToAddress(sk);
    if (address.toLowerCase() !== bytesToHex(pt.subarray(32))) {
      wipe(sk);
      throw new VaultError('mismatch', 'The opened key does not match its address.');
    }
    return { sk, address };
  } finally {
    wipe(pt);
  }
}

// ---------------------------------------------------------------- record and app adapter
//
// The record lives next to the wallet record in the app's own store
// ("beam-campfire-app", key 'eth'), so wipeWallet()'s store.clear() removes
// it with the BEAM wallet:
//   {v, id, createdAt, words, passphrase, path, envelope}
// words: 12 or 24 (how many the person has written down); passphrase:
// whether a BIP39 passphrase was used (never the passphrase itself). The
// address is only inside the envelope: in the clear it would link this BEAM
// wallet to a public Ethereum address for anyone who can read the storage.

/** {walletId, imported, dbPass} of the unlocked BEAM wallet, or a VaultError. */
export function walletOf(app) {
  if (!app || !app.record || typeof app.record.id !== 'string') throw new VaultError('missing', 'There is no BEAM wallet on this device.');
  if (!app.dbPass) throw new VaultError('locked', 'Unlock the wallet first.');
  // record.imported is what lib/session.js isImported() reads; read directly so
  // this module does not pull in the engine.
  return { walletId: app.record.id, imported: Boolean(app.record.imported), dbPass: app.dbPass };
}

export async function getEthRecord(kv = store) {
  return (await kv.get(ETH_RECORD_KEY)) || null;
}

/** Seals and stores a freshly derived key. Refuses to replace one unless asked. */
export async function saveEthKey(app, { sk, address, words, passphrase = false, path = ETH_PATH }, { kv = store, replace = false } = {}) {
  const w = walletOf(app);
  if (words !== 12 && words !== 24) throw new VaultError('malformed', 'An Ethereum wallet has 12 or 24 words.');
  if (!replace && (await getEthRecord(kv))) throw new VaultError('exists', 'This device already has an Ethereum wallet.');
  const envelope = await sealEthKey({ sk, address, dbPass: w.dbPass, walletId: w.walletId, imported: w.imported });
  const record = { v: VERSION, id: envelope.ethId, createdAt: Date.now(), words, passphrase: Boolean(passphrase), path, envelope };
  await kv.set(ETH_RECORD_KEY, record);
  return record;
}

/** Opens the stored key → {sk, address}; the caller wipes sk. */
export async function openEthKeyFor(app, kv = store) {
  const w = walletOf(app);
  const record = await getEthRecord(kv);
  if (!record) throw new VaultError('missing', 'There is no Ethereum wallet on this device.');
  if (record.v !== VERSION || !record.envelope || record.envelope.ethId !== record.id) throw new VaultError('malformed', 'Not an Ethereum wallet record.');
  return openEthKey(record.envelope, w);
}

/** Runs fn({sk, address}) with the key open, and zeroes the key afterwards whatever happens. */
export async function withEthKey(app, fn, kv = store) {
  const k = await openEthKeyFor(app, kv);
  try {
    return await fn(k);
  } finally {
    wipe(k.sk);
  }
}

export async function removeEthKey(kv = store) {
  await kv.del(ETH_RECORD_KEY);
}
