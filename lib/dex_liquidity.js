// BEAM's DEX pools: positions, adding and withdrawing liquidity, creating a pool.
// Mirrors the desktop app (lib/wallets/beam/contracts/dex/: dex_args.dart,
// beam_pool.dart, beam_dex_quotes.dart, beam_dex_service.dart; the pricer in
// lib/wallets/beam/price/beam_asset_pricer.dart; DexFormat in
// lib/widgets/beam/dex/dex_format.dart). Amounts are BigInt in each asset's
// smallest unit (every Confidential Asset has 8 decimals, LP tokens too).
//
// A transaction is checked twice before anyone is asked to approve it:
// 1. inspect: the raw_data the engine built is decoded in full and must be one
//    call of the DEX contract, the expected method, the exact packed arguments,
//    and funds that match them (bvm/Shaders/amm/contract.h, app.cpp at
//    beam-7.5.14493). The side the shader computed (the matching amount of a
//    deposit, what a withdrawal returns) may differ from the quote by at most
//    the price protection (1%), or the call stops before it is shown.
// 2. expect: what the engine then asks consent for must be exactly what was
//    decoded, fee included.

import { DEX_CID, DEX_CALL_FEE, KINDS, DexError, isLive, valueInBeam, lpTokens, tradable, PROTECTION_BPS, bpsText } from './dex.js';
import { readContractTx, entryFee, le, concat, bytesEqual, spendText } from './contract_tx.js';

/** Contract methods (Amm::Method). */
export const METHOD = Object.freeze({ create: 3, destroy: 4, add: 5, withdraw: 6, trade: 7 });

/** Kernel comments the pinned AMM shader writes (app.cpp GenerateKernel). */
export const KERNEL = Object.freeze({ add: 'Amm add', withdraw: 'Amm withdraw', create: 'Amm create pool' });

/** Network fee of an add or a withdraw: 0.011 BEAM (no BVM charge declared; the core's minimum, as a trade). */
export const LIQUIDITY_FEE = DEX_CALL_FEE;

/** pool_create locks 10 BEAM in the contract; pool_destroy returns it once the pool is empty. */
export const POOL_CREATE_DEPOSIT = 1000000000n;

/** BVM charge pool_create declares: CallFar + AssetManage + SaveVar_For(61-byte Pool) + 200 cycles. */
export const POOL_CREATE_CHARGE = 137100;

/** Network fee of pool_create: 0.01471 BEAM (Pool::ID 9 + PubKey 33 bytes of arguments). */
export const POOL_CREATE_FEE = entryFee({ argsBytes: 42, spendAssets: [0], charge: POOL_CREATE_CHARGE });

/** The fee tiers as the create screen offers them: the usual 1% first. */
export const KIND_CHOICES = Object.freeze([
  Object.freeze({ kind: 2, title: '1% fee · recommended', hint: 'Most BEAM pools use this. Right for most tokens.' }),
  Object.freeze({ kind: 1, title: '0.3% fee', hint: 'For pairs whose prices move less.' }),
  Object.freeze({ kind: 0, title: '0.05% fee', hint: 'For assets that track each other closely.' }),
]);

/** Withdraw shortcuts, in percent of the position. */
export const WITHDRAW_STEPS = Object.freeze([25, 50, 75, 100]);

const MAX_AMOUNT = (1n << 63n) - 1n;
const CID_RE = /^[0-9a-f]{64}$/;
const COIN = 100000000n;

export class LiquidityError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code; // noPool, poolEmpty, poolExists, ratioMismatch, needBoth, tooSmall, priceMoved, unexpected, shader, busy
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------- args

function assetId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new DexError('unexpected', `bad asset ${id}`);
  return n;
}

function amount(v, name) {
  const b = BigInt(v);
  if (b <= 0n) throw new DexError('unexpected', `${name} must be positive`);
  if (b > MAX_AMOUNT) throw new DexError('unexpected', `${name} too large`);
  return b.toString();
}

function kindOf(k) {
  const n = Number(k);
  if (!KINDS[n]) throw new DexError('unexpected', `unknown pool kind ${k}`);
  return n;
}

