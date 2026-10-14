// The Uniswap screens' words (screens/eth_swap*.js), with no DOM, so they can
// be tested: amounts, the rate, a pool's fee, a route as people read it.
// Ports of the desktop app's lib/pages/eth/uniswap/uniswap_format.dart and
// uniswap_widgets.dart (uniRouteText, uniRouteNote).
import { shorten } from '../dom.js';
import { compactUnits, compactRatio, exactUnits } from '../compact.js';
import { NATIVE_ETH, WETH } from './uniswap/constants.js';
import { UniV4Pool } from './uniswap/models.js';
import { TOKENS } from './tokens.js';
import { t, tn } from '../i18n.js';

export const amt = (v, tok) => `${exactUnits(v, tok.decimals)} ${tok.symbol}`;

/** Shown places for a token with more than 8 decimals (ETH): 8, as the wallet shows ETH. */
const SHOWN = 8;

/**
 * An amount as a screen shows it: every digit up to 8 decimals; beyond that
 * rounded down to 8, with "≈" unless it is a floor ("at least" stays true
 * rounded down).
 */
export function amtShown(v, tok, { floor = false } = {}) {
  if (tok.decimals <= SHOWN) return amt(v, tok);
  const cut = 10n ** BigInt(tok.decimals - SHOWN);
  const down = (v / cut) * cut;
  return `${down === v || floor ? '' : '≈'}${amt(down, tok)}`;
}
export const short = (v, tok) => `${compactUnits(v, tok.decimals)} ${tok.symbol}`;
export const ethAbout = (wei) => `${compactUnits(wei, 18)} ETH`;
/** An "at most" figure, rounded up at 8 places, so the limit is never understated. */
export function ethAtMost(wei) {
  const cut = 10n ** 10n;
  const up = wei % cut === 0n ? wei : wei + (cut - (wei % cut));
  return `${exactUnits(up, 18)} ETH`;
}
/** 100 → "1%", 50 → "0.5%". */
export const bipsText = (b) => `${b / 100}%`;
/** A pool's fee: 3000 → "0.3%", 100 → "0.01%", null → "set by its hook". */
export function feeText(hundredthsOfBip) {
  if (hundredthsOfBip == null) return t('set by its hook');
  return `${(hundredthsOfBip / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** "1 ETH ≈ 25,671.23 WBEAM". */
export function rateText(q) {
  const num = q.amountOut * 10n ** BigInt(q.tokenIn.decimals);
  const den = q.amountIn * 10n ** BigInt(q.tokenOut.decimals);
  return den === 0n ? '' : `1 ${q.tokenIn.symbol} ≈ ${compactRatio(num, den)} ${q.tokenOut.symbol}`;
}

function symbolOf(q, currency) {
  if (currency === NATIVE_ETH) return 'ETH';
  if (currency === q.tokenIn.address) return q.tokenIn.symbol;
  if (currency === q.tokenOut.address) return q.tokenOut.symbol;
  const known = TOKENS.find((x) => x.address === currency);
  const s = currency === WETH ? 'WETH' : known ? known.symbol : shorten(currency, 6, 4);
  // ETH ⇄ WETH conversions on the way are the router's own; keep "ETH".
  return s === 'WETH' && !q.tokenIn.isWeth && !q.tokenOut.isWeth ? 'ETH' : s;
}

// "v4 · 0.3%", or "v4 · 0.3% · hook" for a pool with a hook.
const poolWords = (p) => (p instanceof UniV4Pool && p.hasHooks ? t('{version} · {fee} · hook', { version: p.version, fee: feeText(p.fee) }) : `${p.version} · ${feeText(p.fee)}`);
// A route's pools in order: "v3 · 0.05%, then v4 · 0.3%" ("… then …" inside brackets). Each step is a
// whole phrase, so the order of the pools stays where a translation puts it.
const poolsOfRoute = (r, { brackets = false } = {}) =>
  r.hops
    .map((x) => poolWords(x.pool))
    .reduce((first, second) => (brackets ? t('{first} then {second}', { first, second }) : t('{first}, then {second}', { first, second })));

/** The route in words: "ETH → WBEAM" for one route; "Split over 3 pools" when the swap is shared. */
export function routeText(q) {
  // A split has two parts or more.
  if (q.isSplit) return q.parts.every((p) => p.route.isDirect) ? tn({ one: 'Split over {n} pool', other: 'Split over {n} pools' }, q.parts.length) : tn({ one: 'Split over {n} route', other: 'Split over {n} routes' }, q.parts.length);
  const r = q.route;
  return [symbolOf(q, r.hops[0].currencyIn), ...r.hops.map((x) => symbolOf(q, x.currencyOut))].join(' → ');
}

/** "Uniswap v4 · 1%" for one route; for a shared swap each share: "70% v4 · 1%, 30% via USDC (…)". */
export function routeNote(q) {
  if (!q.isSplit) return `Uniswap ${poolsOfRoute(q.route)}`;
  const share = (p) => `${Math.max(1, Math.round(q.shareOf(p) * 100))}%`;
  return q.parts.map((p) => (p.route.isDirect ? `${share(p)} ${poolsOfRoute(p.route)}` : t('{share} via {tokens} ({pools})', { share: share(p), tokens: p.route.hops.slice(1).map((x) => symbolOf(q, x.currencyIn)).join(', '), pools: poolsOfRoute(p.route, { brackets: true }) }))).join(', ');
}

/** How many different pools the swap goes through ("Shared between 2 pools."). */
export function poolCount(q) {
  return new Set(q.pools.map((p) => p.id)).size;
}

