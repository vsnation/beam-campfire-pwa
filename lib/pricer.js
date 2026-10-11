// What a Confidential Asset is worth in BEAM, from BEAM's DEX: a port of the
// desktop app's lib/wallets/beam/price/beam_asset_pricer.dart, so both apps
// value a holding the same way. Pure: pools in, groth out (BigInt throughout).
// The pools are the ones the wallet already reads from its own node
// (pools_view, lib/dex_pools.js): valuing a token asks no one.
//
// Each asset is priced from its deepest BEAM pool: the pool, of any kind,
// holding the most BEAM. Anyone can create an asset and a pool for it, and set
// its price with the first deposit, so:
// - a verified asset (lib/meta.js VERIFIED) is valued at the spot price of its
//   deepest pool holding at least 1 BEAM;
// - any other asset needs a pool holding at least 1,000 BEAM, and is valued at
//   what that pool would actually pay for the holding (tok1 * a / (tok2 + a),
//   before the pool fee): never more than the BEAM someone locked in its pool.
//   Such values are "sale values" (isSaleValue), and the screens say so.
// A DEX liquidity (LP) token is worth what withdrawing it pays out
// (lpAmount / ctl of each reserve), each side valued as above; a side priced
// by this very pool is sold back into what the withdraw leaves in it.
//
// Values are estimates and are labelled so. Every Confidential Asset has 8
// decimals, so a holding is valued in groth straight from the reserves.

import { VERIFIED } from './meta.js';

export const ONE_BEAM = 100000000n;

/** 1,000 BEAM: the least a pool must hold before it may value an asset BEAM Campfire does not vouch for. */
export const MIN_UNVERIFIED_BEAM_RESERVE = 1000n * ONE_BEAM;

/** LP tokens of pools of LP tokens of… are valued this many levels deep at most. */
const MAX_LP_DEPTH = 3;

