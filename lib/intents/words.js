// What the "Pay with BTC, ZEC or LTC" screens say, with no DOM, so it can be
// tested: how long a swap takes, where a swap is (in words, with its steps),
// every way 1Click can say no (in plain words, never the person's fault, each
// with the one thing that fixes it), who sees what, and how much of the ETH
// that arrived goes into WBEAM. Ports of the desktop app's
// near_intents_view.dart / near_intents_deposit_view.dart wording.

import { minimumFromMessage } from './oneclick.js';
import { exactUnits } from '../compact.js';
import { usd } from '../buy/words.js';
import { t, tn, dateLocale } from '../i18n.js';

export { usd };

/** "45 seconds", "14 minutes", "1.5 hours" (the desktop app's _duration). */
export function durationText(seconds) {
  if (seconds < 90) return tn({ one: '{n} second', other: '{n} seconds' }, seconds);
  if (seconds < 5400) return tn({ one: '{n} minute', other: '{n} minutes' }, Math.round(seconds / 60));
  const hours = (seconds / 3600).toFixed(1);
  return tn({ one: '{n} hour', other: '{n} hours' }, Number(hours), { n: hours });
}

// English's day and month ("9 Oct"; en-GB's own short month says "Sept"). Other languages: their own.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; // i18n-ignore: English only; other languages use toLocaleDateString(dateLocale())

/** "14:05 today" or "14:05 on 9 Oct" (as Buy BEAM says it). */
export function untilText(ms, now = Date.now()) {
  const d = new Date(ms);
  const n = new Date(now);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === n.toDateString()) return t('{time} today', { time });
  const loc = dateLocale();
  return t('{time} on {date}', { time, date: loc ? d.toLocaleDateString(loc, { day: 'numeric', month: 'short' }) : `${d.getDate()} ${MONTHS[d.getMonth()]}` });
}

/** "0.00012 BTC": every digit of what is sent (it must be sent exactly). */
export function sendText(swap) {
  return `${exactUnits(swap.quote.amountIn, swap.origin.decimals)} ${swap.origin.symbol}`;
}

/** Who learns what when the person uses this screen. */
export function whoSees(host) {
  return t("NEAR Intents ({host}) sees your IP address, the coin and amount, your refund address and this wallet's Ethereum address. Not your BEAM wallet, and never a key.", { host });
}

/** The fees in the quote, as the difference between what is sent and what arrives, in dollars: {usd, share} or null. */
export function feeShare(q) {
  if (q.amountInUsd == null || q.amountOutUsd == null || !(q.amountInUsd > 0)) return null;
  const d = Math.max(0, q.amountInUsd - q.amountOutUsd);
  return { usd: d, share: d / q.amountInUsd };
}

/** "about $0.11 (1.1%)" or "less than $0.01". */
export function feeText(q) {
  const f = feeShare(q);
  if (!f) return null;
  if (f.usd < 0.01) return t('less than $0.01');
  const pct = f.share * 100;
  return t('about {usd} ({percent}%)', { usd: usd(Math.round(f.usd * 100) / 100), percent: pct < 0.1 ? '< 0.1' : pct.toFixed(1) });
}

/** Nothing was paid and the time asked for has passed: the price no longer holds, the address should not be paid. */
export function isExpired(swap, now = Date.now()) {
  const unpaid = swap.lastState == null || swap.lastState === 'PENDING_DEPOSIT';
  return unpaid && swap.quote.sendBefore != null && now > swap.quote.sendBefore;
}

/** One line for an unfinished swap in a list. */
export function stateLine(swap, now = Date.now()) {
  const amount = sendText(swap);
  if (isExpired(swap, now)) return t('No {symbol} arrived in time', { symbol: swap.origin.symbol });
  switch (swap.lastState) {
    case 'KNOWN_DEPOSIT_TX':
    case 'PROCESSING':
      return t('Swapping your {amount} into ETH…', { amount });
    case 'INCOMPLETE_DEPOSIT':
      return t('Less than {amount} arrived', { amount });
    case 'SUCCESS':
      return t('Your ETH is in this wallet');
    case 'REFUNDED':
      return t('Sent back to your {chain} address', { chain: swap.origin.chainName });
    case 'FAILED':
      return t('The swap failed');
    default:
      return t('Waiting for your {amount}', { amount });
  }
}

