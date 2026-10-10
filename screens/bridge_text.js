// Words and numbers for the bridge screens and the bridge rows of the approve
// sheet: amounts typed and shown in each chain's own decimals, times in words,
// the limits said before anything is typed. Pure: imports only the route
// registry and the unit helpers (no network, no keys), so the approve sheet can
// load it without pulling in the Ethereum code. The desktop app's
// lib/pages/bridge/bridge_format.dart and the text half of bridge_widgets.dart.
//
// Words the screens never use: relayer, pipe, message, b2e, e2b. "The bridge"
// is BEAM's official bridge; its fee is "the bridge fee, paid to the bridge
// operator"; claiming on BEAM is "collecting".

import { BEAM_DECIMALS, SEND_FEE, CLAIM_FEE, routeById, grothToEth, ethToGroth } from '../lib/bridge/routes.js';

const MIN = 60000;
export const TO_ETHEREUM = 'toEthereum';
export const TO_BEAM = 'toBeam';

/** How long a move takes; equal to lib/bridge/quote.js TIMING (a unit test holds them together). */
export const ABOUT_TO_ETHEREUM_MS = 65 * MIN;
export const ABOUT_TO_BEAM_MS = 2 * MIN;
/** The slow tail when Ethereum gas is high: equal to quote.js toEthereumSlowestMs. */
export const slowestToEthereumMs = (route) => (route.isBeam ? 11 * 60 * MIN : 3 * 60 * MIN);

const toEth = (d) => d === TO_ETHEREUM;
export const sourceSymbol = (r, d) => (toEth(d) ? r.beamSymbol : r.ethSymbol);
export const destinationSymbol = (r, d) => (toEth(d) ? r.ethSymbol : r.beamSymbol);
export const sourceDecimals = (r, d) => (toEth(d) ? BEAM_DECIMALS : r.ethDecimals);
export const destinationDecimals = (r, d) => (toEth(d) ? r.ethDecimals : BEAM_DECIMALS);
/** Decimals a move can carry both ways: 8, or 6 for USDT. */
export const movableDecimals = (r) => Math.min(r.ethDecimals, BEAM_DECIMALS);
/** "Ethereum" / "BEAM": where a move goes. */
export const destinationChain = (d) => (toEth(d) ? 'Ethereum' : 'BEAM');
export const sourceChain = (d) => (toEth(d) ? 'BEAM' : 'Ethereum');

/** The chip a coin is picked by: BEAM (with WBEAM), ETH, WBTC, USDT, DAI. */
export const coinLabel = (r) => (r.isBeam ? 'BEAM' : r.ethSymbol);