function pair(a, b) {
  const x = assetId(a);
  const y = assetId(b);
  if (x === y) throw new DexError('unexpected', 'the two assets must differ');
  return x < y ? [x, y] : [y, x];
}

function join(action, cid, params) {
  if (!CID_RE.test(cid)) throw new DexError('unexpected', 'bad contract id');
  return [`action=${action}`, `cid=${cid}`, ...Object.entries(params).map(([k, v]) => `${k}=${v}`)].join(',');
}

/** pool_view: one pool, in pool order whatever order is given. */
export function poolViewArgs({ aidA, aidB, kind, cid = DEX_CID }) {
  const [a1, a2] = pair(aidA, aidB);
  return join('pool_view', cid, { aid1: String(a1), aid2: String(a2), kind: String(kindOf(kind)) });
}

/**
 * pool_add_liquidity, always in pool order (aid1 < aid2). Leave one amount
 * null and the shader computes it from the reserves (an empty pool needs both).
 * The prediction prints {res: {tok1, tok2, ctl}}: both deposits and the LP minted.
 */
export function addLiquidityArgs({ aid1, aid2, kind, amount1 = null, amount2 = null, predictOnly, cid = DEX_CID }) {
  const [a1, a2] = pair(aid1, aid2);
  if (a1 !== Number(aid1)) throw new DexError('unexpected', 'assets must be in pool order');
  if (amount1 == null && amount2 == null) throw new DexError('unexpected', 'give at least one amount');
  return join('pool_add_liquidity', cid, {
    aid1: String(a1),
    aid2: String(a2),
    kind: String(kindOf(kind)),
    val1: amount1 == null ? '0' : amount(amount1, 'amount1'),
    val2: amount2 == null ? '0' : amount(amount2, 'amount2'),
    bPredictOnly: predictOnly ? '1' : '0',
  });
}

/** pool_withdraw: burn `ctl` LP tokens. The prediction prints {res: {ctl, tok1, tok2}} in pool order. */
export function withdrawArgs({ aid1, aid2, kind, ctl, predictOnly, cid = DEX_CID }) {
  const [a1, a2] = pair(aid1, aid2);
  if (a1 !== Number(aid1)) throw new DexError('unexpected', 'assets must be in pool order');
  return join('pool_withdraw', cid, { aid1: String(a1), aid2: String(a2), kind: String(kindOf(kind)), ctl: amount(ctl, 'ctl'), bPredictOnly: predictOnly ? '1' : '0' });
}

/** pool_create: a new, empty pool, written in pool order. No prediction mode. */
export function createPoolArgs({ aidA, aidB, kind, cid = DEX_CID }) {
  const [a1, a2] = pair(aidA, aidB);
  return join('pool_create', cid, { aid1: String(a1), aid2: String(a2), kind: String(kindOf(kind)) });
}

// ---------------------------------------------------------------- shader output

const big = (v, name) => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new LiquidityError('unexpected', `the prediction's ${name} is not an amount`);
};

function res(out) {
  const r = out && out.res;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new LiquidityError('unexpected', 'the prediction printed nothing');
  return r;
}

/** A pool_add_liquidity prediction asked in pool order: { amount1, amount2, lpMinted }. */
export function parseAddQuote(out, pool) {
  const r = res(out);
  return { pool, amount1: big(r.tok1, 'tok1'), amount2: big(r.tok2, 'tok2'), lpMinted: big(r.ctl, 'ctl') };
}

/** A pool_withdraw prediction: { lpBurned, amount1, amount2 } in pool order. */
export function parseWithdrawQuote(out, pool) {
  const r = res(out);
  return { pool, lpBurned: big(r.ctl, 'ctl'), amount1: big(r.tok1, 'tok1'), amount2: big(r.tok2, 'tok2') };
}

/** A shader's refusal as a reason a screen can name. */
export function liquidityErrorFor(message) {
  const m = String(message || '');
  switch (m) {
    case 'no such pool':
      return new LiquidityError('noPool', m);
    case 'no liquidity':
      return new LiquidityError('poolEmpty', m);
    case 'pool already exists':
      return new LiquidityError('poolExists', m);
    case 'val1 too large':
    case 'val2 too large':
      return new LiquidityError('ratioMismatch', m);
    case 'pool empty - both tokens must be specified':
      return new LiquidityError('needBoth', m);
    default:
      return new LiquidityError('shader', m);
  }
}

