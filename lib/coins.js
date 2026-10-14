// Coins: what a balance is made of, and Split coins. A port of BEAM Campfire's
// lib/wallets/beam/utxo/beam_coins.dart and beam_coin_split.dart, with the wording of
// lib/widgets/beam/split/beam_split_text.dart and beam_coin_list.dart. Pure, except the
// wallet calls at the end, which take the engine session.
//
// A BEAM balance sits in coins (the engine's get_utxo). A payment ties up at least one coin
// until its change comes back (about a minute), so a wallet with one big coin can make one
// payment at a time. tx_split turns coins into several equal ones in the same wallet: only
// the network fee leaves it. "Coins" is BEAM's own word; the technical one never shows.
//
// Private (max-privacy) coins: a coin received at a max-privacy address is a shielded coin
// (type "shld") that BEAM keeps "maturing" until enough later private payments hide it (the
// sender asks for 64/64 of the anonymity window), or until the wallet's time limit has
// passed since it arrived: IWalletDB::get_MaxPrivacyLockTimeLimitHours, 72 by default
// (wallet_db.cpp DeduceStatus: confirmHeight + hours * 60 blocks). With today's private
// traffic the time limit is what frees it. get_utxo gives such a coin's arrival height as
// its "maturity" (ShieldedCoin::get_Maturity = confirm height + offset).

import { formatAmount, toJsonNumber } from './amount.js';
import { t, tn, tk } from './i18n.js';

// ---------------------------------------------------------------- fees

/**
 * Fee rules after HF3 (core/block_crypt.cpp): 18,000 groth per output, 10,000 per kernel,
 * at least 100,000. tx_split refuses less than kernel + output x (coins + 1 [+ 1 for an
 * asset]) (wallet/api/v6_0/v6_api_parse.cpp onParseSplit): the new coins, BEAM change, and
 * asset change when splitting an asset.
 */
export const FEES = Object.freeze({ perOutput: 18000n, perKernel: 10000n, minimum: 100000n });

export function splitFee(count, { asset = false } = {}) {
  const outputs = BigInt(count + 1 + (asset ? 1 : 0));
  const fee = FEES.perKernel + FEES.perOutput * outputs;
  return fee > FEES.minimum ? fee : FEES.minimum;
}

// ---------------------------------------------------------------- one coin

/** get_utxo's status_string values. Regular and private coins number them differently, so the number is never used. */
export const COIN_STATUSES = Object.freeze(['unavailable', 'available', 'maturing', 'outgoing', 'incoming', 'spent', 'consumed']);

/** A height the engine really gave: MaxHeight (not yet known) and 0 are none. */
const height = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

/**
 * A get_utxo entry: {id, asset_id, amount, type, maturity, createTxId, spentTxId, status, status_string}.
 * exact is false for an amount beyond what a JSON number holds exactly (only a huge asset
 * coin can be): it is shown, never counted in a split.
 */
export function parseCoin(j) {
  const raw = j && j.amount;
  let amount = 0n;
  let exact = true;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    amount = BigInt(Math.trunc(raw));
    exact = Number.isSafeInteger(raw);
  } else if (typeof raw === 'string' && /^\d+$/.test(raw)) amount = BigInt(raw);
  else exact = false;
  const type = String((j && j.type) || '');
  const s = String((j && j.status_string) || '');
  return {
    id: String(j && j.id != null ? j.id : ''),
    assetId: Number(j && j.asset_id) || 0,
    amount,
    exact,
    type,
    status: COIN_STATUSES.includes(s) ? s : 'unknown',
    maturity: height(j && j.maturity),
    createTxId: (j && j.createTxId) || null,
    spentTxId: (j && j.spentTxId) || null,
    shielded: type === 'shld',
  };
}

/** What kind of coin it is, in a word, or '' for an ordinary one. */
export function coinKind(c) {
  if (c.shielded) return t('Private');
  if (c.type === 'chng') return t('Change coin'); // not the Edit button's "Change": two words in other languages
  if (c.type === 'mine' || c.type === 'fees' || c.type === 'Tres') return t('Mined');
  return '';
}