/** Every digit, trailing zeros trimmed, thousands grouped: 1072.5 → "1,072.5". */
export function exact(v, decimals) {
  const unit = 10n ** BigInt(decimals);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = (a / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = decimals ? (a % unit).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** "1,000 BEAM", every digit. */
export const coin = (v, decimals, symbol) => `${exact(v, decimals)} ${symbol}`;

/** Rounded down to at most `places` decimals (never shows more than is there): "24.3712". */
export function rounded(v, decimals, places = 4) {
  if (decimals <= places) return exact(v, decimals);
  const cut = 10n ** BigInt(decimals - places);
  const down = v - (v % cut);
  // A tiny amount keeps its first digits rather than reading as 0.
  if (down === 0n && v > 0n) return rounded(v, decimals, Math.min(decimals, places + 4));
  return exact(down, decimals);
}

/** Rounded UP at `places` decimals: for an "at most" figure, never understated. */
export function roundedUp(v, decimals, places = 6) {
  if (decimals <= places) return exact(v, decimals);
  const cut = 10n ** BigInt(decimals - places);
  const up = v % cut === 0n ? v : v + (cut - (v % cut));
  return exact(up, decimals);
}

/** A fee, never understated: rounded up to 4 places from one whole coin up, to 8 below it. */
export const feeText = (v, decimals) => roundedUp(v, decimals, v >= 10n ** BigInt(decimals) ? 4 : 8);

/**
 * What the person typed for `route` going `direction`, in the source chain's
 * smallest unit → {value, error}. At most the decimals a move carries, so
 * nothing typed is floored away later.
 */
export function parseBridgeAmount(text, route, direction) {
  const t = String(text ?? '').trim();
  if (!t) return { value: null, error: null };
  if (t.includes(',')) return { value: null, error: 'Use a dot for decimals, like 0.5' };
  if (!/^[0-9]*\.?[0-9]*$/.test(t) || t === '.') return { value: null, error: 'Enter a number, like 0.5' };
  const dot = t.indexOf('.');
  const whole = dot < 0 ? t : t.slice(0, dot);
  const frac = dot < 0 ? '' : t.slice(dot + 1);
  const places = movableDecimals(route);
  if (frac.length > places) return { value: null, error: `${sourceSymbol(route, direction)} moves with at most ${places} decimals` };
  const dec = sourceDecimals(route, direction);
  const value = BigInt(whole || '0') * 10n ** BigInt(dec) + BigInt(frac.padEnd(dec, '0') || '0');
  const groth = toEth(direction) ? value : ethToGroth(route, value);
  if (groth >= 1n << 63n) return { value: null, error: 'That amount is too large' };
  return { value, error: null };
}

/** "About 1 hour", "About 2 minutes". */
export function about(ms) {
  const min = Math.round(ms / MIN);
  if (min >= 90) return `About ${Math.round(min / 60)} hours`;
  if (min >= 55) return 'About 1 hour';
  if (min <= 1) return 'About a minute';
  return `About ${min} minutes`;
}

/** "up to 11 hours". */
export function upTo(ms) {
  const hours = Math.floor(ms / (60 * MIN));
  return hours >= 2 ? `up to ${hours} hours` : `up to ${Math.round(ms / MIN)} minutes`;
}

/** "just now", "5 min ago", "2 h ago", "Oct 9". */
export function ago(t, now = Date.now()) {
  const d = now - t;
  if (d < MIN) return 'just now';
  if (d < 60 * MIN) return `${Math.floor(d / MIN)} min ago`;
  if (d < 24 * 60 * MIN) return `${Math.floor(d / (60 * MIN))} h ago`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const l = new Date(t);
  return `${months[l.getMonth()]} ${l.getDate()}`;
}

/** When a move arrives, in words. */
export function arrivesText(route, direction) {
  return toEth(direction) ? `${about(ABOUT_TO_ETHEREUM_MS)}; ${upTo(slowestToEthereumMs(route))} when Ethereum is busy` : `${about(ABOUT_TO_BEAM_MS)}, then you collect it`;
}

/** The primary button: "Move 300 BEAM to Ethereum", "Move 0.5 ETH to BEAM"; "Move to Ethereum" before an amount. */
export function moveLabel(route, direction, amount) {
  const where = destinationChain(direction);
  if (amount == null || amount <= 0n) return `Move to ${where}`;
  return `Move ${coin(amount, sourceDecimals(route, direction), sourceSymbol(route, direction))} to ${where}`;
}

/** "Collect 0.5 bETH". */
export const collectLabel = (route, groth) => `Collect ${coin(groth, BEAM_DECIMALS, route.beamSymbol)}`;

/** Whether the bridge fee of `route` going `direction` follows CoinGecko's prices (all but WBEAM → BEAM). */
export const needsPrices = (route, direction) => toEth(direction) || !route.isBeam;

/**
 * The limits, said before anything is typed. To Ethereum: more than the bridge
 * fee (once known) and the per-move cap; to BEAM: what collecting costs.
 */
export function limitsText(route, direction, fee = null) {
  if (toEth(direction)) {
    const dec = sourceDecimals(route, direction);
    const sym = sourceSymbol(route, direction);
    const parts = [];
    if (fee != null) parts.push(`more than the bridge fee (now ${feeText(fee, dec)} ${sym})`);
    if (route.maxGroth != null) parts.push(`at most ${exact(route.maxGroth, BEAM_DECIMALS)} ${sym} per move`);
    if (!parts.length) return null;
    const s = parts.join(', ');
    return `${s[0].toUpperCase()}${s.slice(1)}.`;
  }
  return `Collecting it on BEAM costs ${coin(CLAIM_FEE, BEAM_DECIMALS, 'BEAM')} from your BEAM wallet.`;
}

/** Why a coin can be stopped on Ethereum while it crosses; null when it cannot. */
export function freezeNote(route) {
  switch (route.id) {
    case 'beam':
      return 'WBEAM can be paused by its issuer. If that happens while your coins are crossing, the bridge cannot pay WBEAM out until it is lifted.';
    case 'usdt':
      return "Tether can freeze the bridge's USDT. If that happens while your coins are crossing, the bridge cannot pay USDT out until it is lifted.";
    case 'wbtc':
      return 'WBTC can be paused by its issuer. If that happens while your coins are crossing, the bridge cannot pay WBTC out until it is lifted.';
    default:
      return null;
  }
}

/** An address in groups of four, so it can be read out and compared: "0x 1f3a 9c…". */
export function grouped(address) {
  return `${address.slice(0, 2)} ${address.slice(2).match(/.{1,4}/g).join(' ')}`;
}

export const PUBLIC_NOTE = "Moving is public on both chains: the amount and your Ethereum address can be seen by anyone. BEAM's privacy does not cover a move.";

/**
 * The bridge rows of the approve sheet, from what the engine reported (req)
 * and what the wallet asked for (req.intent), or null when the two do not
 * agree to the groth (the sheet then shows its plain rows; expect() in
 * beam_pipe.js has already refused anything else).
 *   to Ethereum: {kind:'send', route, amount, fee, receives, receiver, out, label}
 *   collect:     {kind:'collect', route, amount, msgId, label}
 */
export function bridgeConsent(req) {
  const i = req && req.native ? req.intent : null;
  if (!i || i.action !== 'bridge' || typeof i.route !== 'string') return null;
  let route;
  try {
    route = routeById(i.route);
  } catch {
    return null;
  }
  if (typeof i.amount !== 'bigint' || i.amount <= 0n) return null;
  if (i.direction === TO_ETHEREUM) {
    if (typeof i.fee !== 'bigint' || typeof i.receiver !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(i.receiver)) return null;
    const s = req.spends;
    if (req.kind !== 'contract' || s.length !== 1 || s[0].assetId !== route.beamAssetId || s[0].amount !== i.amount + i.fee || req.receives.length !== 0 || req.fee !== SEND_FEE) return null;
    const out = route.isBeam ? i.amount + i.fee + req.fee : i.amount + i.fee;
    return Object.freeze({
      kind: 'send',
      route,
      amount: i.amount,
      fee: i.fee,
      networkFee: req.fee,
      receives: grothToEth(route, i.amount),
      receiver: i.receiver,
      out,
      label: moveLabel(route, TO_ETHEREUM, i.amount),
    });
  }
  if (i.direction === TO_BEAM) {
    const g = req.receives;
    if (req.kind !== 'contract' || g.length !== 1 || g[0].assetId !== route.beamAssetId || g[0].amount !== i.amount || req.spends.length !== 0 || req.fee !== CLAIM_FEE) return null;
    return Object.freeze({ kind: 'collect', route, amount: i.amount, networkFee: req.fee, msgId: Number.isSafeInteger(i.msgId) ? i.msgId : null, label: collectLabel(route, i.amount) });
  }
  return null;
}
