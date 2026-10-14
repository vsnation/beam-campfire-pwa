// What BEAM Campfire tells the person about, and what it says. Pure: the effects (banner, system
// notification, badge, reminders stored for the service worker) are lib/notify.js.
//
// Everything is decided on this device from the wallet's own data. No server watches the wallet:
// none could, a BEAM server cannot read whose payment is whose, and the app must keep working
// when every server of ours is gone. So:
//   - while the app runs (on screen, or in the background for as long as the system lets it),
//     each change in the wallet's own payment list is checked here;
//   - when the person leaves the app, what is still under way is said at once (a regular BEAM
//     payment finishes only while both wallets are online), and reminders for later are worked
//     out here and left on the device for the service worker (lib/notify.js, sw.js);
//   - when they come back, what happened meanwhile is summed up from the same list.
//
// Kinds (one switch each in Settings → Notifications):
//   in        money in: a payment received; a private payment now spendable; money waiting for a name
//   out       money out: a payment sent; a payment that failed
//   underway  a payment still under way when the person leaves the app, and its reminder
//   contracts swaps, pools, tokens, names, airdrop codes: done or failed; a name about to expire
//   moves     the bridge, and swaps from other coins: when they finish or need the person

import { formatAmount } from './amount.js';
import { isNews } from './payment_notice.js';
import { t, tn, tk } from './i18n.js';

export const KINDS = Object.freeze(['in', 'out', 'underway', 'contracts', 'moves']);
export const KIND_WORDS = Object.freeze({
  in: { title: tk('Money in'), sub: tk('Payments received, private payments ready to spend, money paid to your names, an address about to expire') },
  out: { title: tk('Money out'), sub: tk('Payments sent, and any that failed') },
  underway: { title: tk('Payments under way'), sub: tk('When you leave the app while a payment still needs it') },
  contracts: { title: tk('Swaps, pools, tokens and names'), sub: tk('Done or failed; a name about to expire') },
  moves: { title: tk('Bridge, and paying with other coins'), sub: tk('A move ready to collect or done; a deposit address about to stop taking coins') },
});

/** Defaults: everything on once notifications are on. */
export const DEFAULT_KINDS = Object.freeze(Object.fromEntries(KINDS.map((k) => [k, true])));

const UNDERWAY = new Set([0, 1, 5]); // pending, in progress, registering
const PAYMENT = new Set([0, 7]); // a plain payment, an offline / max-privacy one
const CONTRACT = 12;

/**
 * The person's settings, with defaults; prefs.notify = { on, kinds, amounts }. amounts: whether a
 * system notification (the lock screen, read by whoever holds the phone) says how much; off unless
 * the person turns it on. Inside the open app amounts are always shown.
 */
export function settingsOf(prefs) {
  const n = (prefs && prefs.notify) || {};
  const on = n.on === true || (n.on === undefined && Boolean(prefs) && prefs.paymentNotifications === true);
  return { on, kinds: { ...DEFAULT_KINDS, ...(n.kinds || {}) }, amounts: n.amounts === true };
}

const amountOf = (tx, label) => {
  const id = Number(tx.asset_id) || 0;
  const v = formatAmount(BigInt(tx.value || 0));
  if (id === 0) return `${v} BEAM`;
  return label && label.verified && !label.pool ? `${v} ${label.symbol}` : t('{amount} of token #{id}', { amount: v, id });
};

/**
 * Watches the payment list. update(txs, loaded, live) returns the changes worth telling: the
 * first read only records (it is history), and so does any read while live is false (a wallet
 * catching up finds old payments: lib/payment_notice.js catchUp). Each payment's change once.
 * Events: { kind, type, tx } with type 'received' | 'sent' | 'failed' | 'contractDone' | 'contractFailed'.
 */
export function txWatcher() {
  let status = null; // txId -> last status seen
  return {
    reset() {
      status = null;
    },
    get started() {
      return status !== null;
    },
    update(txs, loaded = true, live = true) {
      if (!loaded) return [];
      const list = txs || [];
      const first = status === null;
      if (first) status = new Map();
      const out = [];
      for (const tx of list) {
        const s = Number(tx.status);
        const before = status.get(tx.txId);
        status.set(tx.txId, s);
        if (first || !live || before === s) continue;
        const type = Number(tx.tx_type);
        const known = before !== undefined;
        if (type === CONTRACT) {
          if (!known || !UNDERWAY.has(before)) continue; // only what this run saw under way
          if (s === 3) out.push({ kind: 'contracts', type: 'contractDone', tx });
          else if (s === 4) out.push({ kind: 'contracts', type: 'contractFailed', tx });
          continue;
        }
        if (!PAYMENT.has(type)) continue;
        if (tx.income === true) {
          if (s === 3 && isNews(tx)) out.push({ kind: 'in', type: 'received', tx });
          else if (s === 4 && known) out.push({ kind: 'out', type: 'failed', tx });
        } else if (known && UNDERWAY.has(before)) {
          if (s === 3) out.push({ kind: 'out', type: 'sent', tx });
          else if (s === 4) out.push({ kind: 'out', type: 'failed', tx });
        }
      }
      return out;
    },
  };
}

