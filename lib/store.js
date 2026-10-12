// The app's own IndexedDB ("beam-campfire-app"), separate from the engine's
// IDBFS database that holds wallet.db. It keeps the key envelopes (never the
// database password itself) and preferences. Nothing here is secret in the
// clear: envelopes are AES-GCM ciphertext.
import { RANDOM_NODE, isPoolNode } from './nodes.js';
import { oneTab, OtherTabError } from './one_tab.js';

const DB_NAME = 'beam-campfire-app';
const STORE = 'kv';
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('Storage is busy in another tab. Close other BEAM Campfire tabs and reload.'));
  });
  return dbp;
}

// One tab at a time (lib/one_tab.js): a page that let the wallet go to another tab, or lost it while
// frozen, writes nothing here (records, envelopes, prefs) - the other tab owns them now.
function writable(mode) {
  if (mode !== 'readwrite') return Promise.resolve();
  return oneTab()
    .confirmWrite()
    .then((ok) => {
      if (!ok) throw new OtherTabError();
    });
}

function tx(mode, fn) {
  return writable(mode).then(db).then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const s = t.objectStore(STORE);
        let out;
        Promise.resolve(fn(s)).then((v) => (out = v));
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('storage aborted'));
      }),
  );
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

// Several wallets (lib/wallets.js, lib/wallet_scope.js): keys that belong to one wallet and were
// named before there were several ('eth', 'bridge', ...) are mapped to the selected wallet's own
// names by lib/wallet_scope.js. map(key, write) returns the key to use, or throws (no wallet
// selected, or a write while it is locked). Until it is installed, keys are used as they are.
let keyMap = (k) => k;
export function setKeyMap(fn) {
  keyMap = typeof fn === 'function' ? fn : (k) => k;
}

/** {get, set, del, batch} over the store, every key passed through map(key, write) first. */
function kvOver(map) {
  // A refused key rejects the call before any transaction starts.
  const run = (mode, prepare) => {
    let fn;
    try {
      fn = prepare();
    } catch (e) {
      return Promise.reject(e);
    }
    return tx(mode, fn);
  };
  return {
    get: (k) => run('readonly', () => {
      const m = map(k, false);
      return (s) => req(s.get(m));
    }),
    set: (k, v) => run('readwrite', () => {
      const m = map(k, true);
      return (s) => req(s.put(v, m));
    }),
    del: (k) => run('readwrite', () => {
      const m = map(k, true);
      return (s) => req(s.delete(m));
    }),
    /** Several writes in one transaction, so all of them happen or none: [['set', k, v] | ['del', k]]. */
    batch: (ops) => run('readwrite', () => {
      const ms = ops.map(([op, k, v]) => [op, map(k, true), v]);
      return (s) => Promise.all(ms.map(([op, k, v]) => req(op === 'del' ? s.delete(k) : s.put(v, k))));
    }),
  };
}

export const store = {
  ...kvOver((k, write) => keyMap(k, write)),
  clear: () => tx('readwrite', (s) => req(s.clear())),
};

/** The store with every key as written: lib/wallets.js, which names each wallet's keys itself. */
export const rawStore = {
  ...kvOver((k) => k),
  clear: store.clear,
  /** Every key that starts with `prefix`. */
  keys: (prefix) => tx('readonly', (s) => req(s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`)))),
  /** Reads key k and writes fn(value) in one transaction (fn may throw to refuse). */
  update: (k, fn) => tx('readwrite', (s) => req(s.get(k)).then((v) => req(s.put(fn(v), k)))),
};

export const DEFAULT_PREFS = {
  // RANDOM_NODE (BEAM's pool, lib/nodes.js) or the person's own node "host:port".
  node: RANDOM_NODE,
  // The person says their own node runs with this wallet's owner key.
  ownNodeKey: false,
  autoLockMin: 5,
  a2hsDismissed: false,
};

export async function getPrefs(kv = store) {
  const p = { ...DEFAULT_PREFS, ...((await kv.get('prefs')) || {}) };
  // Before the pool, a single BEAM node was picked here: it is a random node now.
  if (isPoolNode(p.node)) p.node = RANDOM_NODE;
  return p;
}

export async function setPrefs(patch, kv = store) {
  const p = { ...(await getPrefs(kv)), ...patch };
  await kv.set('prefs', p);
  return p;
}

/** A wallet record: {id, name?, createdAt, restored, imported?, scan, envelopes:{password, passkey|null}, setupDone, slot0}.
 *  imported: from a wallet.db and its password (no recovery phrase; see lib/wallet_file.js).
 *  Several wallets (lib/wallets.js): the first slot keeps the key 'wallet' (the one a single-wallet
 *  version wrote and reads); every other wallet's record is 'w:<id>:wallet'. getWalletRecord() reads
 *  the first slot only; lib/wallets.js listWallets() reads them all. */
export const getWalletRecord = async () => {
  const r = await rawStore.get('wallet');
  return r ? { ...r, slot0: true } : r;
};
export const setWalletRecord = (w) => rawStore.set(w && w.slot0 === false ? `w:${w.id}:wallet` : 'wallet', w);
