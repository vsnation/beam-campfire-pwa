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

export const KINDS = Object.freeze(['in', 'out', 'underway', 'contracts', 'moves']);
export const KIND_WORDS = Object.freeze({
  in: { title: 'Money in', sub: 'Payments received, private payments ready to spend, money paid to your names, an address about to expire' },
  out: { title: 'Money out', sub: 'Payments sent, and any that failed' },
  underway: { title: 'Payments under way', sub: 'When you leave the app while a payment still needs it' },
  contracts: { title: 'Swaps, pools, tokens and names', sub: 'Done or failed; a name about to expire' },
  moves: { title: 'Bridge, and paying with other coins', sub: 'A move ready to collect or done; a deposit address about to stop taking coins' },
});

/** Defaults: everything on once notifications are on. */
export const DEFAULT_KINDS = Object.freeze(Object.fromEntries(KINDS.map((k) => [k, true])));

const UNDERWAY = new Set([0, 1, 5]); // pending, in progress, registering
const PAYMENT = new Set([0, 7]); // a plain payment, an offline / max-privacy one
const CONTRACT = 12;

/** The person's settings, with defaults; prefs.notify = { on, kinds, amounts }. */
export function settingsOf(prefs) {
  const n = (prefs && prefs.notify) || {};
  const on = n.on === true || (n.on === undefined && Boolean(prefs) && prefs.paymentNotifications === true);
  return { on, kinds: { ...DEFAULT_KINDS, ...(n.kinds || {}) }, amounts: n.amounts !== false };
}

const amountOf = (tx, label) => {
  const id = Number(tx.asset_id) || 0;
  const v = formatAmount(BigInt(tx.value || 0));
  if (id === 0) return `${v} BEAM`;
  return label && label.verified && !label.pool ? `${v} ${label.symbol}` : `${v} of token #${id}`;
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
      for (const t of list) {
        const s = Number(t.status);
        const before = status.get(t.txId);
        status.set(t.txId, s);
        if (first || !live || before === s) continue;
        const type = Number(t.tx_type);
        const known = before !== undefined;
        if (type === CONTRACT) {
          if (!known || !UNDERWAY.has(before)) continue; // only what this run saw under way
          if (s === 3) out.push({ kind: 'contracts', type: 'contractDone', tx: t });
          else if (s === 4) out.push({ kind: 'contracts', type: 'contractFailed', tx: t });
          continue;
        }
        if (!PAYMENT.has(type)) continue;
        if (t.income === true) {
          if (s === 3 && isNews(t)) out.push({ kind: 'in', type: 'received', tx: t });
          else if (s === 4 && known) out.push({ kind: 'out', type: 'failed', tx: t });
        } else if (known && UNDERWAY.has(before)) {
          if (s === 3) out.push({ kind: 'out', type: 'sent', tx: t });
          else if (s === 4) out.push({ kind: 'out', type: 'failed', tx: t });
        }
      }
      return out;
    },
  };
}

/** Payments still under way: incoming ones arrive only while this wallet is online, outgoing ones finish only while it is. */
export function underway(txs) {
  return (txs || []).filter((t) => PAYMENT.has(Number(t.tx_type)) && UNDERWAY.has(Number(t.status)) && Number(t.tx_type) === 0);
}

/**
 * What a notification says. ev: { type, tx } or a free one { type: 'free', title, body }.
 * label(assetId) names an asset; contractTitle(tx) names a contract call (lib/wallet.js
 * contractLabel); amounts false: no amounts in the text (a lock screen shows it).
 * Returns { title, body, tag, url }: url is where a tap opens (a hash the app reads).
 */