// ---------------------------------------------------------------- pools and positions

export const poolKey = (p) => `${p.aid1}-${p.aid2}-${p.kind}`;

/** The pool {aid1, aid2, kind} names in `pools`, or null. */
export function findPool(pools, { aid1, aid2, kind }) {
  const [a1, a2] = Number(aid1) < Number(aid2) ? [Number(aid1), Number(aid2)] : [Number(aid2), Number(aid1)];
  return (pools || []).find((p) => p.aid1 === a1 && p.aid2 === a2 && p.kind === Number(kind)) || null;
}

/** The pool whose LP token `id` is, from a pool list. */
export function poolOfLp(pools, id) {
  return (pools || []).find((p) => p.lpToken === Number(id)) || null;
}

/** No liquidity: nothing can be traded, and the first deposit sets the price. */
export const isEmptyPool = (p) => !isLive(p);

/** A position's share of the pool, as an exact fraction {num, den} (0 when the pool has none). */
export function shareOf(pool, lp) {
  const held = BigInt(lp);
  if (pool.ctl <= 0n || held <= 0n) return { num: 0n, den: 1n };
  return { num: held > pool.ctl ? pool.ctl : held, den: pool.ctl };
}

/**
 * What `lp` LP tokens take out of the pool now: the share of each reserve,
 * rounded down (Totals::Remove), or the whole reserves for the last provider.
 * The contract's own floating point can differ by a groth; the prediction is
 * what is shown before a withdrawal.
 */
export function positionAmounts(pool, lp) {
  const held = BigInt(lp);
  if (pool.ctl <= 0n || held <= 0n || held > pool.ctl) return { amount1: 0n, amount2: 0n };
  if (held === pool.ctl) return { amount1: pool.tok1, amount2: pool.tok2 };
  return { amount1: (pool.tok1 * held) / pool.ctl, amount2: (pool.tok2 * held) / pool.ctl };
}

/** The share of the pool after a deposit that mints `minted`, counting what is already held. */
export function shareAfterAdd(pool, minted, held = 0n) {
  const m = BigInt(minted);
  const h = BigInt(held);
  const den = pool.ctl + m;
  return den > 0n ? { num: h + m, den } : { num: 0n, den: 1n };
}

/** LP tokens to burn for `pct` percent of `held` (100: all of it, never a groth left over). */
export function lpForPercent(held, pct) {
  const h = BigInt(held);
  const p = BigInt(Math.max(0, Math.min(100, Math.round(Number(pct)))));
  return p >= 100n ? h : (h * p) / 100n;
}

/**
 * The most of `side` (1 or 2) a deposit can take when both balances must
 * cover it at the pool's ratio: the side's own balance, or what the other
 * balance pays for at the reserves (a groth of room for the shader's rounding).
 * `avail1`/`avail2` are what can be spent (BEAM already less the network fee).
 */
export function maxDeposit(pool, side, avail1, avail2) {
  const a1 = BigInt(avail1) > 0n ? BigInt(avail1) : 0n;
  const a2 = BigInt(avail2) > 0n ? BigInt(avail2) : 0n;
  if (isEmptyPool(pool)) return side === 1 ? a1 : a2;
  if (side === 1) {
    const byOther = a2 > 2n ? ((a2 - 2n) * pool.tok1) / pool.tok2 : 0n;
    return a1 < byOther ? a1 : byOther;
  }
  const byOther = a1 > 2n ? ((a1 - 2n) * pool.tok2) / pool.tok1 : 0n;
  return a2 < byOther ? a2 : byOther;
}

// ---------------------------------------------------------------- value

const MAX_LP_DEPTH = 3;

/**
 * What `amount` of `id` is worth in groth, as the desktop's BeamAssetPricer
 * values it: BEAM itself; an LP token as what a withdrawal of it pays out,
 * each side valued; anything else from its deepest BEAM pool (lib/dex.js
 * valueInBeam: a verified asset at spot, any other only from a 1,000 BEAM pool,
 * as sold into it). Null when it cannot be priced.
 */
