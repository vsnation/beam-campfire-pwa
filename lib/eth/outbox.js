// What this device signed and sent on Ethereum, newest first, sealed
// (lib/eth/sealed.js). Each transaction is written here BEFORE it is
// broadcast: its hash is keccak256(raw), known from the signed bytes, so a
// payment that left during a network error can still be followed, and sent
// again with the identical bytes (never re-signed, so never twice).
//
// Entry (amounts as decimal strings, they go through JSON):
//   {hash, raw, nonce, from, to, asset, token, amount, gasLimit, maxFeePerGas,
//    maxPriorityFeePerGas, createdAt, sentAt, state, receipt, error}
// state: 'signed'   saved, not yet accepted by the server
//        'pending'  the server took it; waiting for a block
//        'confirmed' | 'failed' (mined; status 1 / 0: the fee was spent)
//        'replaced' another transaction with its nonce was mined instead
//        'rejected' the server refused the bytes: it can never be mined

import { sealData, openData } from './sealed.js';
import { ETH_OUTBOX_KEY } from './record.js';
import { store } from '../store.js';

export const OUTBOX_STATES = Object.freeze(['signed', 'pending', 'confirmed', 'failed', 'replaced', 'rejected']);
/** Entries kept; open ones (signed, pending) are never dropped. */
export const OUTBOX_MAX = 100;
const OPEN = new Set(['signed', 'pending']);

const HASH = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,78}$/;

export function isOpen(entry) {
  return OPEN.has(entry.state);
}

/** Whether `e` is an entry this module wrote (records come back from storage; check them). */
export function validEntry(e) {
  return (
    Boolean(e) &&
    typeof e === 'object' &&
    HASH.test(e.hash) &&
    typeof e.raw === 'string' &&
    /^0x02[0-9a-f]+$/.test(e.raw) &&
    UINT.test(e.nonce) &&
    ADDR.test(e.from) &&
    ADDR.test(e.to) &&
    typeof e.asset === 'string' &&
    (e.token === null || ADDR.test(e.token)) &&
    UINT.test(e.amount) &&
    OUTBOX_STATES.includes(e.state) &&
    Number.isFinite(e.createdAt)
  );
}

// One write at a time: two quick updates must not each read the old list.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

export async function loadOutbox(app, { ethId, kv = store } = {}) {
  const list = await openData(app, ETH_OUTBOX_KEY, { ethId, kv });
  return Array.isArray(list) ? list.filter(validEntry) : [];
}

/** Every open entry, then the newest closed ones up to OUTBOX_MAX in all. `list` is newest first. */
export function trimOutbox(list) {
  let room = Math.max(0, OUTBOX_MAX - list.filter(isOpen).length);
  return list.filter((e) => isOpen(e) || room-- > 0);
}

/** Saves a signed transaction before it is broadcast. */
export function addToOutbox(app, entry, { ethId, kv = store } = {}) {
  if (!validEntry(entry)) return Promise.reject(new Error('Not an outbox entry.'));
  return serial(async () => {
    const list = (await loadOutbox(app, { ethId, kv })).filter((e) => e.hash !== entry.hash);
    const next = trimOutbox([entry, ...list].sort((a, b) => b.createdAt - a.createdAt));
    await sealData(app, ETH_OUTBOX_KEY, next, { ethId, kv });
    return entry;
  });
}

/** Merges `patch` into the entry `hash`; returns the updated entry (or null when there is none). */
export function updateOutbox(app, hash, patch, { ethId, kv = store } = {}) {
  return serial(async () => {
    const list = await loadOutbox(app, { ethId, kv });
    const i = list.findIndex((e) => e.hash === hash);
    if (i < 0) return null;
    const next = { ...list[i], ...patch, hash: list[i].hash, raw: list[i].raw, nonce: list[i].nonce, from: list[i].from };
    if (!validEntry(next)) throw new Error('That update would break the outbox entry.');
    list[i] = next;
    await sealData(app, ETH_OUTBOX_KEY, list, { ethId, kv });
    return next;
  });
}

export function clearOutbox(kv = store) {
  return serial(() => kv.del(ETH_OUTBOX_KEY));
}
