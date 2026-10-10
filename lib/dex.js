// BEAM's DEX (the AMM contract): pools, quotes and the checks a swap must pass.
// Mirrors the desktop app (lib/wallets/beam/contracts/dex/: dex_args.dart,
// beam_dex_quotes.dart, beam_dex_service.dart, and the swap view's price
// protection). Amounts are BigInt in each asset's smallest unit (every asset has
// 8 decimals). The screens never show "kind", "aid" or "groth".

export const DEX_CID = '729fe098d9fd2b57705db1a05a74103dd4b891f535aef2ae69b47bcfdeef9cbf';

/** Network fee of a trade: 0.011 BEAM (the core's minimum for a contract call; measured on mainnet). */
export const DEX_CALL_FEE = 1100000n;

/**
 * Price protection: a swap whose engine-built transaction receives more than
 * 1% less than the quote is stopped before it is shown. 1% is also BEAM's own
 * limit when the core rebuilds a swap whose pool changed before it was mined
 * (wallet/core/contract_transaction.cpp IsSpendWithinLimitsUns).
 */
export const PROTECTION_BPS = 100n;

/** The protections offered, as on the desktop: only stricter than BEAM's own 1% make sense. */
export const PROTECTIONS = Object.freeze([100n, 50n, 10n]);

/** From this price change (3%) the swap screen warns. */
export const IMPACT_WARN_BPS = 300n;

/** From this share of the swapped value the network fee gets a warning (25%). */
export const FEE_SHARE_WARN_BPS = 2500n;

/** The default receive asset when there is a pool for it: Wrapped ETH, as on the desktop. */
export const DEFAULT_RECEIVE = 36;

const MAX_AMOUNT = (1n << 63n) - 1n;
const CID_RE = /^[0-9a-f]{64}$/;

export class DexError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // noPool, poolEmpty, tooSmall, unexpected, shader
  }
}

// ---------------------------------------------------------------- pool kinds

/** Fee tiers (Amm::FeeSettings): the wire value, the label, the exact fee rule. */
export const KINDS = Object.freeze({
  0: Object.freeze({ percent: '0.05%' }),
  1: Object.freeze({ percent: '0.3%' }),
  2: Object.freeze({ percent: '1%' }),
});

/**
 * The exact fee the contract adds to a raw price, in the paid asset
 * (FeeSettings::Get): the nominal rate rounded down plus one; 30% to the DAO.
 */
export function tradeFee(kind, rawPay) {
  const raw = BigInt(rawPay);
  let total;
  switch (Number(kind)) {
    case 0:
      total = raw / 2000n + 1n;
      break;
    case 1:
      total = (raw / 1000n) * 3n + 1n; // the contract divides first
      break;
    case 2:
      total = raw / 100n + 1n;
      break;
    default:
      throw new DexError('unexpected', `unknown pool kind ${kind}`);
  }
  const dao = (total * 3n) / 10n;
  return { pool: total - dao, dao };
}

// ---------------------------------------------------------------- args

function assetId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new DexError('unexpected', `bad asset ${id}`);
  return n;
}

function amount(v) {
  const b = BigInt(v);
  if (b <= 0n) throw new DexError('unexpected', 'amount must be positive');
  if (b > MAX_AMOUNT) throw new DexError('unexpected', 'amount too large');
  return b.toString();
}

function join(action, cid, params) {
  if (!CID_RE.test(cid)) throw new DexError('unexpected', 'bad contract id');
  return [`action=${action}`, `cid=${cid}`, ...Object.entries(params).map(([k, v]) => `${k}=${v}`)].join(',');
}

export function poolsViewArgs(cid = DEX_CID) {
  return join('pools_view', cid, {});
}

/**
 * pool_trade. aid1 is always the asset RECEIVED and aid2 the asset PAID
 * (verified on mainnet, either id order). Give exactly one of payAmount
 * (val2_pay: spend at most this) and receiveAmount (val1_buy).
 */
