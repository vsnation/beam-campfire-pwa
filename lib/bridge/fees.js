// What a crossing pays the bridge's relayer, computed the way the relayer
// computes its own minimum (BeamMW beam-bridge-ethrelay, utils/eth_gas.js and
// utils/eth_fee.js), the same as the desktop app's bridge_fees.dart. The
// relayer is JavaScript, so its doubles are matched exactly here.
//
// Going to Ethereum the relayer pays Ethereum gas, so the fee follows gas:
//
//   maxFeePerGas = 2 × next base fee + median tip (10 blocks, 50th
//                  percentile), the tip clamped to 0.01–3 gwei
//   fee          = relayGas × maxFeePerGas × ETH/USD / asset/USD
//
// The relayer refuses a message whose fee is below that (it re-checks it about
// every 30 minutes and relays it once gas has come down) and keeps whatever is
// above it. The wallet sets the fee, so FEE_MARGIN buys room for gas to rise
// between the quote and the relayer's check, nothing more.
//
// Going to BEAM the relayer settles on BEAM and does not check the fee; the
// official apps pay 0.02 BEAM worth, and so does Campfire.
//
// Prices are a plain map of CoinGecko id -> USD ({ ethereum: 2485.63, ... }).
// How old they may be is the quote's business, not this file's.

import { BEAM_DECIMALS } from './routes.js';

/** Room for Ethereum gas to rise before the relayer checks a b2e fee. */
export const FEE_MARGIN = 1.3;

/** Above this share of the amount, the fee is pointed out before confirming. */
export const FEE_WARN_SHARE = 0.1;

/** What an e2b crossing pays the relayer: 0.02 BEAM worth. */
export const E2B_FEE_BEAM = 0.02;

/** The relayer's tip clamp, in wei: 0.01 and 3 gwei. */
export const MIN_TIP = 10000000n;
export const MAX_TIP = 3000000000n;

const GWEI = 1000000000n;

function quantity(v) {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error(`fee history: ${String(v).slice(0, 20)} is not a hex quantity`);
  return v === '0x' ? 0n : BigInt(v);
}

/**
 * The gas price the relayer prices a b2e payout at, from
 * eth_feeHistory(0xa, "latest", [50])'s result: { baseFee, tip, maxFeePerGas, at }.
 * The base fee is the last entry (the block being built); the tip is the
 * relayer's median, sorted[floor(n / 2)] - the upper middle of an even count,
 * never an average, which would quote below its minimum.
 */
export function relayerGas(feeHistory, at = Date.now()) {
  const bases = ((feeHistory && feeHistory.baseFeePerGas) || []).map(quantity);
  if (!bases.length) throw new Error('fee history: no baseFeePerGas');
  const tips = [];
  for (const row of (feeHistory && feeHistory.reward) || []) {
    if (!Array.isArray(row)) throw new Error('fee history: a reward row is not a list');
    if (row.length) tips.push(quantity(row[0]));
  }
  tips.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let tip = tips.length ? tips[Math.floor(tips.length / 2)] : MIN_TIP;
  if (tip < MIN_TIP) tip = MIN_TIP;
  if (tip > MAX_TIP) tip = MAX_TIP;
  const baseFee = bases[bases.length - 1];
  return Object.freeze({ baseFee, tip, maxFeePerGas: baseFee * 2n + tip, at });
}