/** Waiting for the deposit: the address is the thing on screen. */
export function isWaiting(state) {
  return state == null || state === 'PENDING_DEPOSIT' || state === 'INCOMPLETE_DEPOSIT';
}

/**
 * The status notice for a state → {kind, key, title, detail}. got: the wei
 * that arrived (SUCCESS), when 1Click said.
 */
export function statusWords(swap, { got = null, ethText = (w) => `${w} wei`, now = Date.now() } = {}) { // i18n-ignore: 'wei' is the unit's name
  const amount = sendText(swap);
  const chain = swap.origin.chainName;
  if (isExpired(swap, now)) return { kind: 'warn', key: 'expired', title: t('The time for this price has passed.'), detail: t("Don't send to this address any more: a deposit now may be sent back to your refund address. If you already sent it, this screen shows it as soon as NEAR Intents sees it.") };
  switch (swap.lastState) {
    case 'KNOWN_DEPOSIT_TX':
      return { kind: 'info', key: 'seen', title: t('Deposit seen.'), detail: t('Waiting for the {chain} network to confirm it.', { chain }) };
    case 'PROCESSING':
      return { kind: 'info', key: 'processing', title: t('Swapping into ETH…'), detail: t('The ETH arrives in this wallet when it is done.') };
    case 'SUCCESS':
      return { kind: 'success', key: 'success', title: got == null ? t('Your ETH is in this wallet.') : t('{amount} arrived in this wallet.', { amount: ethText(got) }), detail: t('Buy WBEAM with it now, or keep it as ETH.') };
    case 'INCOMPLETE_DEPOSIT':
      return { kind: 'warn', key: 'incomplete', title: t('Less than {amount} arrived.', { amount }), detail: t('Send the rest to the same address before the time below, or the deposit goes back to your refund address.') };
    case 'REFUNDED':
      // NEAR Intents' own words for why, as it said them.
      return { kind: 'warn', key: 'refunded', title: t('Sent back to your {chain} address.', { chain }), detail: swap.refundReason ? t('NEAR Intents said: "{reason}". There is nothing else to do.', { reason: swap.refundReason }) : t('The swap could not be done, so your coins went back. There is nothing else to do.') };
    case 'FAILED':
      return { kind: 'error', key: 'failed', title: t('The swap failed.'), detail: t('NEAR Intents could not complete it. Look the deposit address up on its explorer; refunds go to your refund address.') };
    default:
      return { kind: 'info', key: 'waiting', title: t('Waiting for your deposit.'), detail: t('Send it from any wallet or exchange. This screen updates by itself; you can close it and come back.') };
  }
}

/**
 * The three steps of a swap → [{label, mark}], mark 'done' | 'active' |
 * 'waiting' | 'failed'.
 */
export function swapSteps(state, { expired = false } = {}) {
  const s = state || 'PENDING_DEPOSIT';
  if (expired) return [{ label: t('No deposit arrived in time'), mark: 'failed' }, { label: t('Swapping into ETH'), mark: 'waiting' }, { label: t('ETH in this wallet'), mark: 'waiting' }];
  const paid = !['PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT'].includes(s);
  const swapping = s === 'KNOWN_DEPOSIT_TX' || s === 'PROCESSING';
  return [
    { label: s === 'INCOMPLETE_DEPOSIT' ? t('Part of your deposit arrived') : paid ? t('Deposit received') : t('Waiting for your deposit'), mark: paid ? 'done' : 'active' },
    { label: s === 'REFUNDED' ? t('Sent back to you') : s === 'FAILED' ? t('The swap failed') : t('Swapping into ETH'), mark: s === 'REFUNDED' || s === 'FAILED' ? 'failed' : s === 'SUCCESS' ? 'done' : swapping ? 'active' : 'waiting' },
    { label: t('ETH in this wallet'), mark: s === 'SUCCESS' ? 'done' : 'waiting' },
  ];
}

/**
 * The error `e` (OneClickError) as the form shows it → {kind, title, detail,
 * fix, fixLabel, minimum}. fix: 'tryAgain' | 'editAmount' | 'editRefund' |
 * 'pickCoin' | 'useMinimum' | 'update'. coin: the coin being paid with.
 */
