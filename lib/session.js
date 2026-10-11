// Who may open the wallet, and how: creating it, the password and passkey
// envelopes, unlocking, re-confirming before a payment, and wiping it.
// The database password lives in app.dbPass only while the wallet is
// unlocked; lock() drops it.

import { newDbPassword, sealWithPassword, openWithPassword, sealWithPrf, openWithPrf, toHex, randomBytes, unb64, EnvelopeError } from './envelope.js';
import { createPasskey, evaluatePrf } from './passkey.js';
import { createWalletDb, deleteWalletDb, walletExists, adoptImport, discardImport, removeStrayDb, DB_PATH } from './engine.js';
import { importedRecord } from './wallet_file.js';
import { refreshPersistence } from './storage.js';
import { listWallets, placeFor, saveRecord, dbPathOf, nextName, cleanName, nameProblem, closeOpenWallet, loadPrefs, rememberOpened, removeWallet } from './wallets.js';

const setWalletRecord = (r) => saveRecord(r);

export const MIN_PASSWORD = 8;

export function passwordProblem(pw, confirm) {
  if (!pw || pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (confirm !== undefined && pw !== confirm) return "The two passwords don't match.";
  return null;
}

/**
 * Where a new wallet goes and what it is called (lib/wallets.js): the first slot when it is free
 * (a wallet.db left there without a record by an interrupted setup cannot be opened - its
 * database password is gone - so it is removed), else a folder of its own.
 */
async function placeNewWallet(app) {
  const list = await listWallets();
  const { slot0 } = placeFor(list);
  if (slot0 && (await walletExists(DB_PATH))) await removeStrayDb();
  const asked = app.setup && app.setup.name;
  const name = asked && !nameProblem(asked, list) ? cleanName(asked) : nextName(list);
  return { slot0, name };
}

/** Adding a wallet while another is open (or kept running for a payment): that one closes first. */
async function closeCurrent(app) {
  if (app.dbPass || app.wallet.session) await closeOpenWallet(app);
}

/** The new wallet is the open one. */
async function opened(app, record, dbPass) {
  app.record = record;
  app.dbPass = dbPass;
  app.prefs = await loadPrefs(record);
  rememberOpened(app);
}

/**
 * Creates the wallet's database from the words and seals its random database password
 * under the user's password. The words are dropped from memory here.
 */
export async function createWallet(app, password) {
  const setup = app.setup;
  if (!setup || !Array.isArray(setup.words) || setup.words.length !== 12) throw new Error('No recovery words to create the wallet from.');
  const id = toHex(randomBytes(8));
  const dbPass = newDbPassword();
  const envelope = await sealWithPassword(dbPass, password, id);
  const words = setup.words.slice();
  try {
    await closeCurrent(app);
    const { slot0, name } = await placeNewWallet(app);
    // An import.db left by a wallet.db import that was abandoned midway must not
    // be flushed to IndexedDB along with the new wallet.
    await discardImport().catch(() => {});
    // scan: whether the engine reads block bodies (restore: yes, to find the seed's
    // history; a new seed has none, so it starts at the tip without scanning).
    const restored = setup.mode === 'restore';
    const record = { id, name, createdAt: Date.now(), restored, scan: restored, envelopes: { password: envelope, passkey: null }, setupDone: false, slot0 };
    await createWalletDb(words, dbPass, dbPathOf(record));
    try {
      await saveRecord(record);
    } catch (e) {
      await deleteWalletDb(dbPathOf(record)).catch(() => {});
      throw e;
    }
    if (setup.words) setup.words.fill('');
    setup.words = null;
    await opened(app, record, dbPass);
    await refreshPersistence(app, { request: true });
    return record;
  } finally {
    words.fill('');
  }
}

/** Imported from a wallet.db and its password: no recovery phrase in BEAM Campfire. */
export function isImported(app) {
  return Boolean(app && app.record && app.record.imported);
}

/** Adding another wallet (Add a wallet: lib/wallets.js, screens/add_wallet.js) rather than the first one. */
export function isAdding(app) {
  return Boolean(app && app.setup && app.setup.adding);
}

/**
 * Before a picked wallet.db is staged: refuses when this device already has a
 * wallet and the person is not adding another one.
 */
export async function prepareImport(app) {
  if (!isAdding(app) && (app.record || (await listWallets()).length)) {
    const e = new Error('A wallet already exists on this device.');
    e.code = 'exists';
    throw e;
  }
}

/**
 * Makes the staged, password-checked wallet.db a wallet of this device. Its own
 * password stays the database password (BEAM's engine has no way to change
 * it, and the original file keeps it anyway); it is sealed under the same
 * password, so one password unlocks it here until the person changes the
 * unlock password in Settings.
 */
export async function importWallet(app, password) {
  await prepareImport(app);
  const id = toHex(randomBytes(8));
  const envelope = await sealWithPassword(password, password, id);
  await closeCurrent(app);
  const { slot0, name } = await placeNewWallet(app);
  const record = { ...importedRecord(id, envelope), name, slot0 };
  await adoptImport(dbPathOf(record));
  try {
    await saveRecord(record);
  } catch (e) {
    await deleteWalletDb(dbPathOf(record)).catch(() => {});
    throw e;
  }
  app.setup = null;
  await opened(app, record, password);
  await refreshPersistence(app, { request: true });
  return record;
}

/** After a wallet.db export reached the share sheet or downloads: Home stops asking for one. */
export async function markExported(app) {
  app.record = { ...app.record, exportedAt: Date.now() };
  await setWalletRecord(app.record);
}

/** Imported wallets have no 12 words: until one export, Home asks for a copy outside this device. */
export function needsBackupPrompt(app, now = Date.now()) {
  if (!isImported(app) || app.record.exportedAt) return false;
  return !(app.prefs && app.prefs.backupPromptSnoozedUntil > now);
}

export async function addPasskey(app) {
  if (!app.dbPass) throw new Error('Unlock the wallet first.');
  const { credId, prfSalt, prf } = await createPasskey(app.record.id, app.record.name);
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

/**
 * Removes the selected wallet from this device: its database, envelopes and everything that is
 * its (lib/wallets.js removeWallet); the other wallets stay. Another one, if any, is selected.
 */
export async function wipeWallet(app, target = app.record) {
  return removeWallet(app, target);
}

export { EnvelopeError };
