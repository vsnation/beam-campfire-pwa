// Who may open the wallet, and how: creating it, the password and passkey
// envelopes, unlocking, re-confirming before a payment, and wiping it.
// The database password lives in app.dbPass only while the wallet is
// unlocked; lock() drops it.

import { newDbPassword, sealWithPassword, openWithPassword, sealWithPrf, openWithPrf, toHex, randomBytes, unb64, EnvelopeError } from './envelope.js';
import { createPasskey, evaluatePrf } from './passkey.js';
import { createWalletDb, deleteWalletDb, walletExists, adoptImport, discardImport } from './engine.js';
import { store, getWalletRecord, setWalletRecord } from './store.js';
import { importedRecord } from './wallet_file.js';

export const MIN_PASSWORD = 8;

export function passwordProblem(pw, confirm) {
  if (!pw || pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (confirm !== undefined && pw !== confirm) return "The two passwords don't match.";
  return null;
}

/**
 * Creates wallet.db from the words and seals its random database password
 * under the user's password. The words are dropped from memory here.
 */
export async function createWallet(app, password) {
  const setup = app.setup;
  if (!setup || !Array.isArray(setup.words) || setup.words.length !== 12) throw new Error('No recovery words to create the wallet from.');
  const id = toHex(randomBytes(8));
  const dbPass = newDbPassword();
  const envelope = await sealWithPassword(dbPass, password, id);
  // A wallet.db without a record is a leftover from an interrupted setup: it
  // cannot be opened (its database password is gone), so it is replaced.
  if (!(await getWalletRecord()) && (await walletExists())) await deleteWalletDb();
  // An import.db left by a wallet.db import that was abandoned midway must not
  // be flushed to IndexedDB along with the new wallet.
  await discardImport().catch(() => {});
  await createWalletDb(setup.words, dbPass);
  setup.words.fill('');
  setup.words = null;
  // scan: whether the engine reads block bodies (restore: yes, to find the seed's
  // history; a new seed has none, so it starts at the tip without scanning).
  const restored = setup.mode === 'restore';
  const record = { id, createdAt: Date.now(), restored, scan: restored, envelopes: { password: envelope, passkey: null }, setupDone: false };
  await setWalletRecord(record);
  app.record = record;
  app.dbPass = dbPass;
  try {
    if (navigator.storage && navigator.storage.persist) app.persisted = await navigator.storage.persist();
  } catch {
    /* best effort */
  }
  return record;
}

/** Imported from a wallet.db and its password: no recovery phrase in BEAM Campfire. */
export function isImported(app) {
  return Boolean(app && app.record && app.record.imported);
}

/**
 * Before a picked wallet.db is staged: refuses when this device already has a
 * wallet, and removes a wallet.db left without a record by an interrupted
 * setup (it cannot be opened: its database password is gone).
 */
export async function prepareImport(app) {
  if (app.record || (await getWalletRecord())) {
    const e = new Error('A wallet already exists on this device.');
    e.code = 'exists';
    throw e;
  }
  if (await walletExists()) await deleteWalletDb();
}

/**
 * Makes the staged, password-checked wallet.db this device's wallet. Its own
 * password stays the database password (BEAM's engine has no way to change
 * it, and the original file keeps it anyway); it is sealed under the same
 * password, so one password unlocks it here until the person changes the
 * unlock password in Settings.
 */
export async function importWallet(app, password) {
  if (app.record || (await getWalletRecord())) {
    const e = new Error('A wallet already exists on this device.');
    e.code = 'exists';
    throw e;
  }
  const id = toHex(randomBytes(8));
  const envelope = await sealWithPassword(password, password, id);
  await adoptImport();
  const record = importedRecord(id, envelope);
  try {
    await setWalletRecord(record);
  } catch (e) {
    await deleteWalletDb().catch(() => {});
    throw e;
  }
  app.record = record;
  app.dbPass = password;
  try {
    if (navigator.storage && navigator.storage.persist) app.persisted = await navigator.storage.persist();
  } catch {
    /* best effort */
  }
  return record;
}

export async function addPasskey(app) {
  if (!app.dbPass) throw new Error('Unlock the wallet first.');
  const { credId, prfSalt, prf } = await createPasskey(app.record.id);
  const env = await sealWithPrf(app.dbPass, prf, app.record.id, credId, prfSalt);
  prf.fill(0);
  app.record = { ...app.record, envelopes: { ...app.record.envelopes, passkey: env } };
  await setWalletRecord(app.record);
}

export async function removePasskey(app) {
  app.record = { ...app.record, envelopes: { ...app.record.envelopes, passkey: null } };
  await setWalletRecord(app.record);
}

export function hasPasskey(app) {
  return Boolean(app.record && app.record.envelopes && app.record.envelopes.passkey);
}

/** @returns the database password, or throws EnvelopeError('wrong_secret'). */
export async function openWithPasswordFor(app, password) {
  return openWithPassword(app.record.envelopes.password, password);
}

export async function openWithPasskeyFor(app) {
  const env = app.record.envelopes.passkey;
  const prf = await evaluatePrf(env.credId, unb64(env.prfSalt));
  try {
    return await openWithPrf(env, prf);
  } finally {
    prf.fill(0);
  }
}

export async function changePassword(app, current, next) {
  await openWithPassword(app.record.envelopes.password, current); // throws if wrong
  if (!app.dbPass) throw new Error('Unlock the wallet first.');
  const env = await sealWithPassword(app.dbPass, next, app.record.id);
  app.record = { ...app.record, envelopes: { ...app.record.envelopes, password: env } };
  await setWalletRecord(app.record);
}

export async function markSetupDone(app) {
  app.record = { ...app.record, setupDone: true };
  await setWalletRecord(app.record);
}

/** Records created before scan-less wallets existed scanned, so missing means true. */
export function scanEnabled(app) {
  return !(app.record && app.record.scan === false);
}

export async function setScan(app, scan) {
  app.record = { ...app.record, scan };
  await setWalletRecord(app.record);
}

/** Removes the wallet from this device: wallet.db, envelopes, preferences. */
export async function wipeWallet(app) {
  await deleteWalletDb();
  await store.clear();
  app.record = null;
  app.dbPass = null;
}

export { EnvelopeError };