export function tradeArgs({ payAsset, receiveAsset, kind, payAmount = null, receiveAmount = null, predictOnly, cid = DEX_CID }) {
  const pay = assetId(payAsset);
  const recv = assetId(receiveAsset);
  if (pay === recv) throw new DexError('unexpected', 'the two assets must differ');
  if ((payAmount == null) === (receiveAmount == null)) throw new DexError('unexpected', 'give exactly one of payAmount and receiveAmount');
  if (!KINDS[kind]) throw new DexError('unexpected', `unknown pool kind ${kind}`);
  return join('pool_trade', cid, {
    aid1: String(recv),
    aid2: String(pay),
    kind: String(Number(kind)),
    val1_buy: receiveAmount == null ? '0' : amount(receiveAmount),
    val2_pay: payAmount == null ? '0' : amount(payAmount),
    bPredictOnly: predictOnly ? '1' : '0',
  });
}

// ---------------------------------------------------------------- pools

const big = (v, name) => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new DexError('unexpected', `pool field ${name} is not an amount`);
};

/** pools_view's output -> pools ({aid1, aid2, kind, ctl, tok1, tok2, lpToken}). */
export function parsePools(out) {
  const res = out && out.res;
  if (!Array.isArray(res)) throw new DexError('unexpected', 'pools_view printed no pool list');
  return res.map((p) => ({
    aid1: assetId(p.aid1),
    aid2: assetId(p.aid2),
    kind: Number(p.kind),
    ctl: big(p.ctl ?? 0, 'ctl'),
    tok1: big(p.tok1 ?? 0, 'tok1'),
    tok2: big(p.tok2 ?? 0, 'tok2'),
    lpToken: p['lp-token'] == null ? null : assetId(p['lp-token']),
  })).filter((p) => KINDS[p.kind]);
}

export const isLive = (p) => p.ctl > 0n && p.tok1 > 0n && p.tok2 > 0n;
export const pairs = (p, a, b) => a !== b && (p.aid1 === a || p.aid2 === a) && (p.aid1 === b || p.aid2 === b);
export const reserveOf = (p, a) => (a === p.aid1 ? p.tok1 : a === p.aid2 ? p.tok2 : 0n);
export const otherAsset = (p, a) => (a === p.aid1 ? p.aid2 : p.aid1);

/** LP token ids: assets that are a pool's share, not something to swap for. */
export function lpTokens(pools) {
  return new Set(pools.map((p) => p.lpToken).filter((x) => x != null));
}

/**
 * Assets that can be received for `payAsset`: the other side of every pool
 * with liquidity, LP tokens left out, BEAM first, then the deepest BEAM pools
 * (as the desktop's picker orders them).
 */
export function receivable(pools, payAsset) {
  const lp = lpTokens(pools);
  const depth = new Map();
  for (const p of pools) {
    if (!isLive(p) || (p.aid1 !== payAsset && p.aid2 !== payAsset)) continue;
    const other = otherAsset(p, payAsset);
    if (lp.has(other)) continue;
    const d = reserveOf(p, payAsset);
    if (!depth.has(other) || d > depth.get(other)) depth.set(other, d);
  }
  return [...depth.keys()].sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : depth.get(b) > depth.get(a) ? 1 : depth.get(b) < depth.get(a) ? -1 : a - b));
}

/** Every asset that has a pool with liquidity (LP tokens left out). */
export function tradable(pools) {
  const lp = lpTokens(pools);
  const ids = new Set();
  for (const p of pools) if (isLive(p)) for (const a of [p.aid1, p.aid2]) if (!lp.has(a)) ids.add(a);
  return ids;
}

// ---------------------------------------------------------------- quotes

/**
 * Checks a pool_trade prediction ({res: {buy, pay, pay_raw, fee_pool, fee_dao}})
 * against the pool's fee rule and the amount asked for. A mismatch means the
 * shader or the pool is not what this code expects: refuse, never show it.
 */