const abs = (v) => (v < 0n ? -v : v);
function gcd(a, b) {
  a = abs(a);
  b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/** An exact fraction n/d of BigInts, d > 0 (the desktop's BeamRatio). */
export function ratio(n, d = 1n) {
  if (d === 0n) throw new RangeError('zero denominator');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
}
const mul = (a, b) => ratio(a.n * b.n, a.d * b.d);
const add = (a, b) => ratio(a.n * b.d + b.n * a.d, a.d * b.d);
/** The largest integer not above r. */
export function floor(r) {
  const q = r.n / r.d; // truncates toward zero
  return r.n < 0n && q * r.d !== r.n ? q - 1n : q;
}

/** No liquidity: nothing trades and the first deposit sets the price. */
export const isEmptyPool = (p) => !p || p.ctl === 0n || p.tok1 === 0n || p.tok2 === 0n;

export class AssetPricer {
  /**
   * pools: lib/dex.js parsePools rows ({aid1, aid2, kind, ctl, tok1, tok2, lpToken}).
   * isVerified(id): whether BEAM Campfire vouches for the asset (default: lib/meta.js VERIFIED).
   */
  constructor(pools, { minBeamReserve = ONE_BEAM, minUnverifiedBeamReserve = MIN_UNVERIFIED_BEAM_RESERVE, isVerified = (id) => Object.prototype.hasOwnProperty.call(VERIFIED, id) } = {}) {
    this.minBeamReserve = minBeamReserve;
    this.minUnverifiedBeamReserve = minUnverifiedBeamReserve;
    this.isVerified = (id) => Boolean(isVerified(Number(id)));
    const deepest = new Map();
    for (const p of pools || []) {
      if (p.aid1 !== 0 || isEmptyPool(p)) continue;
      if (p.tok1 < this.minReserveFor(p.aid2) || p.tok2 <= 0n) continue;
      const cur = deepest.get(p.aid2);
      if (!cur || p.tok1 > cur.tok1) deepest.set(p.aid2, p);
    }
    this.beamPools = deepest;
    this.byLpToken = new Map();
    for (const p of pools || []) if (!isEmptyPool(p) && p.ctl > 0n && p.lpToken != null) this.byLpToken.set(p.lpToken, p);
  }

  minReserveFor(assetId) {
    return this.isVerified(assetId) ? this.minBeamReserve : this.minUnverifiedBeamReserve;
  }

  /** The pool that prices `assetId`, or null when no BEAM pool qualifies. */
  pricingPool(assetId) {
    return this.beamPools.get(Number(assetId)) || null;
  }

  /** The pool `assetId` is the LP token of (with liquidity), or null. */
  lpPool(assetId) {
    return this.byLpToken.get(Number(assetId)) || null;
  }

  /**
   * True when valueInGroth values `assetId` as a sale into its pool (an
   * unverified asset, or an LP token with an unverified side), not at a
   * verified asset's spot price.
   */
  isSaleValue(assetId) {
    return this.#isSale(Number(assetId), 0);
  }

  #isSale(id, depth) {
    if (id === 0) return false;
    const lp = this.byLpToken.get(id);
    if (lp && depth < MAX_LP_DEPTH) return this.#isSale(lp.aid1, depth + 1) || this.#isSale(lp.aid2, depth + 1);
    return !this.isVerified(id) && this.beamPools.has(id);
  }

  /** Groth per smallest unit of `assetId` at its pool's spot price ({n, d}); BEAM is exactly one. */
  grothPerUnit(assetId) {
    const id = Number(assetId);
    if (id === 0) return ratio(1n);
    const p = this.beamPools.get(id);
    return p ? ratio(p.tok1, p.tok2) : null;
  }

  /**
   * What `amount` smallest units of `assetId` are worth in groth, rounded down:
   * spot for a verified asset, what its pool would pay for an unverified one,
   * what a withdraw pays out for an LP token. Null when it cannot be priced.
   */
  valueInGroth(assetId, amount) {
    return this.#value(Number(assetId), BigInt(amount), 0);
  }

  #value(id, amount, depth) {
    if (amount <= 0n) return 0n;
    if (id === 0) return amount;
    const lp = this.byLpToken.get(id);
    if (lp && depth < MAX_LP_DEPTH) return this.#lpValue(lp, amount, depth);
    return this.#directValue(id, amount);
  }

  #directValue(id, amount) {
    const p = this.beamPools.get(id);
    if (!p) return null;
    if (this.isVerified(id)) return floor(mul(ratio(p.tok1, p.tok2), ratio(amount)));
    // Sold into the pool: x·y = k, so the BEAM out is tok1·a / (tok2 + a), always below the pool's BEAM.
    return (p.tok1 * amount) / (p.tok2 + amount);
  }

  /** lpAmount LP tokens of `pool`: the share lpAmount / ctl of each reserve, each valued, added exactly, rounded down once. */
  #lpValue(pool, lpAmount, depth) {
    const share = ratio(lpAmount > pool.ctl ? pool.ctl : lpAmount, pool.ctl);
    const v1 = this.#sideValue(pool, pool.aid1, pool.tok1, share, depth);
    const v2 = this.#sideValue(pool, pool.aid2, pool.tok2, share, depth);
    if (v1 == null || v2 == null) return null;
    return floor(add(v1, v2));
  }

  /** `share` of `pool`'s `reserve` of `id`, in groth (a fraction). */
  #sideValue(pool, id, reserve, share, depth) {
    const part = mul(share, ratio(reserve));
    if (id === 0) return part;
    const pricing = this.beamPools.get(id);
    if (pricing && this.isVerified(id) && !this.byLpToken.has(id)) {
      // At spot: share × reserve × tok1 / tok2 of its BEAM pool.
      return mul(part, ratio(pricing.tok1, pricing.tok2));
    }
    // Sold, so in whole smallest units: what a withdraw would pay out (rounded down, Totals::Remove).
    const amount = floor(part);
    if (pricing && pricing.lpToken === pool.lpToken && !this.byLpToken.has(id)) {
      // This very pool prices the asset: sold back into what the withdraw leaves in it.
      const beamLeft = pool.tok1 - floor(mul(share, ratio(pool.tok1)));
      if (beamLeft <= 0n || amount === 0n) return ratio(0n);
      return ratio((beamLeft * amount) / pool.tok2);
    }
    const v = this.#value(id, amount, depth + 1);
    return v == null ? null : ratio(v);
  }

  /**
   * Values every holding in `balances` (Map or object: asset id -> smallest units)
   * -> { totalGroth, values: Map(id -> groth), unpriced: [ids, sorted] }.
   */
  portfolio(balances) {
    let total = 0n;
    const values = new Map();
    const unpriced = [];
    const entries = balances instanceof Map ? [...balances] : Object.entries(balances || {});
    for (const [k, amount] of entries) {
      const id = Number(k);
      const v = this.valueInGroth(id, amount);
      if (v == null) unpriced.push(id);
      else {
        values.set(id, v);
        total += v;
      }
    }
    unpriced.sort((a, b) => a - b);
    return { totalGroth: total, values, unpriced };
  }
}
