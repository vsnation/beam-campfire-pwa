// Key envelopes: how the wallet's database password is kept on the device.
//
// Each wallet gets a random 32-byte database password (hex). The engine needs
// it to open wallet.db; it is never shown, logged or stored in the clear.
// It is stored only inside envelopes (AES-256-GCM, random 12-byte IV), each
// sealed under one key-encryption key (KEK):
//
//   password envelope: KEK = PBKDF2-SHA256(password, random 16-byte salt, >= 600,000 rounds)
//   passkey envelope:  KEK = HKDF-SHA256(WebAuthn PRF output, salt, info "beam-campfire-kek-v1")
//
// The envelope's own fields (version, kind, wallet id, rounds, credential id,
// salts) are bound as AES-GCM additional data, so changing any of them makes
// the envelope fail to open instead of, say, quietly lowering the rounds.
// Works in browsers and in Node 22 (globalThis.crypto).

export const PBKDF2_MIN_ITERATIONS = 600000;
export const KEK_INFO = 'beam-campfire-kek-v1';
const ENVELOPE_VERSION = 1;

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class EnvelopeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'wrong_secret' | 'malformed' | 'weak'
  }
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function toHex(u8) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function b64(u8) {
  let s = '';
  const a = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}

export function unb64(s) {
  if (typeof s !== 'string') throw new EnvelopeError('malformed', 'bad base64');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh random database password: 32 bytes as 64 hex characters. */
export function newDbPassword() {
  return toHex(randomBytes(32));
}

function aad(env) {
  return enc.encode(
    JSON.stringify([
      env.v,
      env.kind,
      env.walletId,
      env.iterations || 0,
      env.credId || '',
      env.salt || '',
    ]),
  );
}

async function passwordKek(password, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function prfKek(prfOutput, salt) {
  const ikm = prfOutput instanceof Uint8Array ? prfOutput : new Uint8Array(prfOutput);
  if (ikm.length < 32) throw new EnvelopeError('malformed', 'PRF output too short');
  const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(KEK_INFO) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(env, kek, secret) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(env) }, kek, enc.encode(secret));
  return { ...env, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function open(env, kek) {
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: aad(env) }, kek, unb64(env.ct));
    return dec.decode(pt);
  } catch {
    throw new EnvelopeError('wrong_secret', 'The envelope did not open.');
  }
}

function checkShape(env, kind) {
  if (!env || env.v !== ENVELOPE_VERSION || env.kind !== kind || typeof env.walletId !== 'string')
    throw new EnvelopeError('malformed', 'Not a BEAM Campfire envelope.');
  if (typeof env.iv !== 'string' || typeof env.ct !== 'string' || typeof env.salt !== 'string')
    throw new EnvelopeError('malformed', 'Envelope fields missing.');
}

export async function sealWithPassword(secret, password, walletId, { iterations = PBKDF2_MIN_ITERATIONS } = {}) {
  if (typeof password !== 'string' || password.length === 0) throw new EnvelopeError('malformed', 'Empty password');
  if (iterations < PBKDF2_MIN_ITERATIONS) throw new EnvelopeError('weak', 'Too few PBKDF2 rounds');
  const salt = randomBytes(16);
  const env = { v: ENVELOPE_VERSION, kind: 'password', walletId, iterations, salt: b64(salt) };
  return seal(env, await passwordKek(password, salt, iterations), secret);
}

export async function openWithPassword(env, password) {
  checkShape(env, 'password');
  if (!Number.isSafeInteger(env.iterations) || env.iterations < PBKDF2_MIN_ITERATIONS)
    throw new EnvelopeError('weak', 'This envelope asks for too few PBKDF2 rounds; refusing it.');
  return open(env, await passwordKek(password, unb64(env.salt), env.iterations));
}

/** prfOutput: the 32-byte WebAuthn PRF result for this credential and prfSalt. */
export async function sealWithPrf(secret, prfOutput, walletId, credId, prfSalt) {
  if (typeof credId !== 'string' || !credId) throw new EnvelopeError('malformed', 'Missing credential id');
  const salt = randomBytes(16);
  const env = { v: ENVELOPE_VERSION, kind: 'passkey', walletId, credId, prfSalt: b64(prfSalt), salt: b64(salt) };
  return seal(env, await prfKek(prfOutput, salt), secret);
}

export async function openWithPrf(env, prfOutput) {
  checkShape(env, 'passkey');
  return open(env, await prfKek(prfOutput, unb64(env.salt)));
}