export function valueOf(pools, id, amt, isVerified, depth = 0) {
  const a = BigInt(amt);
  if (a <= 0n) return 0n;
  if (Number(id) === 0) return a;
  const lp = depth < MAX_LP_DEPTH ? (pools || []).find((p) => p.lpToken === Number(id) && isLive(p)) : null;
  if (lp) return lpValue(pools, lp, a, isVerified, depth);
  return valueInBeam(pools, Number(id), a, isVerified);
}

function lpValue(pools, pool, lp, isVerified, depth) {
  const held = lp > pool.ctl ? pool.ctl : lp;
  const side = (aid, reserve) => {
    if (aid === 0) return { num: reserve * held, den: pool.ctl };
    const pricing = beamPoolOf(pools, aid, isVerified);
    const isLp = (pools || []).some((p) => p.lpToken === aid && isLive(p));
    if (pricing && isVerified(aid) && !isLp) return { num: reserve * held * pricing.tok1, den: pool.ctl * pricing.tok2 };
    const part = (reserve * held) / pool.ctl;
    if (pricing && pricing.lpToken === pool.lpToken && !isLp) {
      // This very pool prices the asset: sold back into what the withdrawal leaves in it.
      const beamLeft = pool.tok1 - (pool.tok1 * held) / pool.ctl;
      if (beamLeft <= 0n || part === 0n) return { num: 0n, den: 1n };
      return { num: (beamLeft * part) / pool.tok2, den: 1n };
    }
    const v = valueOf(pools, aid, part, isVerified, depth + 1);
    return v == null ? null : { num: v, den: 1n };
  };
  const v1 = side(pool.aid1, pool.tok1);
  const v2 = side(pool.aid2, pool.tok2);
  if (!v1 || !v2) return null;
  return (v1.num * v2.den + v2.num * v1.den) / (v1.den * v2.den);
}

/** The deepest BEAM pool that may price `aid` (as valueInBeam picks it), or null. */
function beamPoolOf(pools, aid, isVerified) {
  const min = isVerified(aid) ? 100000000n : 1000n * 100000000n;
  let best = null;
  for (const p of pools || []) {
    if (p.aid1 !== 0 || p.aid2 !== aid || !isLive(p) || p.tok1 < min) continue;
    if (!best || p.tok1 > best.tok1) best = p;
  }
  return best;
}

/** Both sides of a pool valued in groth; null when a side has no price. */
export function poolSize(pools, pool, isVerified) {
  if (!isLive(pool)) return null;
  const v1 = valueOf(pools, pool.aid1, pool.tok1, isVerified);
  const v2 = valueOf(pools, pool.aid2, pool.tok2, isVerified);
  return v1 == null || v2 == null ? null : v1 + v2;
}

/** For ordering only: a side without a price counts as nothing. */
export function poolDepth(pools, pool, isVerified) {
  const v1 = valueOf(pools, pool.aid1, pool.tok1, isVerified) ?? 0n;
  const v2 = valueOf(pools, pool.aid2, pool.tok2, isVerified) ?? 0n;
  return v1 + v2;
}

// ---------------------------------------------------------------- the list

/**
 * The pools list as the desktop orders it: the pools this wallet holds a share
 * of first (empty or not), then every pool with liquidity, both deepest first.
 * `held(lpToken)` gives the LP held; `matches(pool)` filters.
 */
export function arrangePools(pools, { held, matches = () => true, isVerified }) {
  const mine = [];
  const rest = [];
  for (const p of pools || []) {
    if (!matches(p)) continue;
    if (p.lpToken != null && held(p.lpToken) > 0n) mine.push(p);
    else if (isLive(p)) rest.push(p);
  }
  const depth = new Map([...mine, ...rest].map((p) => [p, poolDepth(pools, p, isVerified)]));
  const order = (a, b) => (depth.get(b) > depth.get(a) ? 1 : depth.get(b) < depth.get(a) ? -1 : a.aid1 - b.aid1 || a.aid2 - b.aid2 || a.kind - b.kind);
  return { mine: mine.sort(order), rest: rest.sort(order) };
}

