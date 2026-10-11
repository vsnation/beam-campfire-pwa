// The tokens the person hid from Home, kept per wallet (the desktop app keeps
// them in that wallet's WalletInfo.otherData, beam_hidden_assets.dart): the app
// store key `w:<wallet record id>:hiddenTokens`, a sorted list of asset ids. Nothing
// secret. Deleting the wallet removes it with the wallet's other keys.
//
// Screens read the list synchronously (hiddenIds); it is read from the store once
// per wallet and kept in memory, and every change re-renders through the wallet's
// change event.

import { store } from './store.js';
import { wallet } from './wallet.js';
import { parseHidden, withHidden } from './tokens.js';
import { prefixOf } from './wallet_scope.js';

/** The store key of a wallet's hidden list. */
// 'w:<id>:hiddenTokens' (lib/wallet_scope.js walletKey): deleting the wallet removes it with every key under its prefix.
export const hiddenKey = (recordId) => `${prefixOf(recordId)}hiddenTokens`;

let cache = { id: null, ids: null, loading: null };

const recordId = (app) => (app && app.record && app.record.id != null ? String(app.record.id) : null);

/** Reads the open wallet's list into memory (once per wallet). */
export function loadHidden(app) {
  const id = recordId(app);
  if (!id) return Promise.resolve(new Set());
  if (cache.id === id && cache.ids) return Promise.resolve(new Set(cache.ids));
  if (cache.id === id && cache.loading) return cache.loading;
  cache = { id, ids: null, loading: null };
  const c = cache;
  c.loading = store
    .get(hiddenKey(id))
    .then((v) => parseHidden(v))
    .catch(() => [])
    .then((ids) => {
      if (cache === c) {
        c.ids = ids;
        c.loading = null;
        wallet.emit();
      }
      return new Set(ids);
    });
  return c.loading;
}

/** Whether the open wallet's list has been read (before that, hiddenIds is empty). */
export function hiddenLoaded(app) {
  const id = recordId(app);
  if (!id) return true;
  if (cache.id !== id || !cache.ids) loadHidden(app);
  return cache.id === id && Boolean(cache.ids);
}

/** The hidden token ids of the open wallet (empty until read; reading starts here). */
export function hiddenIds(app) {
  return hiddenLoaded(app) && cache.id === recordId(app) ? new Set(cache.ids) : new Set();
}

/** Hides or shows `assetId` on Home for the open wallet (never BEAM). */
export async function setTokenHidden(app, assetId, hidden) {
  const id = recordId(app);
  if (!id) return;
  const before = await loadHidden(app);
  const next = withHidden([...before], assetId, hidden);
  await store.set(hiddenKey(id), next);
  if (cache.id === id) cache.ids = next;
  wallet.emit();
}
