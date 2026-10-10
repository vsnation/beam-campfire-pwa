// The app's own IndexedDB ("beam-campfire-app"), separate from the engine's
// IDBFS database that holds wallet.db. It keeps the key envelopes (never the
// database password itself) and preferences. Nothing here is secret in the
// clear: envelopes are AES-GCM ciphertext.
import { RANDOM_NODE, isPoolNode } from './nodes.js';

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

function tx(mode, fn) {
  return db().then(
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

export const store = {
  get: (k) => tx('readonly', (s) => req(s.get(k))),
  set: (k, v) => tx('readwrite', (s) => req(s.put(v, k))),
  del: (k) => tx('readwrite', (s) => req(s.delete(k))),
  clear: () => tx('readwrite', (s) => req(s.clear())),
};

export const DEFAULT_PREFS = {
  // RANDOM_NODE (BEAM's pool, lib/nodes.js) or the person's own node "host:port".
  node: RANDOM_NODE,
  // The person says their own node runs with this wallet's owner key.
  ownNodeKey: false,
  autoLockMin: 5,
  ipAck: false,
  a2hsDismissed: false,
};

export async function getPrefs() {
  const p = { ...DEFAULT_PREFS, ...((await store.get('prefs')) || {}) };
  // Before the pool, a single BEAM node was picked here: it is a random node now.
  if (isPoolNode(p.node)) p.node = RANDOM_NODE;
  return p;
}

export async function setPrefs(patch) {
  const p = { ...(await getPrefs()), ...patch };
  await store.set('prefs', p);
  return p;
}

/** The wallet record: {id, createdAt, restored, imported?, scan, envelopes:{password, passkey|null}, setupDone}.
 *  imported: from a wallet.db and its password (no recovery phrase; see lib/wallet_file.js). */
export const getWalletRecord = () => store.get('wallet');
export const setWalletRecord = (w) => store.set('wallet', w);
