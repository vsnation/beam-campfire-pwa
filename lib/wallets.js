// Several BEAM wallets on one device. One runs at a time (one engine, lib/wallet.js); the others
// sit locked, each with its own database file, password envelope, passkey and settings.
//
// Where each wallet lives:
//   first slot (slot0)  record 'wallet', database /beam_wallet/wallet.db, per-wallet data under
//                       the plain names a single-wallet version used ('eth', 'bridge', ...), its
//                       per-wallet preferences inside 'prefs'.
//   any other wallet    record 'w:<id>:wallet', database /beam_wallet/<id>/wallet.db (its own
//                       folder in the same IDBFS mount), data 'w:<id>:<name>', preferences
//                       'w:<id>:prefs'.
//   every wallet        'w:<id>:balance' (the last BEAM balance seen while it was open and in step
//                       with the network, shown in the switcher), and whatever newer code keeps
//                       under walletKey() (lib/wallet_scope.js).
// A device that had one wallet keeps it exactly where it was: it is the first slot, named
// "Wallet 1" until renamed; nothing is moved or rewritten. A new wallet takes the first slot when
// it is free, otherwise a folder of its own.
//
// An older, single-wallet version on the same device sees the first slot's wallet only. Its
// Delete removes plain files in /beam_wallet (never a folder) and clears the whole store, so the
// other wallets' files would stay but their records and envelopes would go: their 12 words (or
// their original wallet.db and its password) would be needed again. The updater refuses an older
// release, so that takes installing one by hand at the same address.

import { rawStore, getPrefs, setPrefs, DEFAULT_PREFS } from './store.js';
import { DB_DIR, DB_PATH, useWalletPath, deleteWalletDb } from './engine.js';
import { WALLET_PREFIX, WALLET_KEYS, WALLET_KEY_PREFIXES, WALLET_PREF_KEYS, prefixOf, isWalletId, inSlot0, setScopeRecord, runRemovedHooks } from './wallet_scope.js';

export { walletKey, walletStore, onWalletRemoved, WALLET_PREF_KEYS } from './wallet_scope.js';

export const SLOT0_RECORD_KEY = 'wallet';
export const FIRST_NAME = 'Wallet 1';
export const MAX_NAME = 32;

export class WalletsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'name' | 'slot_taken' | 'missing' | 'open'
  }
}

export { inSlot0 };
export const recordKey = (record) => (inSlot0(record) ? SLOT0_RECORD_KEY : `${prefixOf(record.id)}wallet`);
export const walletPrefsKey = (record) => (inSlot0(record) ? 'prefs' : `${prefixOf(record.id)}prefs`);
export const balanceKey = (id) => `${prefixOf(id)}balance`;
export const dbPathOf = (record) => (inSlot0(record) ? DB_PATH : `${DB_DIR}/${record.id}/wallet.db`);

function validRecord(r) {
  return Boolean(r) && typeof r === 'object' && isWalletId(r.id) && Boolean(r.envelopes && r.envelopes.password);
}

/** The name people see: the record's own, or "Wallet 1" for the wallet a single-wallet version made. */
export function nameOf(record) {
  if (!record) return '';
  if (typeof record.name === 'string' && record.name.trim()) return record.name.trim();
  return inSlot0(record) ? FIRST_NAME : 'Wallet';
}

/** Spaces tidied; at most MAX_NAME characters. */
export function cleanName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
}

const sameName = (a, b) => cleanName(a).toLocaleLowerCase() === cleanName(b).toLocaleLowerCase();

/** null when `name` can be used for a wallet (other than exceptId), else what to change, in words. */
export function nameProblem(name, list, exceptId = null) {
  const n = cleanName(name);
  if (!n) return 'Give the wallet a name.';
  if ([...n].length > MAX_NAME) return `Use ${MAX_NAME} characters or fewer.`;
  if (list.some((r) => r.id !== exceptId && sameName(nameOf(r), n))) return `You already have a wallet named "${n}". Choose another name.`;
  return null;
}

/** "Wallet 2", "Wallet 3"...: the first free one after the wallets there are. */
export function nextName(list) {
  let n = list.length + 1;
  while (list.some((r) => sameName(nameOf(r), `Wallet ${n}`))) n++;
  return `Wallet ${n}`;
}

