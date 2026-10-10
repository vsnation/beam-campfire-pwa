// USD prices for the bridge's fee, from the source its relayer prices with:
// CoinGecko's simple/price (beam-bridge-ethrelay, utils/eth_fee.js). A fee
// priced anywhere else is a different number from the one the relayer checks.
// A port of the desktop app's bridge_price_feed.dart.
//
// Nothing is asked unless the caller's allowed() answers exactly true: the
// person turns price lookups on, because CoinGecko sees their IP address. One
// request asks for every bridged asset at once and is kept for two minutes, so
// moving between screens does not spend CoinGecko's small free allowance. The
// URL can only be the one lib/eth/hosts.js builds.

import { priceUrl } from '../eth/hosts.js';
import { ROUTES } from './routes.js';
import { BridgeError } from './beam_pipe.js';

/** How long one answer is used. */
export const PRICE_MAX_AGE_MS = 2 * 60000;
const TIMEOUT_MS = 30000;
const ID = /^[a-z0-9-]{1,64}$/;

/** Every id the bridge prices: ETH for gas, and each route's asset. */
export const BRIDGE_PRICE_IDS = Object.freeze([...new Set(['ethereum', ...ROUTES.map((r) => r.coingeckoId)])].sort());

const noPrice = (message) => new BridgeError('noPrice', message);

export class PriceFeed {
  /**
   * allowed  () => boolean: whether the person allowed price lookups (only
   *          exactly true asks anything)
   * fetch    for tests; clock () => ms
   */
  constructor({ allowed, fetch: fetchImpl = null, clock = () => Date.now(), maxAgeMs = PRICE_MAX_AGE_MS, timeoutMs = TIMEOUT_MS } = {}) {
    if (typeof allowed !== 'function') throw new TypeError('PriceFeed needs allowed(): whether the person allowed price lookups');
    this.allowed = allowed;
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.clock = clock;
    this.maxAgeMs = maxAgeMs;
    this.timeoutMs = timeoutMs;
    this._usd = Object.freeze({});
    this._at = null;
    this._loading = null;
  }

  /**
   * USD prices of `ids` (and of every bridged asset), at most maxAgeMs old →
   * {usd: {id: number}, at: ms}. Throws BridgeError 'noPrice' when lookups are
   * off, CoinGecko does not answer, or any of `ids` has no positive price: a
   * fee is never quoted from a guess.
   */
  async usd(ids) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !ID.test(id))) throw new TypeError(`not CoinGecko ids: ${String(ids).slice(0, 80)}`);
    if (this.allowed() !== true) throw noPrice('Price lookups are off in Settings, so the bridge fee cannot be worked out.');
    if (!this.#fresh(ids)) {
      if (!this._loading) {
        this._loading = this.#load([...new Set([...BRIDGE_PRICE_IDS, ...ids])]).finally(() => {
          this._loading = null;
        });
      }
      await this._loading;
      // Another request was already loading without `ids`: ask again.
      if (!this.#fresh(ids)) await this.#load([...new Set([...BRIDGE_PRICE_IDS, ...Object.keys(this._usd), ...ids])]);
    }
    for (const id of ids) {
      if (!(id in this._usd)) throw noPrice(`CoinGecko gave no price for ${id}, so the bridge fee cannot be worked out.`);
    }
    return Object.freeze({ usd: this._usd, at: this._at });
  }

  #fresh(ids) {
    return this._at !== null && this.clock() - this._at < this.maxAgeMs && ids.every((id) => id in this._usd);
  }

  async #load(ids) {
    const url = priceUrl([...ids].sort());
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    let text;
    try {
      res = await this._fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        signal: ctrl.signal,
      });
      text = res.status === 200 ? await res.text() : '';
    } catch (e) {
      throw noPrice(`Prices could not be read (${ctrl.signal.aborted ? 'no answer in time' : e && e.message}).`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429) throw noPrice('CoinGecko is busy (too many requests); try again in a minute.');
    if (res.status !== 200) throw noPrice(`CoinGecko answered HTTP ${res.status}.`);
    const usd = {};
    try {
      const body = JSON.parse(text);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
      for (const [id, v] of Object.entries(body)) {
        const p = v && typeof v === 'object' ? v.usd : undefined;
        if (ID.test(id) && typeof p === 'number' && Number.isFinite(p) && p > 0) usd[id] = p;
      }
    } catch {
      throw noPrice('CoinGecko did not answer with prices.');
    }
    this._usd = Object.freeze(usd);
    this._at = this.clock();
  }
}
