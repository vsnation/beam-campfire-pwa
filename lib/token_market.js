// What Home and the token page need to put a value on tokens, kept for the page:
// the DEX's pools (read through the wallet's own node, like Swap does, so no one
// else is asked) turned into a lib/pricer.js AssetPricer, and BEAM's price in the
// person's currency (lib/fiat.js, only once they said yes). Both re-render the
// screens through the wallet's change event when something new arrives.

import { wallet } from './wallet.js';
import { loadPools } from './dex_pools.js';
import { AssetPricer } from './pricer.js';
import { FiatPrice } from './fiat.js';

/** Pools are read again after this long while a screen shows values. */
export const MARKET_TTL_MS = 60000;
const RETRY_MS = 30000;

let market = { session: null, pools: null, pricer: null, at: 0, loading: null, failedAt: 0, error: null };

/** The pricer for this session's last pool read, or null before the first one. */
export function marketPricer() {
  // A pricer that knows no BEAM pool (an empty or failed read) is "prices not known yet", not
  // "no price": otherwise every row said "No price" until the pools came in.
  const p = market.session && market.session === wallet.session ? market.pricer : null;
  return p && p.beamPools && p.beamPools.size ? p : null;
}

/** The pools behind marketPricer() (lib/dex.js parsePools rows), or null. */
export function marketPools() {
  return market.session && market.session === wallet.session ? market.pools : null;
}

/** Why the last pool read failed, while it is recent; null otherwise. */
export function marketError() {
  return market.session === wallet.session && market.error && Date.now() - market.failedAt < 5 * 60000 ? market.error : null;
}

/**
 * Reads the pools when due: a synced wallet, nothing read in the last minute.
 * Quiet on failure (values stay as they were; tried again after 30 s).
 */
export function refreshMarket({ force = false } = {}) {
  const session = wallet.session;
  if (!session || wallet.state.sync.state !== 'synced') return null;
  if (market.session !== session) market = { session, pools: null, pricer: null, at: 0, loading: null, failedAt: 0, error: null };
  if (market.loading) return market.loading;
  const now = Date.now();
  if (!force && market.pricer && now - market.at < MARKET_TTL_MS) return null;
  if (!force && now - market.failedAt < RETRY_MS) return null;
  const m = market;
  m.loading = loadPools()
    .then((pools) => {
      if (market !== m) return;
      m.pools = pools;
      m.pricer = new AssetPricer(pools);
      m.at = Date.now();
      m.error = null;
      wallet.emit();
    })
    .catch((e) => {
      if (market !== m) return;
      m.failedAt = Date.now();
      m.error = (e && e.message) || String(e);
    })
    .finally(() => {
      m.loading = null;
    });
  return m.loading;
}

let fiat = null;

/** BEAM's price for this app (one per page): asked only while app.prefs.fiatPrices is true. */
export function beamPrice(app) {
  if (!fiat) {
    fiat = new FiatPrice({ prefs: () => app.prefs });
    fiat.onChange(() => wallet.emit());
  }
  return fiat;
}