export function parseQuote(out, { pool, payAsset, receiveAsset, payAmount }) {
  const r = out && out.res;
  if (!r || typeof r !== 'object') throw new DexError('unexpected', 'the prediction printed nothing');
  if (!pairs(pool, payAsset, receiveAsset)) throw new DexError('unexpected', 'pool does not trade this pair');
  const q = {
    pool,
    kind: pool.kind,
    payAsset,
    receiveAsset,
    receive: big(r.buy, 'buy'),
    pay: big(r.pay, 'pay'),
    payRaw: big(r.pay_raw, 'pay_raw'),
    feePool: big(r.fee_pool, 'fee_pool'),
    feeDao: big(r.fee_dao, 'fee_dao'),
  };
  if (q.pay !== q.payRaw + q.feePool + q.feeDao) throw new DexError('unexpected', 'pay != pay_raw + fees');
  const want = tradeFee(pool.kind, q.payRaw);
  if (want.pool !== q.feePool || want.dao !== q.feeDao) throw new DexError('unexpected', `fees do not match a ${KINDS[pool.kind].percent} pool`);
  if (payAmount != null && q.pay > BigInt(payAmount)) throw new DexError('unexpected', 'predicted pay exceeds the amount asked for');
  q.fee = q.feePool + q.feeDao;
  return q;
}

/** Maps a shader's error text to a DEX reason. */
export function dexErrorFor(message) {
  switch (message) {
    case 'no such pool':
      return new DexError('noPool', message);
    case 'no liquidity':
      return new DexError('poolEmpty', message);
    default:
      return new DexError('shader', message);
  }
}

/**
 * The best predicted swap of payAmount: every pool with liquidity for the pair
 * is asked, and the one that delivers the most wins (ties: the one that charges
 * less). `predict(args)` runs a read-only call and returns the parsed output.
 */
export async function bestQuote(predict, { pools, payAsset, receiveAsset, payAmount }) {
  const pair = pools.filter((p) => pairs(p, payAsset, receiveAsset));
  if (!pair.length) throw new DexError('noPool', 'no pool for this pair');
  const live = pair.filter(isLive);
  if (!live.length) throw new DexError('poolEmpty', 'the pool has no liquidity');
  let best = null;
  for (const pool of live) {
    let out;
    try {
      out = await predict(tradeArgs({ payAsset, receiveAsset, kind: pool.kind, payAmount, predictOnly: true }));
    } catch (e) {
      if (e && e.code === 'shader') throw dexErrorFor(e.message);
      throw e;
    }
    const q = parseQuote(out, { pool, payAsset, receiveAsset, payAmount });
    if (!best || q.receive > best.receive || (q.receive === best.receive && q.pay < best.pay)) best = q;
  }
  if (best.receive === 0n) throw new DexError('tooSmall', 'the amount is too small to receive anything');
  return best;
}

/** How much worse than the spot price this size trades, fees excluded, in basis points. */
export function priceImpactBps(q) {
  const rp = reserveOf(q.pool, q.payAsset);
  const rr = reserveOf(q.pool, q.receiveAsset);
  if (q.payRaw === 0n || rp === 0n || rr === 0n) return 0n;
  const atSpot = q.payRaw * rr; // receive at spot, times rp
  const got = q.receive * rp;
  if (got >= atSpot) return 0n;
  return ((atSpot - got) * 10000n) / atSpot;
}

/** The least the swap may receive once the engine has built it (price protection). */
export function minReceive(q, bps = PROTECTION_BPS) {
  return q.receive - (q.receive * bps) / 10000n;
}

/** Received units per paid unit at this quote, as a display string for "1 X ≈ N Y". */
export function rateText(q, format) {
  if (q.pay === 0n) return null;
  return format((q.receive * 100000000n) / q.pay);
}

/** 1 BEAM: the least a pool must hold to price a verified asset. */
export const MIN_PRICING_RESERVE = 100000000n;
/** 1,000 BEAM: the least a pool must hold to value an asset this wallet does not vouch for. */
export const MIN_UNVERIFIED_PRICING_RESERVE = 1000n * 100000000n;