/** As the desktop app lists them: by name (numbers in order), then oldest first. */
export function sortWallets(list) {
  return [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' }) || (a.createdAt || 0) - (b.createdAt || 0));
}

/** Every wallet on this device, sorted; each record says where it lives (slot0). */
export async function listWallets(kv = rawStore) {
  const out = [];
  const first = await kv.get(SLOT0_RECORD_KEY);
  if (validRecord(first)) out.push({ ...first, slot0: true });
  for (const k of await kv.keys(WALLET_PREFIX)) {
    const m = /^w:([0-9a-f]{16}):wallet$/.exec(k);
    if (!m || out.some((r) => r.id === m[1])) continue;
    const r = await kv.get(k);
    if (validRecord(r) && r.id === m[1]) out.push({ ...r, slot0: false });
  }
  return sortWallets(out);
}

/** Where a new wallet goes: the first slot when it is free. */
export function placeFor(list) {
  return { slot0: !list.some((r) => inSlot0(r)) };
}

/**
 * Writes a wallet's record where it lives. Refuses to write over another wallet's record (the
 * first slot holds one record only), so no wallet's envelopes can be replaced by another's.
 */
export async function saveRecord(record, kv = rawStore) {
  if (!validRecord(record)) throw new WalletsError('missing', 'Not a wallet record.');
  const value = { ...record, slot0: inSlot0(record) };
  await kv.update(recordKey(record), (prev) => {
    if (prev && prev.id !== record.id) throw new WalletsError('slot_taken', 'Another wallet is kept there; nothing was written.');
    return value;
  });
  return value;
}

/** The wallet to show first: the one last opened, else the first slot's, else any. */
export function initialWallet(list, prefs) {
  const last = prefs && prefs.lastWalletId;
  return list.find((r) => r.id === last) || list.find((r) => inSlot0(r)) || list[0] || null;
}

// ---------------------------------------------------------------- preferences
/**
 * The app's preferences with `record`'s own (WALLET_PREF_KEYS) on top. The first slot's own are
 * in 'prefs' itself, as a single-wallet version kept them.
 */
export async function loadPrefs(record, kv = rawStore) {
  const p = await getPrefs(kv);
  if (!record || inSlot0(record)) return p;
  const own = (await kv.get(walletPrefsKey(record))) || {};
  for (const k of WALLET_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(own, k)) p[k] = own[k];
    else if (Object.prototype.hasOwnProperty.call(DEFAULT_PREFS, k)) p[k] = DEFAULT_PREFS[k];
    else delete p[k];
  }
  return p;
}

/** Saves a change: the wallet's own preferences to the wallet, the rest to the app. Returns loadPrefs(record). */
export async function savePrefs(record, patch, kv = rawStore) {
  if (!record || inSlot0(record)) {
    await setPrefs(patch, kv);
    return loadPrefs(record, kv);
  }
  const mine = {};
  const app = {};
  for (const [k, v] of Object.entries(patch || {})) (WALLET_PREF_KEYS.includes(k) ? mine : app)[k] = v;
  if (Object.keys(app).length) await setPrefs(app, kv);
  if (Object.keys(mine).length) await kv.update(walletPrefsKey(record), (prev) => ({ ...(prev && typeof prev === 'object' ? prev : {}), ...mine }));
  return loadPrefs(record, kv);
}

// ---------------------------------------------------------------- last known balance
/** {available (groth, string), at (ms)} per wallet id, for the switcher. Nothing is asked of a locked wallet. */
export async function lastBalances(list, kv = rawStore) {
  const out = new Map();
  for (const r of list) {
    const b = await kv.get(balanceKey(r.id));
    if (b && typeof b.available === 'string' && /^\d+$/.test(b.available) && Number.isFinite(b.at)) out.set(r.id, { available: BigInt(b.available), at: b.at });
  }
  return out;
}

const watching = new WeakSet();

/**
 * Keeps each wallet's BEAM balance as last seen while it was open and in step with the network
 * (Synced), so the switcher can show it while the wallet is locked. Written when it changes.
 */
export function watchBalances(app, kv = rawStore) {
  if (watching.has(app)) return;
  watching.add(app);
  const seen = new Map();
  app.wallet.onChange((s) => {
    const r = app.record;
    const run = app.wallet.run;
    if (!r || !app.dbPass || !run || run.dbPath !== dbPathOf(r) || !s.status || s.importing || !s.sync || s.sync.state !== 'synced') return;
    const t = s.totals.get(0);
    if (!t) return;
    const v = String(t.available);
    if (seen.get(r.id) === v) return;
    seen.set(r.id, v);
    kv.set(balanceKey(r.id), { available: v, at: Date.now() }).catch(() => seen.delete(r.id));
  });
}

// ---------------------------------------------------------------- open, switch, remove
/** Points the store's per-wallet keys and the engine's default database at `record` (app.js, with app.record). */
export function scopeTo(record) {
  setScopeRecord(record);
  useWalletPath(record ? dbPathOf(record) : DB_PATH);
}