/** Search by name, ticker or number ("#174" or "174"), on either side of the pool. */
export function poolMatches(pool, query, labelOf) {
  const q = String(query || '').trim().toLowerCase().replace(/^#/, '');
  if (!q) return true;
  return [pool.aid1, pool.aid2].some((id) => {
    const l = labelOf(id);
    return String(id) === q || String(l.unit || '').toLowerCase().includes(q) || String(l.name || '').toLowerCase().includes(q) || String(l.symbol || '').toLowerCase().includes(q);
  });
}

/**
 * Assets a new pool can be made of: every asset with a pool, and every asset
 * this wallet holds, LP tokens left out; BEAM first, then by number.
 */
export function creatableAssets(pools, heldIds) {
  const lp = lpTokens(pools || []);
  const ids = new Set([0, ...tradable(pools || []), ...[...(heldIds || [])].filter((id) => !lp.has(id))]);
  return [...ids].sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b));
}

// ---------------------------------------------------------------- numbers

const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** num/den as a fixed decimal with `places` digits, truncated. */
function fixed(num, den, places) {
  const scale = 10n ** BigInt(places);
  const scaled = (num * scale) / den;
  const s = scaled.toString().padStart(places + 1, '0');
  return places ? `${s.slice(0, -places)}.${s.slice(-places)}` : s;
}

/**
 * A human number from an exact ratio, rounded down (DexFormat.number): from
 * 1,000 two decimals, from 1 four, below 1 four significant digits.
 */
export function ratioText(num, den) {
  let n = BigInt(num);
  const d = BigInt(den);
  if (d <= 0n) return '—';
  if (n === 0n) return '0';
  const neg = n < 0n;
  if (neg) n = -n;
  let places;
  if (n >= 1000n * d) places = 2;
  else if (n >= d) places = 4;
  else {
    let p = 0;
    let scaled = n;
    while (scaled < d && p < 12) {
      scaled *= 10n;
      p++;
    }
    places = Math.min(Math.max(p + 3, 1), 12);
  }
  let s = fixed(n, d, places);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '0') return neg ? '> -0.000000000001' : '< 0.000000000001';
  const dot = s.indexOf('.');
  const w = dot < 0 ? s : s.slice(0, dot);
  const rest = dot < 0 ? '' : s.slice(dot);
  return `${neg ? '-' : ''}${group(w)}${rest}`;
}

/** An amount for lists (DexFormat.compact): rounded down to what people read. */
export function compact(groth) {
  return ratioText(BigInt(groth), COIN);
}

/** A fraction as a percentage (DexFormat.percent): "0.13%", "12.5%", "< 0.01%", never a misleading "0%". */
export function percentText(num, den) {
  const n = BigInt(num) * 100n;
  const d = BigInt(den);
  if (d <= 0n || n === 0n) return '0%';
  if (n * 100n < d) return '< 0.01%';
  const places = n >= 10n * d ? 1 : 2;
  const s = fixed(n, d, places).replace(/0+$/, '').replace(/\.$/, '');
  return `${s}%`;
}

/** "≈ 12.3 BEAM" for a value in groth; "under 0.00000001 BEAM" for less than a groth's worth. */
export function beamWorth(groth) {
  if (groth == null) return 'No price';
  return BigInt(groth) > 0n ? `≈ ${compact(groth)} BEAM` : 'under 0.00000001 BEAM';
}

/** How much the quote's `want` may differ from `got` before a call stops, in basis points. */
export function movedBps(want, got) {
  const w = BigInt(want);
  const g = BigInt(got);
  if (w <= 0n) return g === 0n ? 0n : 10000n;
  const diff = w > g ? w - g : g - w;
  return (diff * 10000n) / w;
}

// ---------------------------------------------------------------- built transactions

const unexpected = (what) => {
  throw new LiquidityError('unexpected', 'The DEX built a different transaction than this screen shows, so it was not sent. Try again; if it keeps happening, report it.', { detail: what });
};

/** Pool::ID as the contract packs it: aid1, aid2 (4 bytes each, little-endian), kind (1 byte). */
export const poolIdBytes = (pool) => concat(le(pool.aid1, 4), le(pool.aid2, 4), le(pool.kind, 1));

