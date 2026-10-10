// Where the Ethereum wallet's records live in the app's own store
// ("beam-campfire-app"), readable without loading any Ethereum code: Home,
// Settings and the delete screen only need to know whether there is one.
// Both records sit beside the BEAM wallet's, so wipeWallet()'s store.clear()
// removes them together with it.

import { store } from '../store.js';

/** The sealed key and what the person wrote down (lib/eth/vault.js). */
export const ETH_RECORD_KEY = 'eth';
/** What this device sent, sealed (lib/eth/outbox.js). */
export const ETH_OUTBOX_KEY = 'eth-outbox';

export async function hasEthWallet(kv = store) {
  return Boolean(await kv.get(ETH_RECORD_KEY));
}
