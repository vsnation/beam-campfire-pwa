// What a crossing would do before anything is sent: its amounts and fees in
// each chain's own units, the reasons it cannot go (in plain words, for the
// screens to show as they are), and how long it takes. A port of the desktop
// app's bridge_quote.dart and the quoting half of bridge_controller.dart; the
// controller (controller.js) caches and calls these.
//
//   conditions   freezes, the bridge fee now, the prices it follows (no amount)
//   quote        one amount: what leaves, what arrives, every fee, or a block
//
// Never throws for a reason the person can act on: that is the quote's block.
// Its words are in the person's language when the quote is made (a freeze's reason, kept by
// eth_pipe.js as its English key, too).

import { BEAM_DECIMALS, SEND_FEE, CLAIM_FEE, ethToGroth, grothToEth } from './routes.js';
import { b2eRelayerFeeGroth, e2bRelayerFee, floorToGrid, cappedGas, FEE_WARN_SHARE } from './fees.js';
import { BridgeError } from './beam_pipe.js';
import { DIRECTIONS } from './store.js';
import { t } from '../i18n.js';

export { DIRECTIONS };

const MIN = 60000;

/** How long crossings take, from 1,575 crossings indexed in 2026 (research note 06, C.3). */
export const TIMING = Object.freeze({
  /** To Ethereum: 61 BEAM blocks and the payout (p50 64-69 min). */
  toEthereumMs: 65 * MIN,
  /** To BEAM: the bridge brings it in 1.5-2 min (p50), then the claim. */
  toBeamMs: 2 * MIN,
  /** Not paid this long after the 61 blocks: waiting for gas. */
  gasWaitMs: 30 * MIN,
  /** Not on BEAM this long after the lock: "not delivered yet". */
  deliveryWaitMs: 30 * MIN,
  /** A claim whose sending threw and that is still claimable after this long did not go out. */
  claimWaitMs: 10 * MIN,
  /** An approval not mined after this long ends the crossing (nothing was locked). */
  approveWaitMs: 30 * MIN,
});

/** To Ethereum, the slow tail when Ethereum gas is high (BEAM route p90 ~11 h; the others ~3 h). */
export const toEthereumSlowestMs = (route) => (route.isBeam ? 11 * 60 * MIN : 3 * 60 * MIN);

/** Prices older than this refuse a crossing to Ethereum (its fee follows them)... */
export const TO_ETHEREUM_PRICE_AGE_MS = 10 * MIN;
/** ...to BEAM the fee is about $0.0002 and an hour-old price will do. */
export const TO_BEAM_PRICE_AGE_MS = 60 * MIN;
/** A review older than this is checked again before anything is sent. */
export const REVIEW_AGE_MS = 15 * MIN;

export const BLOCKS = Object.freeze({
  noAmount: 'noAmount', // nothing to move yet
  frozen: 'frozen', // a token or the pipe is paused, blacklisted or charging a fee
  noPrice: 'noPrice', // prices or Ethereum gas could not be read, or are too old
  network: 'network', // a node did not answer
  belowFee: 'belowFee', // the bridge fee is as much as the amount or more
  aboveMax: 'aboveMax', // above the bridge's limit for one crossing
  notEnough: 'notEnough', // not enough of the coin being moved
  noBeamForFee: 'noBeamForFee', // not enough BEAM for the send's network fee
  noEthForGas: 'noEthForGas', // not enough ETH for the Ethereum network fee
  noClaimFee: 'noClaimFee', // the BEAM wallet cannot pay for collecting it on BEAM
  badAmount: 'badAmount', // the amount cannot be carried (too small to arrive, off the grid)
});

/** A reason a crossing cannot go: {code (BLOCKS), title, detail}. */
export const makeBlock = (code, title, detail = null) => Object.freeze({ code, title, detail });
const block = makeBlock;

const U63 = 1n << 63n;
const toEthereum = (d) => d === DIRECTIONS.toEthereum;