/** Makes `record` the selected wallet while nothing is open (the unlock screen's picker, after a switch or a delete). */
export async function selectWallet(app, record, kv = rawStore) {
  if (app.dbPass) throw new WalletsError('open', 'Lock the open wallet first.');
  app.record = record || null;
  app.afterUnlock = null;
  app.prefs = await loadPrefs(app.record, kv);
}

/** After an unlock: this wallet comes up first next time. */
export function rememberOpened(app) {
  if (!app.record) return Promise.resolve();
  return app.setPrefs({ lastWalletId: app.record.id }).catch(() => {});
}

/**
 * Closes the open wallet before another is made or imported: what the lock does (its secrets
 * forgotten, every lock hook run) and the engine stopped, payment or not (the person was asked).
 */
export async function closeOpenWallet(app) {
  app.dbPass = null;
  app.afterUnlock = null;
  app.nav.clear();
  app.runLockHooks();
  await app.wallet.stop();
}

/** Which wallet the engine runs now (open, or kept running behind the lock for a payment), or null. */
export function runningWallet(app, list) {
  const run = app.wallet.run;
  return (run && list.find((r) => dbPathOf(r) === run.dbPath)) || null;
}

/**
 * Locks the open wallet as the lock button does (a payment under way keeps going behind the lock
 * until another wallet opens) and shows the unlock screen for `target`.
 */
export async function switchWallet(app, target) {
  const from = app.record;
  if (from && from.id === target.id) return;
  await app.lock('switch', { beforeUnlock: () => selectWallet(app, target), params: { from: from ? nameOf(from) : null } });
}

/** The keys that go with `target`, as one batch: its prefix, and for the first slot its plain names and preferences. */
export async function removalOps(target, kv = rawStore) {
  const ops = (await kv.keys(prefixOf(target.id))).map((k) => ['del', k]);
  const prefs = await kv.get('prefs');
  const nextPrefs = prefs && typeof prefs === 'object' ? { ...prefs } : null;
  if (inSlot0(target)) {
    ops.push(['del', SLOT0_RECORD_KEY]);
    for (const k of WALLET_KEYS) ops.push(['del', k]);
    for (const p of WALLET_KEY_PREFIXES) for (const k of await kv.keys(p)) ops.push(['del', k]);
    if (nextPrefs) for (const k of WALLET_PREF_KEYS) delete nextPrefs[k];
  }
  if (nextPrefs && nextPrefs.lastWalletId === target.id) delete nextPrefs.lastWalletId;
  if (nextPrefs) ops.push(['set', 'prefs', nextPrefs]);
  return ops;
}

/**
 * Deletes one wallet from this device: its database file (and only its), its record and
 * envelopes, and every key that is its. The others are not touched. The last wallet takes the
 * app's settings with it, as deleting the only wallet always did. When it was the selected
 * wallet, another one is selected (locked). @returns {Promise<{others: object[]}>}
 */
export async function removeWallet(app, target, { kv = rawStore, deleteDb = deleteWalletDb } = {}) {
  const list = await listWallets(kv);
  if (!list.some((r) => r.id === target.id)) throw new WalletsError('missing', 'That wallet is not on this device any more.');
  const others = list.filter((r) => r.id !== target.id);
  const selected = Boolean(app.record && app.record.id === target.id);
  const running = Boolean(app.wallet.run && app.wallet.run.dbPath === dbPathOf(target));
  if (selected) {
    app.dbPass = null;
    app.setup = null;
    app.afterUnlock = null;
    app.nav.clear();
    app.runLockHooks();
  }
  if (selected || running) await app.wallet.stop();
  await deleteDb(dbPathOf(target));
  if (others.length) await kv.batch(await removalOps(target, kv));
  else await kv.clear();
  await runRemovedHooks(target.id);
  if (selected) {
    const prefs = await getPrefs(kv);
    await selectWallet(app, initialWallet(others, prefs), kv);
  }
  return { others };
}

/** Renames a wallet (open or not). */
export async function renameWallet(app, target, name, kv = rawStore) {
  const list = await listWallets(kv);
  const problem = nameProblem(name, list, target.id);
  if (problem) throw new WalletsError('name', problem);
  const clean = cleanName(name);
  if (app.record && app.record.id === target.id) {
    app.record = { ...app.record, name: clean };
    await saveRecord(app.record, kv);
    return app.record;
  }
  const r = list.find((x) => x.id === target.id);
  if (!r) throw new WalletsError('missing', 'That wallet is not on this device any more.');
  return saveRecord({ ...r, name: clean }, kv);
}