// ---------------------------------------------------------------- one asset's coins

const byAmountDesc = (a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1);
const sum = (list) => list.reduce((s, c) => s + c.amount, 0n);

/**
 * Groups coins per asset (Map assetId -> summary). Spent and consumed coins are left out.
 * available: spendable now, largest first. locked: maturing, arriving, in a payment, or
 * unavailable.
 */
export function coinSummary(coins) {
  const out = new Map();
  for (const c of coins || []) {
    if (c.status === 'spent' || c.status === 'consumed' || c.status === 'unknown') continue;
    if (!out.has(c.assetId)) out.set(c.assetId, { available: [], locked: [] });
    (c.status === 'available' ? out.get(c.assetId).available : out.get(c.assetId).locked).push(c);
  }
  return new Map([...out].map(([id, g]) => [id, summarize(id, g.available.sort(byAmountDesc), g.locked)]));
}

export const emptySummary = (assetId) => summarize(assetId, [], []);

function summarize(assetId, available, locked) {
  const counted = available.filter((c) => c.exact);
  // Spendable coins worth more than a send's fee, largest first; smaller ones cost more to spend than they hold.
  const usable = counted.filter((c) => c.amount > FEES.minimum);
  const usableTotal = sum(usable);
  return Object.freeze({
    assetId,
    available,
    locked,
    availableTotal: sum(counted),
    lockedTotal: sum(locked),
    usable,
    usableTotal,
    /** The largest usable coin's share of the usable total, 0 to 1. */
    largestShare: usable.length ? Number((usable[0].amount * 1000000n) / usableTotal) / 1000000 : 0,
    shieldedCount: available.filter((c) => c.shielded).length,
    /** Private coins BEAM still holds back (max privacy). */
    privateMaturing: locked.filter((c) => c.shielded && c.status === 'maturing'),
  });
}

// ---------------------------------------------------------------- the split

export const MAX_COINS = 50;
/** The counts the screen offers (BEAM Light Wallet's presets). */
export const PRESETS = Object.freeze([2, 3, 5, 8, 10]);

/** [units] rounded down to two significant digits (17,999,910 -> 17,000,000). */
export function roundDown(units) {
  if (units < 100n) return units;
  const step = 10n ** BigInt(units.toString().length - 2);
  return (units / step) * step;
}

/**
 * count coins of exactly size from available; null when the engine would refuse it or a
 * person would not want it: fewer than 2 or more than MAX_COINS coins, a BEAM coin worth no
 * more than a send's fee, or more than there is (with the fee, for BEAM).
 */
export function planSized({ available, count, size, assetId = 0 }) {
  if (!Number.isInteger(count) || count < 2 || count > MAX_COINS) return null;
  if (size <= 0n) return null;
  const asset = Number(assetId) !== 0;
  if (!asset && size <= FEES.minimum) return null;
  const fee = splitFee(count, { asset });
  const total = size * BigInt(count);
  if (total + (asset ? 0n : fee) > available) return null;
  return Object.freeze({
    assetId: Number(assetId),
    size,
    count,
    fee,
    available,
    total,
    coins: Object.freeze(Array(count).fill(size)),
    /** What stays as one change coin: the rest, less the fee when it is paid from the same asset (BEAM). */
    change: available - total - (asset ? 0n : fee),
  });
}

/**
 * Splits most of available into count equal coins, keeping the fee back (BEAM) and leaving
 * the rest as change: 90% of what is left after the fee, each coin rounded down to two
 * significant digits ("5 coins of 0.17 BEAM"), or unrounded when rounding would make a coin
 * too small. Null when no such split is worth it.
 */
