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
//
// The words are in the person's language (lib/i18n.js); the chains' names, the coins' symbols and
// the numbers are not translated.

import { BEAM_DECIMALS, SEND_FEE, CLAIM_FEE, routeById, grothToEth, ethToGroth } from '../lib/bridge/routes.js';
import { t, tn, tk, dateLocale } from '../lib/i18n.js';

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
  const typed = String(text ?? '').trim();
  if (!typed) return { value: null, error: null };
  if (typed.includes(',')) return { value: null, error: t('Use a dot for decimals, like 0.5') };
  if (!/^[0-9]*\.?[0-9]*$/.test(typed) || typed === '.') return { value: null, error: t('Enter a number, like 0.5') };
  const dot = typed.indexOf('.');
  const whole = dot < 0 ? typed : typed.slice(0, dot);
  const frac = dot < 0 ? '' : typed.slice(dot + 1);
  const places = movableDecimals(route);
  if (frac.length > places) return { value: null, error: tn({ one: '{coin} moves with at most {n} decimal', other: '{coin} moves with at most {n} decimals' }, places, { coin: sourceSymbol(route, direction) }) };
  const dec = sourceDecimals(route, direction);
  const value = BigInt(whole || '0') * 10n ** BigInt(dec) + BigInt(frac.padEnd(dec, '0') || '0');
  const groth = toEth(direction) ? value : ethToGroth(route, value);
  if (groth >= 1n << 63n) return { value: null, error: t('That amount is too large') };
  return { value, error: null };
}

/** "About 1 hour", "About 2 minutes". */
export function about(ms) {
  const min = Math.round(ms / MIN);
  if (min >= 90) return tn({ one: 'About {n} hour', other: 'About {n} hours' }, Math.round(min / 60));
  if (min >= 55) return t('About 1 hour');
  if (min <= 1) return t('About a minute');
  return tn({ one: 'About {n} minute', other: 'About {n} minutes' }, min);
}

/** "up to 11 hours when Ethereum is busy": the slow tail of a move to Ethereum. */
export function whenBusy(ms) {
  const hours = Math.floor(ms / (60 * MIN));
  return hours >= 2
    ? tn({ one: 'up to {n} hour when Ethereum is busy', other: 'up to {n} hours when Ethereum is busy' }, hours)
    : tn({ one: 'up to {n} minute when Ethereum is busy', other: 'up to {n} minutes when Ethereum is busy' }, Math.round(ms / MIN));
}

/** "just now", "5 min ago", "2 h ago", "Oct 9" (the date in the person's language). */
export function ago(at, now = Date.now()) {
  const d = now - at;
  if (d < MIN) return t('just now');
  if (d < 60 * MIN) return tn({ one: '{n} min ago', other: '{n} min ago' }, Math.floor(d / MIN));
  if (d < 24 * 60 * MIN) return tn({ one: '{n} h ago', other: '{n} h ago' }, Math.floor(d / (60 * MIN)));
  const l = new Date(at);
  const locale = dateLocale();
  if (locale) return l.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; // i18n-ignore: English month names, read only in English (other languages: Intl above)
  return `${months[l.getMonth()]} ${l.getDate()}`;
}

/**
 * When a move arrives, in words: {time, slow}. To Ethereum, "About 1 hour" and "up to 11 hours when
 * Ethereum is busy"; to BEAM, "About 2 minutes, then you collect it" and null.
 */
export function arrivesParts(route, direction) {
  if (toEth(direction)) return { time: about(ABOUT_TO_ETHEREUM_MS), slow: whenBusy(slowestToEthereumMs(route)) };
  return { time: t('{time}, then you collect it', { time: about(ABOUT_TO_BEAM_MS) }), slow: null };
}

/** When a move arrives, in one line ("About 1 hour; up to 11 hours when Ethereum is busy"): its parts, "; " between them. */
export function arrivesText(route, direction) {
  const { time, slow } = arrivesParts(route, direction);
  return slow ? `${time}; ${slow}` : time;
}

/** The primary button: "Move 300 BEAM to Ethereum", "Move 0.5 ETH to BEAM"; "Move to Ethereum" before an amount. */
export function moveLabel(route, direction, amount) {
  if (amount == null || amount <= 0n) return toEth(direction) ? t('Move to Ethereum') : t('Move to BEAM');
  const what = coin(amount, sourceDecimals(route, direction), sourceSymbol(route, direction));
  return toEth(direction) ? t('Move {amount} to Ethereum', { amount: what }) : t('Move {amount} to BEAM', { amount: what });
}

/** "Collect 0.5 bETH". */
export const collectLabel = (route, groth) => t('Collect {amount}', { amount: coin(groth, BEAM_DECIMALS, route.beamSymbol) });

/** `s` as a sentence: as it is when it ends with a full stop, else with one ("{sentence}." in the person's language). */
export const sentence = (s) => (/[.。．]$/.test(String(s)) ? String(s) : t('{sentence}.', { sentence: String(s) }));

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
    const most = route.maxGroth != null ? exact(route.maxGroth, BEAM_DECIMALS) : null;
    if (fee != null && most != null) return t('More than the bridge fee (now {fee} {coin}), at most {max} {coin} per move.', { fee: feeText(fee, dec), max: most, coin: sym });
    if (fee != null) return t('More than the bridge fee (now {fee} {coin}).', { fee: feeText(fee, dec), coin: sym });
    if (most != null) return t('At most {max} {coin} per move.', { max: most, coin: sym });
    return null;
  }
  return t('Collecting it on BEAM costs {fee} from your BEAM wallet.', { fee: coin(CLAIM_FEE, BEAM_DECIMALS, 'BEAM') });
}

/** Why a coin can be stopped on Ethereum while it crosses; null when it cannot. */
export function freezeNote(route) {
  switch (route.id) {
    case 'beam':
      return t('WBEAM can be paused by its issuer. If that happens while your coins are crossing, the bridge cannot pay WBEAM out until it is lifted.');
    case 'usdt':
      return t("Tether can freeze the bridge's USDT. If that happens while your coins are crossing, the bridge cannot pay USDT out until it is lifted.");
    case 'wbtc':
      return t('WBTC can be paused by its issuer. If that happens while your coins are crossing, the bridge cannot pay WBTC out until it is lifted.');
    default:
      return null;
  }
}

/** An address in groups of four, so it can be read out and compared: "0x 1f3a 9c…". */
export function grouped(address) {
  return `${address.slice(0, 2)} ${address.slice(2).match(/.{1,4}/g).join(' ')}`;
}

/** Shown with t(PUBLIC_NOTE) (bridge_review.js, consent.js). */
export const PUBLIC_NOTE = tk("Moving is public on both chains: the amount and your Ethereum address can be seen by anyone. BEAM's privacy does not cover a move.");

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
