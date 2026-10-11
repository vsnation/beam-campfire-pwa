// Pieces the BEAM names screens share: a name's status in words, prices,
// what is on its way, and the screens' registry (app.js spreads NAME_SCREENS).
// A port of lib/widgets/beam/names/names_widgets.dart (NameStatusText) and
// names_format.dart.
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { STATUS, holdEndHeight, dateOf, BLOCK_SECONDS } from '../lib/bans.js';
import { day } from './names.js';

/** A name expiring within this many days asks to be renewed (kNamesRenewSoonDays). */
export const RENEW_SOON_DAYS = 30;

export const priceText = (p) => `${formatAmount(p.amount)} ${wallet.label(p.assetId).unit}`;

/** Whole days from block `from` to block `to` (a block a minute). */
export const daysBetween = (from, to) => Math.floor(((to - from) * BLOCK_SECONDS) / 86400);

export function inDays(n) {
  if (n <= 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

/**
 * One of my names in words: { text, tone: 'ok'|'soon'|'bad'|'gone', sale }.
 * clock: { tipHeight, tipTime }.
 */
export function statusWords(d, clock) {
  const tip = clock.tipHeight;
  const sale = d.salePrice ? `For sale at ${priceText(d.salePrice)}` : null;
  switch (d.status) {
    case STATUS.availableAgain:
      return { text: `Expired on ${day(dateOf(d.expireHeight, clock))} · anyone can register it now`, tone: 'gone', sale: null };
    case STATUS.onHold:
      return { text: `Expired · renew by ${day(dateOf(holdEndHeight(d.expireHeight), clock))} to keep it`, tone: 'bad', sale };
    default: {
      const left = daysBetween(tip, d.expireHeight);
      if (left <= RENEW_SOON_DAYS) return { text: `Expires ${inDays(left)}`, tone: 'soon', sale };
      return { text: `Until ${day(dateOf(d.expireHeight, clock))}`, tone: 'ok', sale };
    }
  }
}

/** Whether the owner should renew `d` now: expired (and still theirs), or within 30 days of it. */
export function needsRenewal(d, tipHeight) {
  if (d.status === STATUS.onHold) return true;
  if (d.status !== STATUS.active && d.status !== STATUS.forSale) return false;
  return daysBetween(tipHeight, d.expireHeight) <= RENEW_SOON_DAYS;
}

/** What a name has on its way, in words (app.namesPending: name -> {kind, at, ...}). */
export function pendingWords(p) {
  switch (p && p.kind) {
    case 'register':
      return 'Registering: shows here once confirmed, usually within 2 minutes';
    case 'buy':
      return 'Buying: yours once confirmed, usually within 2 minutes';
    case 'renew':
      return 'Renewing: the new date shows once confirmed';
    case 'transfer':
      return 'Transferring: it leaves this wallet once confirmed';
    case 'sell':
      return 'Listing for sale: anyone can buy it once confirmed';
    case 'unlist':
      return 'Coming off sale once confirmed';
    default:
      return null;
  }
}

/** The pending map names.js keeps (one per unlocked session). */
export function pendingOf(app) {
  if (!app.namesPending) app.namesPending = new Map();
  return app.namesPending;
}

/** Whether `p` (pending for `name`) is now visible in `list` (my names as read). */
export function pendingDone(p, name, list) {
  const d = list.find((x) => x.name === name);
  switch (p.kind) {
    case 'register':
    case 'buy':
      return Boolean(d);
    case 'renew':
      return Boolean(d) && d.expireHeight > p.expireBefore;
    case 'transfer':
      return !d;
    case 'sell':
      return Boolean(d && d.salePrice && d.salePrice.amount === p.amount && d.salePrice.assetId === p.assetId);
    case 'unlist':
      return Boolean(d && !d.salePrice);
    default:
      return true;
  }
}