export function planEqual({ available, count, assetId = 0 }) {
  if (!Number.isInteger(count) || count < 2 || count > MAX_COINS) return null;
  const asset = Number(assetId) !== 0;
  const budget = asset ? available : available - splitFee(count);
  if (budget <= 0n) return null;
  const raw = (budget * 9n) / 10n / BigInt(count);
  return planSized({ available, count, size: roundDown(raw), assetId }) || planSized({ available, count, size: raw, assetId });
}

/** PRESETS plus the advised count when it is not one of them, in order. */
export function countChoices(suggested) {
  const set = new Set(PRESETS);
  if (suggested >= 2 && suggested <= MAX_COINS) set.add(suggested);
  return [...set].sort((a, b) => a - b);
}

/** One new coin per 10 whole units, at least 3 and at most 10. */
export function countBySize(total) {
  const ten = 10n * 100000000n;
  const n = Number((total + ten - 1n) / ten);
  return Math.min(10, Math.max(3, n));
}

/**
 * Whether splitting would help, and into how many coins: BEAM Light Wallet's thresholds, with
 * coins that cannot pay a fee left out. urgency: 'needed' (everything usable is one coin: a
 * payment locks the whole balance), 'worthIt', or 'none'.
 */
export function splitAdvice(s) {
  const none = { urgency: 'none', suggestedCount: 0 };
  if (!s || !s.usable.length) return none;
  let urgency;
  let count;
  if (s.usable.length === 1) {
    urgency = 'needed';
    count = countBySize(s.usableTotal);
  } else if (s.usable.length === 2 && s.largestShare > 0.8) {
    urgency = 'worthIt';
    count = 4;
  } else if (s.largestShare > 0.9) {
    urgency = 'worthIt';
    count = 3;
  } else return none;
  for (let n = count; n >= 2; n--) if (planEqual({ available: s.availableTotal, count: n, assetId: s.assetId })) return { urgency, suggestedCount: n };
  return none;
}

/** The counts offered for these coins that make a real split. */
export function countsFor(s) {
  return countChoices(splitAdvice(s).suggestedCount).filter((n) => planEqual({ available: s.availableTotal, count: n, assetId: s.assetId }));
}

/** The count to show selected: the picked one, else the advice's, else 3, else the first that works. */
export function chosenCount(s, picked = null) {
  const counts = countsFor(s);
  if (!counts.length) return null;
  if (picked != null && counts.includes(picked)) return picked;
  const advised = splitAdvice(s).suggestedCount;
  if (counts.includes(advised)) return advised;
  return counts.includes(3) ? 3 : counts[0];
}

// ---------------------------------------------------------------- a split in the history

/**
 * A tx_split (Split coins): the engine keeps it as a simple transaction it sends to no one,
 * with no address on either side, while every payment has the receiver's (BeamTransaction.isSplit).
 */
export function isSplitTx(tx) {
  return Boolean(tx) && Number(tx.tx_type) === 0 && !tx.income && !tx.sender && !tx.receiver;
}

/** BEAM Campfire's words for a split's state ("Split into coins" once done). */
export function splitStatusText(tx) {
  switch (Number(tx.status)) {
    case 2:
      return t('Split cancelled');
    case 3:
      return t('Split into coins');
    case 4:
      return t('Split failed');
    default:
      return t('Splitting coins');
  }
}

// ---------------------------------------------------------------- private coins

/** BEAM's default for how long a max-privacy coin may be held back (IWalletDB, 72 hours). */
export const PRIVATE_LIMIT_HOURS = 72;
const BLOCKS_PER_HOUR = 60;

/**
 * When a private coin BEAM is holding back becomes spendable, at the latest: the block, and
 * hours from now at about one block a minute. known: false when the coin's arrival height or
 * the wallet's height is not known yet.
 */
export function privateReady(coin, currentHeight, limitHours = PRIVATE_LIMIT_HOURS) {
  const at = coin && coin.maturity ? coin.maturity + limitHours * BLOCKS_PER_HOUR : null;
  if (!at || !height(currentHeight)) return { known: false, block: at, hours: null };
  const left = at - currentHeight;
  return { known: true, block: at, hours: left <= 0 ? 0 : Math.ceil(left / BLOCKS_PER_HOUR) };
}