/**
 * What `amount` of `assetId` is worth in groth, from its deepest BEAM pool, as
 * the desktop's BeamAssetPricer values it (LP tokens aside): a verified asset
 * at that pool's spot price; any other only from a pool holding 1,000 BEAM, at
 * what the pool would pay for it (tok1 * a / (tok2 + a)), so a spam asset in a
 * thin pool cannot look valuable. Null when no pool prices it.
 */
export function valueInBeam(pools, assetId, amount, isVerified) {
  const a = BigInt(amount);
  if (a <= 0n) return 0n;
  if (assetId === 0) return a;
  const verified = Boolean(isVerified(assetId));
  const min = verified ? MIN_PRICING_RESERVE : MIN_UNVERIFIED_PRICING_RESERVE;
  let best = null;
  for (const p of pools || []) {
    if (p.aid1 !== 0 || p.aid2 !== assetId || !isLive(p) || p.tok1 < min) continue;
    if (!best || p.tok1 > best.tok1) best = p;
  }
  if (!best) return null;
  return verified ? (best.tok1 * a) / best.tok2 : (best.tok1 * a) / (best.tok2 + a);
}

/** The BEAM value of the swap when one side is BEAM, else null. */
export function beamValue(q) {
  if (q.payAsset === 0) return q.pay;
  if (q.receiveAsset === 0) return q.receive;
  return null;
}

/**
 * What the swap is worth in BEAM for the fee warning: the paid side, or the
 * received side when only that has a price (as the desktop). Null when
 * neither side can be valued.
 */
export function swapValue(q, pools, isVerified) {
  const v = beamValue(q);
  if (v != null) return v;
  return valueInBeam(pools, q.payAsset, q.pay, isVerified) ?? valueInBeam(pools, q.receiveAsset, q.receive, isVerified);
}

/** The network fee's share of `value`, in basis points; null when value is unknown or zero. */
export function feeShareBps(value, fee = DEX_CALL_FEE) {
  if (value == null || value <= 0n) return null;
  return (fee * 10000n) / value;
}

/** True when the 0.011 BEAM network fee is a quarter or more of the swap's value in BEAM. */
export function feeIsLarge(q, fee = DEX_CALL_FEE, value = beamValue(q)) {
  return value != null && value > 0n && fee * 10000n >= value * FEE_SHARE_WARN_BPS;
}

/**
 * The check the engine's consent request must pass before the person sees it:
 * it pays only the asset asked for and no more than quoted, and receives only
 * the asset asked for, at most `bps` (1% unless stricter) below the quote. Returns null when it passes,
 * or {code, message} - which refuses the request without showing it.
 */
export function swapExpectation(q, bps = PROTECTION_BPS) {
  const floor = minReceive(q, bps);
  return (req) => {
    if (req.kind !== 'contract') return { code: 'unexpected', message: 'The wallet built something other than a swap. Nothing was sent.' };
    const pays = req.spends;
    const gets = req.receives;
    if (pays.length !== 1 || pays[0].assetId !== q.payAsset || pays[0].amount > q.pay) {
      return { code: 'unexpected', message: 'The swap the wallet built pays something other than what was shown. Nothing was sent.' };
    }
    if (gets.length !== 1 || gets[0].assetId !== q.receiveAsset) {
      return { code: 'unexpected', message: 'The swap the wallet built receives something other than what was shown. Nothing was sent.' };
    }
    if (gets[0].amount < floor) {
      const moved = q.receive > 0n ? ((q.receive - gets[0].amount) * 10000n) / q.receive : 0n;
      return { code: 'priceMoved', message: `The price moved ${bpsText(moved)} since the quote, more than the ${bpsText(bps)} this swap allows. Nothing was sent.`, moved };
    }
    return null;
  };
}

/** 123n -> "1.23%". */
export function bpsText(bps) {
  const b = BigInt(bps);
  const whole = b / 100n;
  const frac = (b % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}${frac ? '.' + frac : ''}%`;
}