export function problemWords(e, { coin, amountText = null } = {}) {
  const p = (kind, title, detail, fix, fixLabel, extra = {}) => ({ kind, title, detail, fix, fixLabel, minimum: null, ...extra });
  const said = (e && e.said) || '';
  switch (e && e.code) {
    case 'refused': {
      // A coin is always given by the screen; the sentences without one are its fallback.
      if (/refund.*not valid|invalid refund/i.test(said)) {
        return coin
          ? p('warn', t("That isn't a {chain} address.", { chain: coin.chainName }), t("Check your refund address: your {symbol} goes back there if the swap can't happen. Nothing was sent.", { symbol: coin.symbol }), 'editRefund', t('Check the address'))
          : p('warn', t("That isn't an address of the coin's chain."), t("Check your refund address: your coins go back there if the swap can't happen. Nothing was sent."), 'editRefund', t('Check the address'));
      }
      if (/no liquidity/i.test(said)) return p('warn', coin ? t("NEAR Intents can't swap {symbol} into ETH right now.", { symbol: coin.symbol }) : t("NEAR Intents can't swap this coin into ETH right now."), t('No one is offering this swap at the moment. Try again in a few minutes, a larger amount, or another coin. Nothing was sent.'), 'tryAgain', t('Try again'));
      const min = minimumFromMessage(said);
      if (min !== null && coin) {
        const amount = exactUnits(min, coin.decimals);
        return p('warn', t('Send at least {amount} {symbol}.', { amount, symbol: coin.symbol }), t("That's the smallest amount NEAR Intents swaps. Nothing was sent."), 'useMinimum', t('Use {amount} {symbol}', { amount, symbol: coin.symbol }), { minimum: min });
      }
      if (/failed to get quote|too (low|small)/i.test(said)) return p('warn', amountText ? t("NEAR Intents can't price {amount}.", { amount: amountText }) : t("NEAR Intents can't price this amount."), t('It may be too small to swap. Try a larger amount. Nothing was sent.'), 'editAmount', t('Change the amount'));
      // NEAR Intents' own words, as it said them.
      return p('warn', t('NEAR Intents would not price this.'), said ? t('It said: "{reason}". Check the amount and the refund address. Nothing was sent.', { reason: said }) : t('It said: "no reason given". Check the amount and the refund address. Nothing was sent.'), 'editAmount', t('Change the amount'));
    }
    case 'busy':
      return p('warn', t('NEAR Intents is busy.'), t('This is not something you did, and nothing was sent. Try again in a minute.'), 'tryAgain', t('Try again'));
    case 'cannot_verify':
      return p('error', t("This browser can't check NEAR Intents' signature."), t('Without that check no deposit address is shown. Update the browser (iOS 17 or newer) and try again. Nothing was sent.'), 'tryAgain', t('Try again'));
    case 'stale':
      return p('error', t('NEAR Intents sent an old price, so no address is shown.'), t("This is not something you did, and nothing was sent. Try again; if it keeps happening, check this device's date and time."), 'tryAgain', t('Try again'));
    case 'unsigned':
    case 'mismatch':
    case 'no_address':
    case 'unexpected':
      return p('error', t("NEAR Intents' answer didn't check out, so no address is shown."), t('This is not something you did, and nothing was sent. Try again in a moment.'), 'tryAgain', t('Try again'));
    default:
      return p('error', t("Couldn't reach NEAR Intents."), t('This is not something you did, and nothing was sent.'), 'tryAgain', t('Try again'));
  }
}

/** ETH kept for the WBEAM swap's own network fee: 0.0005 ETH (the desktop app's onBuyWbeam). */
export const KEEP_FOR_GAS = 5n * 10n ** 14n;

/** How much of the ETH that arrived to spend on WBEAM: all but the gas reserve, or half when it is small. */
export function wbeamSpend(arrived) {
  if (typeof arrived !== 'bigint' || arrived <= 0n) return 0n;
  return arrived > KEEP_FOR_GAS * 2n ? arrived - KEEP_FOR_GAS : arrived / 2n;
}
