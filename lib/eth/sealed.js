// Ethereum data that would link the BEAM wallet to a public Ethereum address
// if anyone who can read this device's storage could read it: what this
// device sent (a signed transaction names its sender), and later the bridge's
// crossings. Sealed like the key (lib/eth/vault.js): AES-256-GCM under a key
// derived from the BEAM wallet's database password, HKDF for created wallets
// and PBKDF2 >= 600,000 rounds for wallets imported from a wallet.db, with
// its own info string ("beam-campfire-eth-data-v1") so the data key is never
// the key's key.
//
// A record keeps its salt when it is rewritten, so the derived key is reused:
// a PBKDF2 wallet pays its 600,000 rounds once per unlock, not on every write.
// The derived keys are non-extractable and forgotten on lock
// (forgetDataKeys()). Every envelope field, the record's name and the
// Ethereum wallet it belongs to are bound as additional data.

import { VaultError, KDF_PBKDF2, kdfFor, deriveWrappingKey, checkIterations, walletOf } from './vault.js';
import { PBKDF2_MIN_ITERATIONS, randomBytes, b64, unb64 } from '../envelope.js';
import { store } from '../store.js';

export const ETH_DATA_INFO = 'beam-campfire-eth-data-v1';
const VERSION = 1;
const KIND = 'eth-data';
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

// "walletId|kdf|salt|iterations" -> {dbPass, key}; a key is used only with the dbPass it came from.
const cache = new Map();

async function keyFor(env, dbPass) {
  const id = [env.walletId, env.kdf, env.salt, env.iterations || 0].join('|');
  const hit = cache.get(id);
  if (hit && hit.dbPass === dbPass) return hit.key;
  const key = await deriveWrappingKey(env, dbPass, ETH_DATA_INFO);
  cache.set(id, { dbPass, key });
  return key;
}

/** Drops every derived data key (on lock, and when the Ethereum wallet is removed). */
export function forgetDataKeys() {
  cache.clear();
}

function aad(env) {
  return enc.encode(JSON.stringify([env.v, env.kind, env.name, env.walletId, env.ethId, env.kdf, env.iterations || 0, env.salt]));
}

function sameShape(env, name) {
  return Boolean(env) && env.v === VERSION && env.kind === KIND && env.name === name && typeof env.walletId === 'string' && typeof env.ethId === 'string' && typeof env.salt === 'string' && typeof env.iv === 'string' && typeof env.ct === 'string';
}

/** Seals `value` (JSON) as record `name` of the Ethereum wallet `ethId`. */
export async function sealData(app, name, value, { ethId, kv = store } = {}) {
  const w = walletOf(app);
  if (typeof ethId !== 'string' || !ethId) throw new VaultError('missing', 'No Ethereum wallet to seal the data for.');
  const kdf = kdfFor(w.imported);
  const prev = await kv.get(name);
  const reuse = sameShape(prev, name) && prev.walletId === w.walletId && prev.ethId === ethId && prev.kdf === kdf;
  const env = { v: VERSION, kind: KIND, name, walletId: w.walletId, ethId, kdf, salt: reuse ? prev.salt : b64(randomBytes(16)) };
  if (kdf === KDF_PBKDF2) {
    env.iterations = reuse ? prev.iterations : PBKDF2_MIN_ITERATIONS;
    checkIterations(env.iterations);
  }
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(env) }, await keyFor(env, w.dbPass), enc.encode(JSON.stringify(value)));
  const out = { ...env, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  await kv.set(name, out);
  return out;
}

/**
 * Opens record `name` of the Ethereum wallet `ethId`. null when there is none,
 * or when it belongs to an Ethereum wallet that has since been removed.
 */
export async function openData(app, name, { ethId, kv = store } = {}) {
  const w = walletOf(app);
  const env = await kv.get(name);
  if (env == null) return null;
  if (!sameShape(env, name)) throw new VaultError('malformed', 'Not a sealed Ethereum record.');
  if (env.walletId !== w.walletId) throw new VaultError('mismatch', 'This record belongs to another BEAM wallet.');
  if (env.ethId !== ethId) return null;
  const want = kdfFor(w.imported);
  if (env.kdf !== want) throw new VaultError(want === KDF_PBKDF2 ? 'weak' : 'malformed', 'This record uses the wrong key derivation for this wallet; refusing it.');
  if (env.kdf === KDF_PBKDF2) checkIterations(env.iterations);
  else if (env.iterations !== undefined) throw new VaultError('malformed', 'Unexpected round count.');
  let pt;
  try {
    pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: aad(env) }, await keyFor(env, w.dbPass), unb64(env.ct));
  } catch {
    throw new VaultError('wrong_secret', 'The Ethereum record did not open.');
  }
  return JSON.parse(dec.decode(pt));
}