/** The USD price of `id`, or null when unknown or not a positive number. */
export function priceOf(prices, id) {
  const v = prices ? prices[id] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** `wei` in gwei as web3's fromWei(…, 'gwei') writes it: exact, no trailing zeros. */
export function weiAsGwei(wei) {
  const whole = wei / GWEI;
  const frac = (wei % GWEI).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** `v` rounded down to a multiple of `grid`. */
export const floorToGrid = (v, grid) => v - (v % grid);

/** `v` rounded up to a multiple of `grid`. */
export function ceilToGrid(v, grid) {
  const r = v % grid;
  return r === 0n ? v : v + grid - r;
}

/**
 * The relayer's minimum fee for `route` right now, in the Ethereum side's
 * smallest units, double for double as the relayer computes it
 * (eth_fee.js calcCurrentRelayerFee, beam2eth_relay.js getCurrentMinRelayerFee):
 *
 *   gasPrice   = Number(fromWei(maxFeePerGas, 'gwei'))
 *   relayCosts = (RELAY_COSTS_IN_GAS * gasPrice * ethRate) / 10^9
 *   minimum    = Math.trunc(10^ETH_SIDE_DECIMALS * (relayCosts / rate))
 *
 * Null when a price is missing (quote nothing rather than guess).
 */
export function b2eRelayerMinimum(route, gas, prices) {
  const ethRate = priceOf(prices, 'ethereum');
  const rate = priceOf(prices, route.coingeckoId);
  if (ethRate == null || rate == null) return null;
  const gasPrice = Number(weiAsGwei(gas.maxFeePerGas));
  if (!Number.isFinite(gasPrice) || gasPrice === 0) return null;
  const relayCosts = (route.relayGas * gasPrice * ethRate) / 10 ** 9;
  const minimum = 10 ** route.ethDecimals * (relayCosts / rate);
  if (!Number.isFinite(minimum) || minimum < 0) return null;
  // The double's exact value, as the relayer's BigInt(number) takes it (DAI at
  // 100 gwei is about 3.8 × 10^19 wei, past any 64-bit integer).
  return BigInt(Math.trunc(minimum));
}

/**
 * What the relayer reads from a BEAM-side amount of `groth`
 * (beam2eth_relay.js preprocessAmount): padded with zeros when the Ethereum
 * side has more decimals, its extra digits cut off when it has fewer (USDT).
 */
export function relayerReads(route, groth) {
  const d = route.ethDecimals - BEAM_DECIMALS;
  if (d > 0) return groth * 10n ** BigInt(d);
  if (d < 0) return groth / 10n ** BigInt(-d);
  return groth;
}

/**
 * The b2e relayer fee to lock, in groth: the least the relayer accepts at
 * `margin` times its current minimum. With a margin of 1 it is exactly the
 * relayer's minimum, rounded up only as far as BEAM's 8 decimals require.
 * Always on the route's grid and never zero (a zero fee is never relayed).
 * Null when a price is missing.
 */
export function b2eRelayerFeeGroth(route, gas, prices, { margin = FEE_MARGIN } = {}) {
  const minimum = b2eRelayerMinimum(route, gas, prices);
  if (minimum == null || !Number.isFinite(margin) || margin < 1) return null;
  // The margin in thousandths, rounded up, so it never undercuts.
  const permille = BigInt(Math.ceil(margin * 1000));
  const target = (minimum * permille + 999n) / 1000n;
  const d = route.ethDecimals - BEAM_DECIMALS;
  let groth;
  if (d > 0) {
    const unit = 10n ** BigInt(d);
    groth = (target + unit - 1n) / unit;
  } else if (d < 0) {
    groth = target * 10n ** BigInt(-d);
  } else {
    groth = target;
  }
  return groth < route.beamGrid ? route.beamGrid : groth;
}

/**
 * The e2b relayer fee in Ethereum units for `route` (0.02 BEAM worth), rounded
 * up to the route's Ethereum grid; null when a price is missing. The WBEAM route
 * needs no price: a fixed 2,000,000 (0.02 WBEAM).
 */
export function e2bRelayerFee(route, prices) {
  if (route.isBeam) return BigInt(Math.round(E2B_FEE_BEAM * 1e8));
  const beamUsd = priceOf(prices, 'beam');
  const assetUsd = priceOf(prices, route.coingeckoId);
  if (beamUsd == null || assetUsd == null) return null;
  const units = ((E2B_FEE_BEAM * beamUsd) / assetUsd) * 10 ** route.ethDecimals;
  if (!Number.isFinite(units) || units <= 0) return null;
  return ceilToGrid(BigInt(Math.ceil(units)), route.ethGrid);
}