/** Payments still under way: incoming ones arrive only while this wallet is online, outgoing ones finish only while it is. */
export function underway(txs) {
  return (txs || []).filter((tx) => PAYMENT.has(Number(tx.tx_type)) && UNDERWAY.has(Number(tx.status)) && Number(tx.tx_type) === 0);
}

/** A contract call's title; a dApp's own name (its app name) is quoted as the app's: "A call by “X”". */
function callTitle(tx, contractTitle) {
  const title = contractTitle(tx);
  return typeof tx.appname === 'string' && tx.appname !== '' && title === tx.appname ? t('A call by “{app}”', { app: title }) : title;
}

/**
 * What a notification says. ev: { type, tx } or a free one { type: 'free', title, body }.
 * label(assetId) names an asset; contractTitle(tx) names a contract call (lib/wallet.js
 * contractLabel); amounts false: no amounts in the text (a lock screen shows it).
 * Returns { title, body, tag, url }: url is where a tap opens (a hash the app reads).
 */
export function wordsFor(ev, { label = () => null, contractTitle = () => t('Contract call'), amounts = true, walletName = null } = {}) {
  // Which wallet it is about, after the body's own sentences (when there are several wallets).
  const where = (text) => (walletName ? t('{text} In {wallet}.', { text, wallet: walletName }) : text);
  const tx = ev.tx;
  const open = tx ? `#open=activity&tx=${encodeURIComponent(tx.txId)}` : '#open=home';
  const amt = tx && amounts ? amountOf(tx, label(Number(tx.asset_id) || 0)) : null;
  switch (ev.type) {
    case 'received':
      return { title: amt ? t('Received {amount}', { amount: amt }) : t('Payment received'), body: where(t('Tap to see it in Activity.')), tag: `in-${tx.txId}`, url: open };
    case 'sent':
      return { title: amt ? t('Sent {amount}', { amount: amt }) : t('Payment sent'), body: where(t('It is complete.')), tag: `out-${tx.txId}`, url: open };
    case 'failed':
      if (tx.income === true) return { title: amt ? t('A payment of {amount} to you did not go through', { amount: amt }) : t('A payment to you did not go through'), body: where(t('Nothing arrived. The sender can send it again.')), tag: `fail-${tx.txId}`, url: open };
      return { title: amt ? t('Your payment of {amount} did not go through', { amount: amt }) : t('Your payment did not go through'), body: where(t('Nothing left your wallet for it. Tap to see why.')), tag: `fail-${tx.txId}`, url: open };
    case 'contractDone':
      return { title: t('{call}: done', { call: callTitle(tx, contractTitle) }), body: where(t('Tap to see it in Activity.')), tag: `c-${tx.txId}`, url: open };
    case 'contractFailed':
      return { title: t('{call}: did not go through', { call: callTitle(tx, contractTitle) }), body: where(t('Tap to see why.')), tag: `cf-${tx.txId}`, url: open };
    case 'arriving':
      return { title: t('A payment to you is arriving'), body: where(t('It finishes only while BEAM Campfire is open: come back so it can.')), tag: `arr-${tx.txId}`, url: open };
    case 'leaving':
      return { title: t('Your payment is still on its way'), body: where(t('It finishes only while BEAM Campfire is open: come back so it can.')), tag: `arr-${tx.txId}`, url: open };
    case 'several':
      return { title: ev.title, body: where(t('Tap to see them in Activity.')), tag: `sev-${ev.count}-${Date.now()}`, url: '#open=activity' };
    default: {
      // plainBody: the same without amounts, for when the person turned amounts off.
      const body = !amounts && ev.plainBody != null ? ev.plainBody : ev.body || '';
      return { title: ev.title, body: where(body).trim(), tag: ev.tag || `free-${Date.now()}`, url: ev.url || '#open=home' };
    }
  }
}

/** When the person leaves the app: what to say at once (the payments that need the app). */
export function leavingEvents(txs) {
  return underway(txs).map((tx) => ({ kind: 'underway', type: tx.income === true ? 'arriving' : 'leaving', tx }));
}

export const REMIND_AFTER_MS = 20 * 60 * 1000;
export const DAY_MS = 24 * 3600 * 1000;