/** Decodes raw_data and checks it is one call of the DEX: this method, this comment, this charge, no signatures, the stored args. */
function checkCall(raw, { method, comment, charge, args }) {
  let d;
  try {
    d = readContractTx(raw);
  } catch (e) {
    unexpected(`cannot read the prepared transaction: ${e.message}`);
  }
  if (d.entries.length !== 1) unexpected('expected one contract call');
  const e = d.entries[0];
  if (e.contractId !== DEX_CID) unexpected(`the call targets ${e.contractId}, not the DEX`);
  if (e.method !== method) unexpected(`contract method ${e.method}, expected ${method}`);
  if (e.comment !== comment) unexpected(`kernel comment "${e.comment}"`);
  if (e.charge !== charge) unexpected(`BVM charge ${e.charge}, expected ${charge}`);
  if (e.signatureCount !== 0) unexpected(`${e.signatureCount} signing keys`);
  if (d.appArgs) {
    for (const kv of args.split(',')) {
      const i = kv.indexOf('=');
      const k = kv.slice(0, i);
      if (!Object.prototype.hasOwnProperty.call(d.appArgs, k) || d.appArgs[k] !== kv.slice(i + 1)) unexpected('stored shader args differ from the request');
    }
  }
  return d;
}

const readU64 = (bytes, at) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]);
  return v;
};

/**
 * A deposit the engine built: AddLiquidity {Pool::ID, tok1, tok2}, paying
 * exactly those two amounts and receiving only the pool's LP token. The amount
 * given must be exact; the one the shader computed, and the LP received, may
 * not differ from the quote by more than `bps`.
 */
export function checkAddBuilt(raw, { pool, amount1 = null, amount2 = null, quote, args, bps = PROTECTION_BPS }) {
  const d = checkCall(raw, { method: METHOD.add, comment: KERNEL.add, charge: 0, args });
  const a = d.entries[0].args;
  if (a.length !== 25 || !bytesEqual(a.subarray(0, 9), poolIdBytes(pool))) unexpected('the deposit names another pool');
  const tok1 = readU64(a, 9);
  const tok2 = readU64(a, 17);
  if (amount1 != null && tok1 !== BigInt(amount1)) unexpected(`deposit of ${tok1}, asked for ${amount1}`);
  if (amount2 != null && tok2 !== BigInt(amount2)) unexpected(`deposit of ${tok2}, asked for ${amount2}`);
  const s = d.spend;
  const lp = s.get(pool.lpToken);
  const okFunds = s.size === 3 && s.get(pool.aid1) === tok1 && s.get(pool.aid2) === tok2 && lp != null && lp < 0n;
  if (!okFunds) unexpected(`the deposit moves ${spendText(s)}, expected ${tok1} of ${pool.aid1}, ${tok2} of ${pool.aid2} and LP ${pool.lpToken} back`);
  if (quote) {
    const moved = [movedBps(quote.amount1, tok1), movedBps(quote.amount2, tok2), movedBps(quote.lpMinted, -lp)].reduce((m, x) => (x > m ? x : m), 0n);
    if (moved > BigInt(bps)) {
      throw new LiquidityError('priceMoved', `The pool's price moved ${bpsText(moved)} since the amounts were worked out, more than the ${bpsText(bps)} this allows. Nothing was sent.`, { moved });
    }
  }
  return d;
}

/**
 * A withdrawal the engine built: Withdraw {Pool::ID, ctl}, paying exactly `ctl`
 * LP tokens and receiving only the pool's two assets, each at most `bps` below
 * the quote.
 */