/** Which of privateWhen's four answers applies: 'limit', 'now', 'hour' or 'hours'. */
function whenCase(ready) {
  if (!ready || !ready.known) return 'limit';
  if (ready.hours === 0) return 'now';
  if (ready.hours <= 1) return 'hour';
  return 'hours';
}

/**
 * "in about 61 hours" / "within the hour" / "within 72 hours of arriving". The sentences that say
 * it (coinStatusText, privateBalanceText) have a whole sentence for each answer: word order differs
 * between languages.
 */
export function privateWhen(ready) {
  switch (whenCase(ready)) {
    case 'limit':
      return tn({ one: 'within {n} hour of arriving', other: 'within {n} hours of arriving' }, PRIVATE_LIMIT_HOURS);
    case 'now':
      return t('once enough other private payments follow it');
    case 'hour':
      return t('within the hour');
    default:
      // More than one hour here: English always says "hours".
      return tn({ one: 'in about {n} hour', other: 'in about {n} hours' }, ready.hours);
  }
}

/** The soonest of these private coins: what to say about a private balance on its way. */
export function soonestPrivate(coins, currentHeight) {
  let best = null;
  for (const c of coins || []) {
    const r = privateReady(c, currentHeight);
    if (!best || (r.known && (!best.known || r.hours < best.hours))) best = r;
  }
  return best;
}

// ---------------------------------------------------------------- words

const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const withSymbol = (groth, symbol) => `${formatAmount(groth)} ${symbol}`;

/**
 * Every sentence the Split coins screens say (BeamSplitText), so each can be tested. The plain
 * texts are marked with tk() and shown with t(SPLIT_TEXT.title); the functions answer in the
 * active language. Every count here is 2 or more (planSized, splitAdvice): English always says
 * "coins"; tn() for the languages that count otherwise.
 */
export const SPLIT_TEXT = Object.freeze({
  title: tk('Split coins'),
  reviewTitle: tk('Review split'),
  headline: tk('Send several payments at once'),
  intro: tk('Each payment ties up a coin for about a minute. With more coins, several can go at once. Nothing leaves your wallet.'),
  /** "1.2345 BEAM in 1 coin: one payment at a time". */
  now(s, symbol) {
    const n = s.available.length;
    if (!n) return t('Nothing to split yet');
    const total = withSymbol(s.availableTotal, symbol);
    if (n === 1) return t('{total} in 1 coin: one payment at a time', { total });
    return tn({ one: '{total} in {n} coin; the largest holds {percent}%', other: '{total} in {n} coins; the largest holds {percent}%' }, n, { total, percent: Math.round(s.largestShare * 100) });
  },
  spreadWell: (coins) => tn({ one: 'Your coins are already spread out: up to {n} payment can go at once. You can still split for more.', other: 'Your coins are already spread out: up to {n} payments can go at once. You can still split for more.' }, coins),
  countLabel: tk('Split into'),
  newCoins: (plan, symbol) => tn({ one: '{n} coin of {amount}', other: '{n} coins of {amount}' }, plan.count, { amount: withSymbol(plan.size, symbol) }),
  cta: (count) => tn({ one: 'Split into {n} coin', other: 'Split into {n} coins' }, count),
  fee: (plan) => withSymbol(plan.fee, 'BEAM'),
  reviewNote: (symbol, asset) =>
    asset ? t('Your {symbol} is split into new coins in this same wallet. You pay only the network fee, in BEAM.', { symbol }) : t('Your {symbol} is split into new coins in this same wallet. You pay only the network fee.', { symbol }),
  noCoins: (symbol) => t('This wallet has no {symbol} it can spend right now. Coins that arrive or come back from a payment show up here.', { symbol }),
  tooLittle: tk('There is too little here to split: each new coin has to be worth more than the 0.001 BEAM a payment costs.'),
  needBeam: (fee, beam) => t('Splitting costs a {fee} network fee, paid in BEAM, and this wallet has {beam} available. Add BEAM first.', { fee: withSymbol(fee, 'BEAM'), beam: withSymbol(beam, 'BEAM') }),
  authReason: (plan, symbol) => tn({ one: 'Split {amount} into {n} coin', other: 'Split {amount} into {n} coins' }, plan.count, { amount: withSymbol(plan.total, symbol) }),
  doneTitle: (count) => tn({ one: 'Splitting into {n} coin', other: 'Splitting into {n} coins' }, count),
  doneMessage: tk('The new coins are ready in about a minute, once the network confirms the split. Until then the coins being split are busy. Your history shows it as "Splitting coins".'),
  poolShare: tk('Pool shares are not split: they go back to their pool as a whole.'),
  changed: tk('Your coins changed since this split was prepared. Go back and review it again.'),
  outcomeUnknown: tk("The connection dropped while splitting, so it's not certain whether the split started. Check Activity before trying again."),
  alreadyHandedOff: tk('This split was already handed to the wallet. Check Activity before trying again.'),
});