/** Decimals a crossing can carry both ways: 8, or fewer when Ethereum has fewer (USDT: 6). */
export const movableDecimals = (route) => Math.min(route.ethDecimals, BEAM_DECIMALS);
export const sourceSymbol = (route, d) => (toEthereum(d) ? route.beamSymbol : route.ethSymbol);
export const destinationSymbol = (route, d) => (toEthereum(d) ? route.ethSymbol : route.beamSymbol);
export const sourceDecimals = (route, d) => (toEthereum(d) ? BEAM_DECIMALS : route.ethDecimals);
export const destinationDecimals = (route, d) => (toEthereum(d) ? route.ethDecimals : BEAM_DECIMALS);
/** The grid an amount leaving through `d` must sit on. */
export const sourceGrid = (route, d) => (toEthereum(d) ? route.beamGrid : route.ethGrid);

/** Every digit, trailing zeros trimmed, thousands grouped: 1072.5 BEAM → "1,072.5". */
export function coinText(v, decimals) {
  const unit = 10n ** BigInt(decimals);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = (a / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = decimals ? (a % unit).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

const share = (part, whole) => (whole === 0n ? 0 : Number(part) / Number(whole));
const percent = (f) => {
  const p = f * 100;
  return `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
};

const noPrice = () =>
  block(
    BLOCKS.noPrice,
    t('Prices are unavailable right now'),
    t('The bridge fee follows the price of the coin and of Ethereum gas, and Campfire could not read them. Nothing was sent; try again in a minute.'),
  );

/**
 * Freezes, the bridge fee and its prices for `route` going `direction`, read
 * now: {route, direction, at, freezes, fee, feeNow, prices, gas, gasCapped, block}.
 * To Ethereum the fee is priced at no more than fees.js MAX_FEE_GAS_PRICE
 * (gasCapped: Ethereum was dearer, so the payout waits for gas to come down).
 *   eth     the Ethereum side (eth_pipe.js EthPipe or a fake): freezes(), relayerGas()
 *   prices  the price feed (prices.js PriceFeed or a fake): usd(ids) → {usd, at}
 */
export async function readConditions({ route, direction, eth, prices, now }) {
  const blocked = (b, freezes = []) => Object.freeze({ route, direction, at: now, freezes, fee: null, feeNow: null, prices: null, gas: null, block: b });
  let freezes;
  try {
    freezes = await eth.freezes(route);
  } catch {
    // Fail closed: a payout that cannot be made would strand the coins.
    return blocked(
      block(
        BLOCKS.network,
        t("Couldn't check that {coin} can be moved right now", { coin: route.ethSymbol }),
        t('Campfire asks Ethereum before every crossing whether {coin} is paused. Your Ethereum node did not answer. Nothing was sent; try again in a minute.', { coin: route.ethSymbol }),
      ),
    );
  }
  if (freezes.length) return blocked(block(BLOCKS.frozen, t('{coin} cannot be moved right now', { coin: route.name }), freezes.map((f) => t(f.reason)).join('\n')), freezes);

  const out = toEthereum(direction);
  let p = null;
  let gas = null;
  try {
    p = await prices.usd([...new Set(['ethereum', 'beam', route.coingeckoId])]);
    if (out) gas = await eth.relayerGas();
  } catch {
    // WBEAM to BEAM pays a fixed 0.02 WBEAM: no price needed.
    if (out || !route.isBeam) return blocked(noPrice());
    p = null;
  }
  const maxAge = out ? TO_ETHEREUM_PRICE_AGE_MS : TO_BEAM_PRICE_AGE_MS;
  if (p && now - p.at > maxAge) {
    if (out || !route.isBeam) return blocked(noPrice());
    p = null;
  }
  const priced = out ? cappedGas(gas) : null;
  const fee = out ? b2eRelayerFeeGroth(route, priced, p.usd) : e2bRelayerFee(route, p ? p.usd : {});
  const feeNow = out ? b2eRelayerFeeGroth(route, gas, p.usd, { margin: 1 }) : null;
  return Object.freeze({ route, direction, at: now, freezes: [], fee, feeNow, prices: p, gas, gasCapped: Boolean(priced && priced.capped), block: fee == null ? noPrice() : null });
}

/** A quote from its parts (the controller builds a blocked one when balances cannot be read). */
export function makeQuote({ route, direction, amount, cond, balances, ethAddress, now, blockReason = null, receives, beamNetworkFee, plan = null, receiveKey = null, warnings = [] }) {
  const out = toEthereum(direction);
  return Object.freeze({
    route,
    direction,
    /** What leaves besides the fees (source units, on the route's grid). */
    amount,
    /** The bridge fee, paid to the bridge operator (source units); null when it cannot be priced. */
    fee: cond.fee,
    /** To Ethereum: the bridge's own price now, in groth (fee adds room for gas rising). */
    feeNow: cond.feeNow,
    /** What arrives (destination units). */
    receives: receives ?? (out ? grothToEth(route, amount) : ethToGroth(route, amount)),
    /** BEAM network fee: of the send (to Ethereum), or of the claim (to BEAM), groth. */
    beamNetworkFee: beamNetworkFee ?? (out ? SEND_FEE : CLAIM_FEE),
    /** To BEAM: the Ethereum transactions and their network fee (eth_pipe.js planLock). */
    plan,
    /** To BEAM: the key the BEAM pipe pays this wallet with. */
    receiveKey,
    ethAddress,
    balances,
    prices: cond.prices,
    warnings: Object.freeze(warnings),
    block: blockReason,
    canMove: blockReason === null,
    at: now,
  });
}

/** Everything leaving the source wallet in its own coin. */
export function totalSource(q) {
  const out = toEthereum(q.direction);
  return q.amount + (q.fee ?? 0n) + (out && q.route.isBeam ? q.beamNetworkFee : 0n) + (!out && q.route.isNativeEth && q.plan ? q.plan.maxGasCost : 0n);
}

/**
 * Moving `amount` groth of `route` to Ethereum. balances: {source, beam, eth}
 * (source: what leaves, groth; beam: BEAM for the network fee).
 */
export function quoteToEthereum({ route, amount: raw, cond, balances: bal, ethAddress, now }) {
  const amount = floorToGrid(raw, route.beamGrid);
  const fee = cond.fee;
  const sym = route.beamSymbol;
  const warnings = [];
  if (cond.gasCapped) {
    warnings.push(
      Object.freeze({
        code: 'gasHigh',
        title: t('Ethereum is unusually busy right now'),
        detail: t('Its network fee is many times its usual level, so BEAM Campfire pays the bridge a capped fee and no more. The bridge pays out once Ethereum gets cheaper, which can take hours or days. Moving later, when it is quieter, costs less.'),
      }),
    );
  }
  if (fee != null && amount > fee && share(fee, amount) > FEE_WARN_SHARE) {
    warnings.push(
      Object.freeze({
        code: 'highFee',
        title: t('The bridge fee is {percent} of what you move', { percent: percent(share(fee, amount)) }),
        detail: t("It pays for the bridge operator's Ethereum transaction, which costs the same for any amount. Moving more at once costs less per coin."),
      }),
    );
  }
  let b = cond.block;
  if (!b && amount <= 0n) b = block(BLOCKS.noAmount, t('Enter how much {coin} to move.', { coin: sym }));
  if (!b && amount <= fee) b = block(BLOCKS.belowFee, t('The bridge fee is more than the amount'), t('The bridge fee is {fee} {coin} right now. Move more than that.', { fee: coinText(fee, 8), coin: sym }));
  const max = route.maxGroth;
  if (!b && max != null && (amount > max || fee > max)) {
    b = block(BLOCKS.aboveMax, t('At most {max} {coin} per move', { max: coinText(max, 8), coin: sym }), t('The bridge refuses anything larger for good, and the {coin} would stay locked. Split it into several moves.', { coin: sym }));
  }
  if (!b && amount + fee >= U63) b = block(BLOCKS.aboveMax, t('That amount is too large to move'));
  if (!b) {
    if (route.isBeam) {
      const need = amount + fee + SEND_FEE;
      if (need > bal.source) b = block(BLOCKS.notEnough, t('Not enough BEAM'), t('With the fees this needs {need} BEAM. Your wallet has {have} BEAM.', { need: coinText(need, 8), have: coinText(bal.source, 8) }));
    } else if (amount + fee > bal.source) {
      b = block(BLOCKS.notEnough, t('Not enough {coin}', { coin: sym }), t('With the bridge fee this needs {need} {coin}. Your wallet has {have} {coin}.', { need: coinText(amount + fee, 8), have: coinText(bal.source, 8), coin: sym }));
    } else if (SEND_FEE > bal.beam) {
      b = block(BLOCKS.noBeamForFee, t('Your BEAM wallet needs {fee} BEAM for the network fee', { fee: coinText(SEND_FEE, 8) }), t('It has {have} BEAM. Receive a little BEAM first.', { have: coinText(bal.beam, 8) }));
    }
  }
  return makeQuote({ route, direction: DIRECTIONS.toEthereum, amount, cond, balances: bal, ethAddress, now, blockReason: b, warnings });
}

/** A planLock / receiveKey failure as the block the person reads. */
function lockBlock(e) {
  if (e instanceof BridgeError) {
    if (e.code === 'badAmount') return block(BLOCKS.badAmount, t("This amount can't be moved"), e.message);
    if (e.code === 'network') return block(BLOCKS.network, t("Couldn't price the Ethereum network fee"), e.message);
    // A key or an answer Campfire does not trust: refuse, say so.
    return block(BLOCKS.network, t("Couldn't check the bridge from these wallets"), t('{reason} Nothing was sent.', { reason: String(e.message) }));
  }
  return block(BLOCKS.network, t("Couldn't price the Ethereum network fee"), t('Your Ethereum node or your BEAM wallet did not answer. Nothing was sent; try again in a minute.'));
}

/**
 * Moving `amount` Ethereum units of `route` to BEAM. balances: {source, beam,
 * eth}. receiveKey() → the BEAM pipe's 33-byte key; planLock(route, {value, fee,
 * receiverKey}) → the Ethereum plan.
 */
export async function quoteToBeam({ route, amount: raw, cond, balances: bal, ethAddress, now, receiveKey, planLock }) {
  const value = floorToGrid(raw, route.ethGrid);
  const fee = cond.fee;
  const sym = route.ethSymbol;
  const dec = route.ethDecimals;
  const receives = ethToGroth(route, value);
  let b = cond.block;
  if (!b && value <= 0n) b = block(BLOCKS.noAmount, t('Enter how much {coin} to move.', { coin: sym }));
  if (!b && receives <= 0n) b = block(BLOCKS.badAmount, t('Too small to arrive on BEAM'), t('BEAM counts {beamCoin} in 8 decimals. Move at least {min} {coin}.', { beamCoin: route.beamSymbol, min: coinText(route.ethGrid, dec), coin: sym }));
  if (!b && value + fee > bal.source) b = block(BLOCKS.notEnough, t('Not enough {coin}', { coin: sym }), t('With the bridge fee this needs {need} {coin}. Your wallet has {have} {coin}.', { need: coinText(value + fee, dec), have: coinText(bal.source, dec), coin: sym }));
  let plan = null;
  let key = null;
  if (!b) {
    try {
      key = await receiveKey();
      plan = await planLock(route, { value, fee, receiverKey: key });
    } catch (e) {
      b = lockBlock(e);
      plan = null;
    }
  }
  if (!b && plan) {
    const gas = plan.maxGasCost;
    const need = gas + (route.isNativeEth ? value + fee : 0n);
    if (need > bal.eth) {
      b = block(
        BLOCKS.noEthForGas,
        route.isNativeEth ? t('Not enough ETH') : t('Not enough ETH for the Ethereum network fee'),
        route.isNativeEth
          ? t('With the fees this needs up to {need} ETH. Your wallet has {have} ETH.', { need: coinText(need, 18), have: coinText(bal.eth, 18) })
          : t('It can cost up to {fee} ETH. Your Ethereum wallet has {have} ETH.', { fee: coinText(gas, 18), have: coinText(bal.eth, 18) }),
      );
    }
  }
  if (!b && bal.beam < CLAIM_FEE) {
    b = block(
      BLOCKS.noClaimFee,
      t('Your BEAM wallet needs {fee} BEAM to collect it', { fee: coinText(CLAIM_FEE, 8) }),
      t('Coins moved to BEAM are collected with a BEAM transaction, and its network fee is {fee} BEAM. Your BEAM wallet has {have} BEAM. Receive a little BEAM first, then move.', { fee: coinText(CLAIM_FEE, 8), have: coinText(bal.beam, 8) }),
    );
  }
  return makeQuote({ route, direction: DIRECTIONS.toBeam, amount: value, cond, balances: bal, ethAddress, now, blockReason: b, receives, plan, receiveKey: key });
}