export function checkWithdrawBuilt(raw, { pool, ctl, quote, args, bps = PROTECTION_BPS }) {
  const d = checkCall(raw, { method: METHOD.withdraw, comment: KERNEL.withdraw, charge: 0, args });
  const a = d.entries[0].args;
  if (a.length !== 17 || !bytesEqual(a.subarray(0, 9), poolIdBytes(pool)) || readU64(a, 9) !== BigInt(ctl)) unexpected('the withdrawal names another pool or amount');
  const s = d.spend;
  for (const [aid, v] of s) {
    if (aid === pool.lpToken ? v !== BigInt(ctl) : !(aid === pool.aid1 || aid === pool.aid2) || v >= 0n) unexpected(`the withdrawal moves ${spendText(s)}`);
  }
  if (s.get(pool.lpToken) !== BigInt(ctl)) unexpected(`the withdrawal moves ${spendText(s)}, expected ${ctl} of LP ${pool.lpToken}`);
  const got1 = -(s.get(pool.aid1) || 0n);
  const got2 = -(s.get(pool.aid2) || 0n);
  if (got1 <= 0n && got2 <= 0n) unexpected('the withdrawal returns nothing');
  if (quote) {
    const floor = (q) => q - (q * BigInt(bps)) / 10000n;
    if (got1 < floor(quote.amount1) || got2 < floor(quote.amount2)) {
      const moved = [quote.amount1 > got1 ? movedBps(quote.amount1, got1) : 0n, quote.amount2 > got2 ? movedBps(quote.amount2, got2) : 0n].reduce((m, x) => (x > m ? x : m), 0n);
      throw new LiquidityError('priceMoved', `The pool changed since the amounts were worked out: you would get ${bpsText(moved)} less, more than the ${bpsText(bps)} this allows. Nothing was sent.`, { moved });
    }
  }
  return d;
}

/** A new pool the engine built: PoolCreate {Pool::ID, creator key}, locking exactly the 10 BEAM deposit and nothing else. */
export function checkCreateBuilt(raw, { aidA, aidB, kind, args }) {
  const [aid1, aid2] = pair(aidA, aidB);
  const d = checkCall(raw, { method: METHOD.create, comment: KERNEL.create, charge: POOL_CREATE_CHARGE, args });
  const a = d.entries[0].args;
  if (a.length !== 42 || !bytesEqual(a.subarray(0, 9), poolIdBytes({ aid1, aid2, kind: kindOf(kind) }))) unexpected('the new pool is not the one asked for');
  const s = d.spend;
  if (s.size !== 1 || s.get(0) !== POOL_CREATE_DEPOSIT) unexpected(`pool creation moves ${spendText(s)}, expected the 10 BEAM deposit`);
  return d;
}

/** The consent check: the engine must ask for exactly what was decoded, fee included. */
export function builtExpectation(getBuilt) {
  return (req) => {
    const d = getBuilt();
    const bad = { code: 'unexpected', message: 'The wallet built something other than what this screen shows. Nothing was sent.' };
    if (!d || req.kind !== 'contract') return bad;
    const same = (list, map) => list.length === map.size && list.every((x) => map.get(x.assetId) === x.amount);
    if (!same(req.spends, d.pays) || !same(req.receives, d.receives)) return bad;
    if (req.fee !== d.fee) return { code: 'unexpected', message: 'The network fee is not the one this screen expected. Nothing was sent.' };
    return null;
  };
}

// ---------------------------------------------------------------- service

/**
 * Liquidity over one wallet session (as lib/airdrop.js createAirdrop):
 *   deps.view(args) -> parsed shader output (App.view with the AMM shader)
 *   deps.transact(args, {inspect, expect, intent}) -> txId (App.transact)
 * One transaction at a time: a second tap while one is being built is refused.
 */