export function wordsFor(ev, { label = () => null, contractTitle = () => 'Contract call', amounts = true, walletName = null } = {}) {
  const where = walletName ? ` In ${walletName}.` : '';
  const tx = ev.tx;
  const open = tx ? `#open=activity&tx=${encodeURIComponent(tx.txId)}` : '#open=home';
  const amt = tx && amounts ? amountOf(tx, label(Number(tx.asset_id) || 0)) : null;
  switch (ev.type) {
    case 'received':
      return { title: amt ? `Received ${amt}` : 'Payment received', body: `Tap to see it in Activity.${where}`, tag: `in-${tx.txId}`, url: open };
    case 'sent':
      return { title: amt ? `Sent ${amt}` : 'Payment sent', body: `It is complete.${where}`, tag: `out-${tx.txId}`, url: open };
    case 'failed':
      if (tx.income === true) return { title: amt ? `A payment of ${amt} to you did not go through` : 'A payment to you did not go through', body: `Nothing arrived. The sender can send it again.${where}`, tag: `fail-${tx.txId}`, url: open };
      return { title: amt ? `Your payment of ${amt} did not go through` : 'Your payment did not go through', body: `Nothing left your wallet for it. Tap to see why.${where}`, tag: `fail-${tx.txId}`, url: open };
    case 'contractDone':
      return { title: `${contractTitle(tx)}: done`, body: `Tap to see it in Activity.${where}`, tag: `c-${tx.txId}`, url: open };
    case 'contractFailed':
      return { title: `${contractTitle(tx)}: did not go through`, body: `Tap to see why.${where}`, tag: `cf-${tx.txId}`, url: open };
    case 'arriving':
      return { title: 'A payment to you is arriving', body: `It finishes only while BEAM Campfire is open: come back so it can.${where}`, tag: `arr-${tx.txId}`, url: open };
    case 'leaving':
      return { title: 'Your payment is still on its way', body: `It finishes only while BEAM Campfire is open: come back so it can.${where}`, tag: `arr-${tx.txId}`, url: open };
    case 'several':
      return { title: ev.title, body: `Tap to see them in Activity.${where}`, tag: `sev-${ev.count}-${Date.now()}`, url: '#open=activity' };
    default: {
      // plainBody: the same without amounts, for when the person turned amounts off.
      const body = !amounts && ev.plainBody != null ? ev.plainBody : ev.body || '';
      return { title: ev.title, body: `${body}${where}`.trim(), tag: ev.tag || `free-${Date.now()}`, url: ev.url || '#open=home' };
    }
  }
}

/** When the person leaves the app: what to say at once (the payments that need the app). */
export function leavingEvents(txs) {
  return underway(txs).map((t) => ({ kind: 'underway', type: t.income === true ? 'arriving' : 'leaving', tx: t }));
}

export const REMIND_AFTER_MS = 20 * 60 * 1000;
export const DAY_MS = 24 * 3600 * 1000;

/**
 * Reminders for later, worked out when the person leaves; the service worker shows each when it
 * is due (if the browser wakes it: Periodic Background Sync, Chromium) and the page shows them
 * while it still runs. Each: { id, wallet, kind, at, title, body, url }. No amounts.
 *   - a payment still under way: 20 minutes later;
 *   - a private payment: when it can be spent (spendableAt per coin, from lib/coins.js);
 *   - a name: 7 days and 1 day before it expires;
 *   - a NEAR swap: 30 minutes before its deposit address stops taking coins;
 *   - an address of this wallet that expires: 3 days before (payments to it stop arriving then), at
 *     most ADDRESS_REMINDERS of the nearest, one reminder for those due within a day of each other. Its label is a
 *     private note, so it is named only when amounts may be shown (labels: true).
 */
export const ADDRESS_REMINDERS = 5;
export const ADDRESS_NOTICE_DAYS = 3;