/**
 * Reminders for later, worked out when the person leaves; the service worker shows each when it
 * is due (if the browser wakes it: Periodic Background Sync, Chromium) and the page shows them
 * while it still runs. Each: { id, kind, at, title, body, url }.
 *   - payments still under way: 20 minutes later (one reminder for all of them);
 *   - a private payment: when it can be spent (spendableAt per coin, from lib/coins.js);
 *   - a name: 7 days and 1 day before it expires;
 *   - a NEAR swap: 30 minutes before its deposit address stops taking coins;
 *   - an address of this wallet that expires: 3 days before (payments to it stop arriving then), at
 *     most ADDRESS_REMINDERS of the nearest, one reminder for those due within a day of each other.
 * They are stored in the clear (the service worker reads them while the wallet is locked), so they
 * say only when, in words that name nothing (audit A-4): no amount, name, label, address, coin,
 * payment id, deposit address, wallet id or wallet name, in the text, the id or the link. Each id is
 * its kind and its time; the tap opens the screen of that kind, which shows the rest once unlocked.
 */
export const ADDRESS_REMINDERS = 5;
export const ADDRESS_NOTICE_DAYS = 3;
export const NEAR_NOTICE_MS = 30 * 60 * 1000;
const KIND_OF = Object.freeze({ arr: 'underway', priv: 'in', name: 'contracts', addr: 'in', near: 'moves' });
const URL_OF = Object.freeze({ arr: '#open=activity', priv: '#open=coins', name: '#open=names', addr: '#open=addresses', near: '#open=nearIntents' });

/** The words of one reminder, from its type and what it may say (a count, how many days). */
export function reminderWords(type, { count = 1, days = 7 } = {}) {
  switch (type) {
    case 'arr':
      return { title: count === 1 ? t('A payment is still waiting') : t('Payments are still waiting'), body: t('It finishes only while BEAM Campfire is open. Open it to finish.') };
    case 'priv':
      return { title: t('A payment can now be spent'), body: t('Open BEAM Campfire to use it.') };
    case 'name':
      return { title: tn({ one: 'A BEAM name of yours expires in {n} day', other: 'A BEAM name of yours expires in {n} days' }, days), body: t('Renew it in BEAM names so it stays yours.') };
    case 'addr':
      return {
        title:
          count === 1
            ? t('An address of yours expires in {days} days', { days: ADDRESS_NOTICE_DAYS })
            : tn({ one: '{n} of your addresses expire in {days} days', other: '{n} of your addresses expire in {days} days' }, count, { days: ADDRESS_NOTICE_DAYS }),
        body: count === 1 ? t("Payments sent to it after that won't arrive. Extend it in Your addresses.") : t("Payments sent to them after that won't arrive. Extend them in Your addresses."),
      };
    case 'near':
      return { title: t('A deposit address closes soon'), body: t('Send the coins for your swap in the next 30 minutes: then its deposit address stops taking them.') };
    default:
      return null;
  }
}

function reminder(type, at, opts) {
  return { id: `rem-${type}-${at}`, kind: KIND_OF[type], at, ...reminderWords(type, opts), url: URL_OF[type] };
}

export function remindersFor({ txs = [], privateCoins = [], names = [], nearSwaps = [], addresses = [], now = Date.now() } = {}) {
  const out = [];
  const ids = new Set();
  // Two at the same moment are one reminder (their id is their time).
  const add = (r) => {
    if (ids.has(r.id)) return;
    ids.add(r.id);
    out.push(r);
  };
  const waiting = underway(txs);
  if (waiting.length) add(reminder('arr', now + REMIND_AFTER_MS, { count: waiting.length }));
  for (const c of privateCoins) {
    if (c.spendableAt > now) add(reminder('priv', c.spendableAt));
  }
  for (const n of names) {
    if (!(n.expiresAt > now)) continue;
    for (const days of [7, 1]) {
      const at = n.expiresAt - days * DAY_MS;
      if (at > now) add(reminder('name', at, { days }));
    }
  }
  const soon = addresses
    .filter((a) => a && !a.expired && a.expiresAt > now)
    .map((a) => ({ ...a, at: a.expiresAt - ADDRESS_NOTICE_DAYS * DAY_MS }))
    .filter((a) => a.at > now)
    .sort((a, b) => a.at - b.at)
    .slice(0, ADDRESS_REMINDERS);
  // One reminder for addresses whose notices fall within a day of the first of them.
  const groups = [];
  for (const a of soon) {
    const g = groups[groups.length - 1];
    if (g && a.at - g[0].at < DAY_MS) g.push(a);
    else groups.push([a]);
  }
  for (const group of groups) add(reminder('addr', group[0].at, { count: group.length }));
  for (const s of nearSwaps) {
    const at = s.sendBefore - NEAR_NOTICE_MS;
    if (at > now) add(reminder('near', at));
  }
  return out;
}

