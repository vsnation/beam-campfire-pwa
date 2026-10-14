// BEAM's price in the person's currency, and how money values are written.
// The desktop app's lib/wallets/beam/price/beam_fiat_price.dart: the one step
// from BEAM to fiat comes from CoinGecko (id "beam", BEAM Privacy; not
// "beam-2", an unrelated Ethereum token with the same ticker); a token's value
// in BEAM comes from the DEX (lib/pricer.js) and asks no one.
//
// Privacy (docs/beam/PWA.md §4): nothing is asked unless prefs.fiatPrices is
// exactly true, which only the person sets ("Show values in dollars?" on Home,
// or the switch in Settings): CoinGecko sees the IP address. One request asks
// for BEAM in one currency, at most every two minutes; the URL can only be
// CoinGecko's simple/price path that the CSP already allows for the bridge
// (lib/eth/hosts.js PRICE_HOST). Without an answer the screens show no money
// value at all, never a made-up 0.

import { PRICE_HOST, originOf } from './price_host.js';
import { t, tk } from './i18n.js';

export const COINGECKO_BEAM_ID = 'beam';
export const DEFAULT_CURRENCY = 'USD';
export const PRICE_MAX_AGE_MS = 2 * 60000;
/** After CoinGecko says "too many requests": wait this long before asking again. */
export const BUSY_BACKOFF_MS = 5 * 60000;
/** A price older than this is not shown (the request kept failing). */
export const PRICE_SHOW_MAX_MS = 30 * 60000;
const TIMEOUT_MS = 20000;

/**
 * The currencies the desktop app offers (lib/providers/global/base_currencies_provider.dart),
 * the national ones: CoinGecko prices BEAM in each. Its crypto units (BTC, sats…), gold,
 * silver, SDR and the retired VEF are left out: a wallet value in them helps no one here.
 * The names are shown with t(name).
 */
export const FIAT_CURRENCIES = Object.freeze([
  ['USD', tk('US dollar')], ['EUR', tk('Euro')], ['GBP', tk('Pound sterling')], ['AUD', tk('Australian dollar')], ['AED', tk('UAE dirham')],
  ['ARS', tk('Argentine peso')], ['BDT', tk('Bangladeshi taka')], ['BHD', tk('Bahraini dinar')], ['BMD', tk('Bermudan dollar')], ['BRL', tk('Brazilian real')],
  ['CAD', tk('Canadian dollar')], ['CHF', tk('Swiss franc')], ['CLP', tk('Chilean peso')], ['CNY', tk('Chinese yuan')], ['CZK', tk('Czech koruna')],
  ['DKK', tk('Danish krone')], ['HKD', tk('Hong Kong dollar')], ['HUF', tk('Hungarian forint')], ['IDR', tk('Indonesian rupiah')], ['ILS', tk('Israeli shekel')],
  ['INR', tk('Indian rupee')], ['JPY', tk('Japanese yen')], ['KRW', tk('South Korean won')], ['KWD', tk('Kuwaiti dinar')], ['LKR', tk('Sri Lankan rupee')],
  ['MMK', tk('Myanmar kyat')], ['MXN', tk('Mexican peso')], ['MYR', tk('Malaysian ringgit')], ['NGN', tk('Nigerian naira')], ['NOK', tk('Norwegian krone')],
  ['NZD', tk('New Zealand dollar')], ['PHP', tk('Philippine peso')], ['PKR', tk('Pakistani rupee')], ['PLN', tk('Polish złoty')], ['RUB', tk('Russian ruble')],
  ['SAR', tk('Saudi riyal')], ['SEK', tk('Swedish krona')], ['SGD', tk('Singapore dollar')], ['THB', tk('Thai baht')], ['TRY', tk('Turkish lira')],
  ['TWD', tk('New Taiwan dollar')], ['UAH', tk('Ukrainian hryvnia')], ['VND', tk('Vietnamese dong')], ['ZAR', tk('South African rand')],
].map((c) => Object.freeze(c)));

const CODES = new Set(FIAT_CURRENCIES.map(([c]) => c));
export const isCurrency = (code) => CODES.has(code);
export const currencyOf = (prefs) => (prefs && isCurrency(prefs.fiatCurrency) ? prefs.fiatCurrency : DEFAULT_CURRENCY);
/** Only an explicit yes turns prices on. */
export const fiatAllowed = (prefs) => Boolean(prefs) && prefs.fiatPrices === true;
/** Not asked yet: neither yes nor no. */
export const fiatUnasked = (prefs) => !prefs || (prefs.fiatPrices !== true && prefs.fiatPrices !== false);

/** "dollars" for USD, else the currency's name, for the question and the switch. */
export function currencyWords(code) {
  if (code === 'USD') return t('dollars');
  const c = FIAT_CURRENCIES.find(([k]) => k === code);
  return c ? c[0] : code;
}

/** The one URL this asks: CoinGecko's simple/price for BEAM in `code`. */
export function fiatPriceUrl(code) {
  if (!isCurrency(code)) throw new Error(`not a currency: ${code}`); // i18n-ignore: an invariant (only listed codes are asked), never shown
  return `${originOf(PRICE_HOST)}${PRICE_HOST.path}?ids=${COINGECKO_BEAM_ID}&vs_currencies=${code.toLowerCase()}`;
}