export function createLiquidity(deps) {
  let flow = null;

  async function view(a) {
    try {
      return await deps.view(a);
    } catch (e) {
      if (e && e.code === 'shader') throw liquidityErrorFor(e.message);
      throw e;
    }
  }

  function flowed(fn) {
    if (flow) return Promise.reject(new LiquidityError('busy', 'A pool transaction is already being prepared.'));
    const token = {};
    flow = token;
    return (async () => {
      try {
        return await fn();
      } finally {
        if (flow === token) flow = null;
      }
    })();
  }

  /** deps.transact, keeping what an inspect threw (lib/contracts.js would report every refusal as 'unexpected'). */
  async function transact(a, opts) {
    let thrown = null;
    const inspect = async (bytes, output) => {
      try {
        await opts.inspect(bytes, output);
      } catch (e) {
        thrown = e;
        throw e;
      }
      return null;
    };
    try {
      return await deps.transact(a, { ...opts, inspect });
    } catch (e) {
      if (thrown) throw thrown;
      if (e && e.code === 'shader') throw liquidityErrorFor(e.message);
      throw e;
    }
  }

  return {
    get busy() {
      return Boolean(flow);
    },

    /** One pool, fresh from the chain ({tok1, tok2, ctl, lpToken} in pool order). */
    async poolView({ aid1, aid2, kind }) {
      const out = await view(poolViewArgs({ aidA: aid1, aidB: aid2, kind }));
      const r = res(out);
      const [a1, a2] = pair(aid1, aid2);
      return { aid1: a1, aid2: a2, kind: Number(kind), ctl: big(r.ctl ?? 0, 'ctl'), tok1: big(r.tok1 ?? 0, 'tok1'), tok2: big(r.tok2 ?? 0, 'tok2'), lpToken: assetId(r['lp-token']) };
    },

    /** Predicted deposit: give one side (the shader computes the other) or, for an empty pool, both. */
    async quoteAdd(pool, { amount1 = null, amount2 = null }) {
      const q = parseAddQuote(await view(addLiquidityArgs({ aid1: pool.aid1, aid2: pool.aid2, kind: pool.kind, amount1, amount2, predictOnly: true })), pool);
      if (amount1 != null && q.amount1 !== BigInt(amount1)) throw new LiquidityError('unexpected', 'the prediction changed the amount given');
      if (amount2 != null && q.amount2 !== BigInt(amount2)) throw new LiquidityError('unexpected', 'the prediction changed the amount given');
      if (q.amount1 <= 0n || q.amount2 <= 0n || q.lpMinted <= 0n) throw new LiquidityError('tooSmall', 'too small to add');
      return q;
    },

    /** Predicted return for burning `lp` LP tokens. */
    async quoteWithdraw(pool, lp) {
      const q = parseWithdrawQuote(await view(withdrawArgs({ aid1: pool.aid1, aid2: pool.aid2, kind: pool.kind, ctl: lp, predictOnly: true })), pool);
      if (q.lpBurned !== BigInt(lp)) throw new LiquidityError('unexpected', 'the prediction burns another amount');
      if (q.amount1 <= 0n || q.amount2 <= 0n) throw new LiquidityError('tooSmall', 'too small to withdraw');
      return q;
    },

    /** Builds the deposit, checks it, asks for consent, sends it. */
    add(pool, { amount1 = null, amount2 = null, quote = null, bps = PROTECTION_BPS, intent = null }) {
      return flowed(async () => {
        const a = addLiquidityArgs({ aid1: pool.aid1, aid2: pool.aid2, kind: pool.kind, amount1, amount2, predictOnly: false });
        let built = null;
        const txId = await transact(a, {
          intent: { action: 'poolAdd', ...(intent || {}) },
          inspect: (raw) => {
            built = checkAddBuilt(raw, { pool, amount1, amount2, quote, args: a, bps });
          },
          expect: builtExpectation(() => built),
        });
        return { txId, built };
      });
    },

    /** Builds the withdrawal of `lp` LP tokens, checks it, asks for consent, sends it. */
    withdraw(pool, { lp, quote = null, bps = PROTECTION_BPS, intent = null }) {
      return flowed(async () => {
        const a = withdrawArgs({ aid1: pool.aid1, aid2: pool.aid2, kind: pool.kind, ctl: lp, predictOnly: false });
        let built = null;
        const txId = await transact(a, {
          intent: { action: 'poolWithdraw', ...(intent || {}) },
          inspect: (raw) => {
            built = checkWithdrawBuilt(raw, { pool, ctl: lp, quote, args: a, bps });
          },
          expect: builtExpectation(() => built),
        });
        return { txId, built };
      });
    },

    /** Builds a new, empty pool (10 BEAM locked), checks it, asks for consent, sends it. */
    create({ aidA, aidB, kind, intent = null }) {
      return flowed(async () => {
        const a = createPoolArgs({ aidA, aidB, kind });
        let built = null;
        const txId = await transact(a, {
          intent: { action: 'poolCreate', ...(intent || {}) },
          inspect: (raw) => {
            built = checkCreateBuilt(raw, { aidA, aidB, kind, args: a });
          },
          expect: builtExpectation(() => built),
        });
        return { txId, built };
      });
    },
  };
}