/** What the coin list says (BeamCoinListText), with private coins said plainly. Plain texts: tk(), shown with t(). */
export const COIN_TEXT = Object.freeze({
  title: (symbol) => t('Your {symbol} coins', { symbol }),
  /** "3 ready to spend · 1 not yet". */
  summary(s) {
    const ready = s.available.length;
    const waiting = s.locked.length;
    return waiting ? t('{ready} ready to spend · {waiting} not yet', { ready, waiting }) : t('{ready} ready to spend', { ready });
  },
  note: tk('Each payment uses one or more coins and gives the rest back as a new coin. More coins let several payments go at once.'),
  empty: tk('No coins yet. Coins that arrive show up here.'),
  privateNote: () =>
    tn(
      {
        one: 'A private coin is one paid to a max-privacy address. BEAM holds it until enough other private payments hide it, {n} hour after it arrived at the latest; then it is spendable like any other.',
        other: 'A private coin is one paid to a max-privacy address. BEAM holds it until enough other private payments hide it, {n} hours after it arrived at the latest; then it is spendable like any other.',
      },
      PRIVATE_LIMIT_HOURS,
    ),
});

/** One coin's state, in words. BEAM coins worth no more than a payment's fee are too small to be worth spending. */
export function coinStatusText(c, currentHeight = null) {
  switch (c.status) {
    case 'available':
      if (c.shielded) return t('Ready to spend · private');
      if (c.assetId === 0 && c.amount <= FEES.minimum) return t('Too small to be worth spending');
      return t('Ready to spend');
    case 'maturing': {
      // Its tag already says private (screens/coins_ui.js): the line says when.
      if (c.shielded) {
        const ready = privateReady(c, currentHeight);
        switch (whenCase(ready)) {
          case 'limit':
            return tn({ one: 'Spendable within {n} hour of arriving', other: 'Spendable within {n} hours of arriving' }, PRIVATE_LIMIT_HOURS);
          case 'now':
            return t('Spendable once enough other private payments follow it');
          case 'hour':
            return t('Spendable within the hour');
          default:
            return tn({ one: 'Spendable in about {n} hour', other: 'Spendable in about {n} hours' }, ready.hours);
        }
      }
      return c.maturity ? t('Ready soon (after block {height})', { height: grouped(c.maturity) }) : t('Ready soon');
    }
    case 'incoming':
      return t('Arriving');
    case 'outgoing':
      return t("In a payment that hasn't finished");
    default:
      return t('Not spendable right now');
  }
}

/**
 * The line under a balance when part of it is private coins BEAM still holds back: "0.01 BEAM
 * arrived privately: spendable in about 61 hours". With several coins, when the last of them is.
 */