/** CoinGecko's answer -> a usable price (a positive finite number), or null. */
export function parsePrice(body, code) {
  const v = body && typeof body === 'object' && !Array.isArray(body) ? body[COINGECKO_BEAM_ID] : null;
  const p = v && typeof v === 'object' ? v[String(code).toLowerCase()] : undefined;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * BEAM's price, kept in memory for this page. get() never throws: it answers
 * the last good price for the currency (while not too old) or null, and asks
 * CoinGecko again when the price is older than two minutes. Listeners hear
 * every new price.
 */
export class FiatPrice {
  /** prefs: () => the app's prefs; fetch and clock for tests. */
  constructor({ prefs, fetch: fetchImpl = null, clock = () => Date.now(), maxAgeMs = PRICE_MAX_AGE_MS } = {}) {
    this.prefs = prefs || (() => null);
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.clock = clock;
    this.maxAgeMs = maxAgeMs;
    this.last = null; // { price, currency, at }
    this.error = null; // { message, at }: for diagnostics; no screen shows it (English, like a log line)
    this.loading = null;
    this.waitUntil = 0;
    this.requests = 0;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The price to show now ({price, currency, at}), or null: never asks anything itself. */
  current() {
    const prefs = this.prefs();
    if (!fiatAllowed(prefs)) return null;
    const cur = currencyOf(prefs);
    const l = this.last;
    if (!l || l.currency !== cur || this.clock() - l.at > PRICE_SHOW_MAX_MS) return null;
    return l;
  }

  /** current(), and a request in the background when the price is missing or old. */
  get() {
    this.refresh();
    return this.current();
  }

  /** Asks CoinGecko when allowed and due. Resolves to the price shown afterwards (or null). */
  refresh({ force = false } = {}) {
    const prefs = this.prefs();
    if (!fiatAllowed(prefs)) return Promise.resolve(null);
    const cur = currencyOf(prefs);
    const now = this.clock();
    const l = this.last;
    const fresh = l && l.currency === cur && now - l.at < this.maxAgeMs;
    if (this.loading) return this.loading;
    if (!force && (fresh || now < this.waitUntil)) return Promise.resolve(this.current());
    this.loading = this.#load(cur).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async #load(cur) {
    this.requests++;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    let price = null;
    try {
      const res = await this._fetch(fiatPriceUrl(cur), {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (res.status === 429) {
        this.waitUntil = this.clock() + BUSY_BACKOFF_MS;
        this.error = { message: 'CoinGecko is busy; the price is asked again in a few minutes.', at: this.clock() }; // i18n-ignore: diagnostics, never shown
      } else if (res.status !== 200) {
        this.waitUntil = this.clock() + this.maxAgeMs;
        this.error = { message: `CoinGecko answered HTTP ${res.status}.`, at: this.clock() }; // i18n-ignore: diagnostics, never shown
      } else {
        price = parsePrice(JSON.parse(await res.text()), cur);
        if (price == null) this.error = { message: 'CoinGecko gave no price for BEAM.', at: this.clock() }; // i18n-ignore: diagnostics, never shown
      }
    } catch (e) {
      this.waitUntil = this.clock() + 30000;
      this.error = { message: `The price could not be read (${ctrl && ctrl.signal.aborted ? 'no answer in time' : (e && e.message) || e}).`, at: this.clock() }; // i18n-ignore: diagnostics, never shown
    } finally {
      if (timer) clearTimeout(timer);
    }
    // The answer is only kept if prices are still on, in the same currency.
    const prefs = this.prefs();
    if (price != null && fiatAllowed(prefs) && currencyOf(prefs) === cur) {
      this.last = { price, currency: cur, at: this.clock() };
      this.error = null;
      for (const fn of this.listeners) {
        try {
          fn(this.last);
        } catch (e) {
          console.error(e);
        }
      }
    }
    return this.current();
  }

  /** Forgets the price (prices turned off, or another currency picked). */
  forget() {
    this.last = null;
    this.error = null;
    this.waitUntil = 0;
  }
}

/** groth at `price` per BEAM, as a plain number of the currency (display only). */
export function fiatValue(groth, price) {
  return (Number(BigInt(groth)) / 1e8) * price;
}

/**
 * A money amount as people read it: "$1,240", "$12.34", "< $0.01", "€0". `locale`
 * for digit grouping (default: the browser's). USD is written with "$".
 */
export function fiatText(value, currency, locale = undefined) {
  const opts = { style: 'currency', currency, currencyDisplay: currency === 'USD' ? 'narrowSymbol' : 'symbol' };
  const fmt = (o = {}) => {
    try {
      return new Intl.NumberFormat(locale, { ...opts, ...o }).format;
    } catch {
      return new Intl.NumberFormat('en-US', { ...opts, ...o }).format;
    }
  };
  // The currency's own decimals (yen: none), at most two.
  const places = Math.min(2, new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits);
  const exact = { minimumFractionDigits: places, maximumFractionDigits: places };
  if (!(value > 0)) return fmt(exact)(0);
  const smallest = 10 ** -places;
  if (value < smallest) return `< ${fmt(exact)(smallest)}`;
  if (value >= 1000) return fmt({ minimumFractionDigits: 0, maximumFractionDigits: 0 })(Math.floor(value));
  // Rounded down: an estimate never shows more than the exact value.
  const step = 10 ** places;
  return fmt(exact)(Math.floor(value * step + 1e-9) / step);
}

/** "≈ $12.34" (or "< $0.01") for `groth` at `p` ({price, currency}); null without a price. */
export function fiatEstimate(groth, p, locale = undefined) {
  if (!p || groth == null) return null;
  const money = fiatText(fiatValue(groth, p.price), p.currency, locale);
  return money.startsWith('<') ? money : `≈ ${money}`;
}