const PLAIN_ID = /^rem-(arr|priv|name|addr|near)-\d+$/;

/**
 * Reminders an earlier version stored named things (the payment id, the coin, the name, the
 * address, the deposit address, the wallet and its name): the same reminders, at the same times, in
 * words that name nothing. Ones already like that are kept as they are; unknown ones are dropped.
 */
export function plainReminders(list) {
  const out = [];
  const ids = new Set();
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !Number.isFinite(r.at)) continue;
    const m = /^rem-(arr|priv|name|addr|near)-/.exec(r.id);
    if (!m) continue;
    const type = m[1];
    const title = String(r.title || '');
    let next = r;
    if (!PLAIN_ID.test(r.id) || 'wallet' in r || r.url !== URL_OF[type] || r.kind !== KIND_OF[type]) {
      const many = /^(\d+) of your addresses/.exec(title);
      next = reminder(type, r.at, { count: type === 'addr' && many ? Number(many[1]) : 1, days: /in 1 day/.test(title) ? 1 : 7 });
    }
    if (ids.has(next.id)) continue;
    ids.add(next.id);
    out.push(next);
  }
  return out;
}

/** The reminders that are due now, and the ones to keep. */
export function dueReminders(list, now = Date.now()) {
  const due = [];
  const keep = [];
  for (const r of list || []) (r && r.at <= now ? due : keep).push(r);
  return { due, keep };
}

/**
 * What happened while the person was away, from what was saved when they left (snapshot:
 * { at, txs: { txId: status } }, the newest 200 payments) and the list now: received, sent,
 * failed, contract calls done. A payment not in the snapshot counts only if this wallet first saw
 * it after the person left (an older one was simply not among the 200).
 */
export function awaySummary(snapshot, txs) {
  const was = (snapshot && snapshot.txs) || {};
  const since = snapshot && Number.isFinite(snapshot.at) ? snapshot.at - 60000 : Infinity;
  const r = { received: [], sent: [], failed: [], contracts: [] };
  for (const tx of txs || []) {
    const before = was[tx.txId];
    if (before === undefined && !(Number(tx.create_time) * 1000 >= since)) continue;
    const s = Number(tx.status);
    const type = Number(tx.tx_type);
    if (before === s) continue;
    if (type === CONTRACT) {
      if (before !== undefined && UNDERWAY.has(before) && (s === 3 || s === 4)) r.contracts.push(tx);
      continue;
    }
    if (!PAYMENT.has(type)) continue;
    if (tx.income === true && s === 3 && isNews(tx)) r.received.push(tx);
    else if (tx.income !== true && s === 3 && before !== undefined && UNDERWAY.has(before)) r.sent.push(tx);
    else if (s === 4 && before !== undefined && before !== 4) r.failed.push(tx);
  }
  return r;
}

/** The statuses to remember when the person leaves (the newest 200 payments). */
export function snapshotOf(txs) {
  const o = {};
  for (const tx of (txs || []).slice(0, 200)) o[tx.txId] = Number(tx.status);
  return o;
}

/** "While you were away: received 2 payments (0.5 BEAM) · 1 payment did not go through". */
export function awayLine(summary, { amounts = true } = {}) {
  const parts = [];
  const sumBeam = (list) => list.filter((tx) => (Number(tx.asset_id) || 0) === 0).reduce((a, tx) => a + BigInt(tx.value || 0), 0n);
  if (summary.received.length) {
    const beam = sumBeam(summary.received);
    const n = summary.received.length;
    // Each item of the list is a whole clause (it is in the middle of the sentence: lower case).
    parts.push(
      amounts && beam > 0n
        ? tn({ one: 'received a payment ({amount} BEAM)', other: 'received {n} payments ({amount} BEAM)' }, n, { amount: formatAmount(beam) })
        : tn({ one: 'received a payment', other: 'received {n} payments' }, n),
    );
  }
  if (summary.sent.length) parts.push(tn({ one: 'a payment you sent finished', other: '{n} payments you sent finished' }, summary.sent.length));
  if (summary.contracts.length) parts.push(tn({ one: 'a swap or app call finished', other: '{n} swaps or app calls finished' }, summary.contracts.length));
  if (summary.failed.length) parts.push(tn({ one: 'a payment did not go through', other: '{n} payments did not go through' }, summary.failed.length));
  if (!parts.length) return null;
  return t('While you were away: {list}.', { list: parts.join(' · ') });
}