export function privateBalanceText(amount, unit, coins, currentHeight) {
  let latest = null;
  for (const c of coins || []) {
    const r = privateReady(c, currentHeight);
    if (!latest || (r.known && (!latest.known || r.hours > latest.hours))) latest = r;
  }
  const what = `${formatAmount(amount)} ${unit}`;
  if ((coins || []).length > 1 && latest && latest.known && latest.hours > 1) return tn({ one: '{amount} arrived privately: all of it spendable within about {n} hour', other: '{amount} arrived privately: all of it spendable within about {n} hours' }, latest.hours, { amount: what });
  switch (whenCase(latest)) {
    case 'limit':
      return tn({ one: '{amount} arrived privately: spendable within {n} hour of arriving', other: '{amount} arrived privately: spendable within {n} hours of arriving' }, PRIVATE_LIMIT_HOURS, { amount: what });
    case 'now':
      return t('{amount} arrived privately: spendable once enough other private payments follow it', { amount: what });
    case 'hour':
      return t('{amount} arrived privately: spendable within the hour', { amount: what });
    default:
      return tn({ one: '{amount} arrived privately: spendable in about {n} hour', other: '{amount} arrived privately: spendable in about {n} hours' }, latest.hours, { amount: what });
  }
}

// ---------------------------------------------------------------- the wallet

export class SplitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Reads every get_utxo page through page(skip, count) (the engine returns spent coins too, so a
 * long-lived wallet can have thousands), without counting a coin twice if the list moves.
 */
export async function readAllCoins(page, { pageSize = 500, maxPages = 200 } = {}) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < maxPages; i++) {
    const batch = await page(i * pageSize, pageSize);
    for (const c of batch) {
      const key = `${c.type}:${c.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c);
      }
    }
    if (batch.length < pageSize) break;
  }
  return out;
}

/** Every coin the wallet holds, per asset (coinSummary). */
export async function loadCoins(session) {
  const all = await readAllCoins(async (skip, count) => {
    const r = await session.call('get_utxo', { skip, count }, { timeoutMs: 30000 });
    return (Array.isArray(r) ? r : []).map(parseCoin);
  });
  return coinSummary(all);
}

async function lookUp(session, txId, message = SPLIT_TEXT.outcomeUnknown) {
  try {
    const r = await session.call('tx_status', { txId }, { timeoutMs: 20000 });
    return (r && r.txId) || txId;
  } catch {
    throw new SplitError('unknown', t(message));
  }
}

/**
 * Splits with one tx_split and returns its tx id. The id is made first (generate_tx_id) and
 * kept in hand.txId, so a dropped connection is looked up (tx_status) instead of risking a
 * second split, and a split already handed over is only ever looked up again. A plain
 * refusal by the engine clears it: nothing started, so it may be tried again.
 */
export async function splitCoins(session, plan, hand = {}) {
  if (hand.txId) return lookUp(session, hand.txId, SPLIT_TEXT.alreadyHandedOff);
  const txId = await session.call('generate_tx_id', {}, { timeoutMs: 15000 });
  if (typeof txId !== 'string' || !/^[0-9a-f]{32}$/i.test(txId)) throw new SplitError('rejected', t('The wallet gave no transaction id. Nothing was split.'));
  hand.txId = txId;
  const params = { coins: plan.coins.map((c) => toJsonNumber(c)), fee: toJsonNumber(plan.fee), txId };
  if (plan.assetId) params.asset_id = plan.assetId;
  try {
    const r = await session.call('tx_split', params, { timeoutMs: 60000 });
    return (r && r.txId) || txId;
  } catch (e) {
    const rpc = e && e.rpc;
    const said = String((rpc && rpc.message) || (e && e.message) || '');
    if (rpc && /already exists/i.test(said)) return lookUp(session, txId);
    if (rpc) {
      hand.txId = null;
      throw new SplitError(/funds|missing|not enough/i.test(said) ? 'funds' : 'rejected', t('The coins were not split: {reason} Nothing left your wallet.', { reason: said.replace(/\.?$/, '.') }));
    }
    // No answer (timeout, a lost engine): it may have started. Look it up.
    return lookUp(session, txId);
  }
}