export function remindersFor({ txs = [], privateCoins = [], names = [], nearSwaps = [], addresses = [], labels = false, wallet = null, walletName = null, now = Date.now() } = {}) {
  const where = walletName ? ` In ${walletName}.` : '';
  const out = [];
  for (const t of underway(txs)) {
    out.push({
      id: `rem-arr-${t.txId}`,
      wallet,
      kind: 'underway',
      at: now + REMIND_AFTER_MS,
      title: t.income === true ? 'A payment to you is still waiting' : 'Your payment is still waiting',
      body: `It finishes only while BEAM Campfire is open. Open it to finish.${where}`,
      url: `#open=activity&tx=${encodeURIComponent(t.txId)}`,
    });
  }
  for (const c of privateCoins) {
    if (!(c.spendableAt > now)) continue;
    out.push({ id: `rem-priv-${c.id}`, wallet, kind: 'in', at: c.spendableAt, title: 'A private payment can now be spent', body: `Open BEAM Campfire to use it.${where}`, url: '#open=coins' });
  }
  for (const n of names) {
    if (!(n.expiresAt > now)) continue;
    for (const days of [7, 1]) {
      const at = n.expiresAt - days * DAY_MS;
      if (at <= now) continue;
      out.push({ id: `rem-name-${n.name}-${days}`, wallet, kind: 'contracts', at, title: `${n.name}.beam expires in ${days === 1 ? '1 day' : `${days} days`}`, body: `Renew it in BEAM names so it stays yours.${where}`, url: '#open=names' });
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
  for (const group of groups) {
    const first = group[0];
    const one = group.length === 1;
    const named = one && labels && first.label ? ` (${first.label})` : '';
    out.push({
      id: `rem-addr-${first.address.slice(0, 16)}`,
      wallet,
      kind: 'in',
      at: first.at,
      title: one ? `An address of yours${named} expires in ${ADDRESS_NOTICE_DAYS} days` : `${group.length} of your addresses expire in ${ADDRESS_NOTICE_DAYS} days`,
      body: `Payments sent to ${one ? 'it' : 'them'} after that won't arrive. Extend ${one ? 'it' : 'them'} in Your addresses.${where}`,
      url: '#open=addresses',
    });
  }
  for (const s of nearSwaps) {
    const at = s.sendBefore - 30 * 60 * 1000;
    if (!(at > now)) continue;
    out.push({ id: `rem-near-${s.id}`, wallet, kind: 'moves', at, title: `Send your ${s.symbol} in the next 30 minutes`, body: `The deposit address for your swap stops taking coins then.${where}`, url: '#open=nearIntents' });
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
  for (const t of txs || []) {
    const before = was[t.txId];
    if (before === undefined && !(Number(t.create_time) * 1000 >= since)) continue;
    const s = Number(t.status);
    const type = Number(t.tx_type);
    if (before === s) continue;
    if (type === CONTRACT) {
      if (before !== undefined && UNDERWAY.has(before) && (s === 3 || s === 4)) r.contracts.push(t);
      continue;
    }
    if (!PAYMENT.has(type)) continue;
    if (t.income === true && s === 3 && isNews(t)) r.received.push(t);
    else if (t.income !== true && s === 3 && before !== undefined && UNDERWAY.has(before)) r.sent.push(t);
    else if (s === 4 && before !== undefined && before !== 4) r.failed.push(t);
  }
  return r;
}

/** The statuses to remember when the person leaves (the newest 200 payments). */
export function snapshotOf(txs) {
  const o = {};
  for (const t of (txs || []).slice(0, 200)) o[t.txId] = Number(t.status);
  return o;
}

/** "While you were away: received 2 payments (0.5 BEAM) · 1 payment did not go through". */
export function awayLine(summary, { amounts = true } = {}) {
  const parts = [];
  const sumBeam = (list) => list.filter((t) => (Number(t.asset_id) || 0) === 0).reduce((a, t) => a + BigInt(t.value || 0), 0n);
  if (summary.received.length) {
    const beam = sumBeam(summary.received);
    const n = summary.received.length;
    parts.push(`received ${n === 1 ? 'a payment' : `${n} payments`}${amounts && beam > 0n ? ` (${formatAmount(beam)} BEAM)` : ''}`);
  }
  if (summary.sent.length) parts.push(summary.sent.length === 1 ? 'a payment you sent finished' : `${summary.sent.length} payments you sent finished`);
  if (summary.contracts.length) parts.push(summary.contracts.length === 1 ? 'a swap or app call finished' : `${summary.contracts.length} swaps or app calls finished`);
  if (summary.failed.length) parts.push(summary.failed.length === 1 ? 'a payment did not go through' : `${summary.failed.length} payments did not go through`);
  if (!parts.length) return null;
  const s = parts.join(' · ');
  return `While you were away: ${s}.`;
}
