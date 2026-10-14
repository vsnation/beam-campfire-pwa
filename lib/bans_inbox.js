// Money waiting for this wallet's names: payments people sent to a name, and
// what names it sold earned. Both wait in BEAM names' vault until the owner
// claims them; they are never part of the spendable balance before that.
//
// A port of the desktop app's lib/wallets/beam/contracts/bans/bans_inbox_monitor.dart
// (summary, claim advice, the monitor) and the claim words of
// lib/widgets/beam/wallet_home/beam_home_text.dart (namePayments, claim).
// Pure, except NameInbox, which only calls the read function it is given.
//
// Amounts are BigInt in the asset's smallest unit (8 decimals for every asset).

import { tryName, display, CLAIMS_PER_TRANSACTION, NAME_CALL_FEE } from './bans.js';
import { t, tn } from './i18n.js';

/** One claim transaction's network fee (measured on mainnet, research/05): the estimate before it is built. */
export const CLAIM_FEE = NAME_CALL_FEE;

export const VISIBILITY = Object.freeze({ visible: 'visible', unsupported: 'unsupported' });

/** The inbox as a summary: totals per asset, entries to claim, the names paid (sorted, valid ones only). */
export function summarize(inbox, at = Date.now()) {
  const totals = new Map();
  const add = (aid, v) => totals.set(aid, (totals.get(aid) || 0n) + v);
  for (const p of inbox.payments) add(p.assetId, p.amount);
  for (const a of inbox.saleProceeds) add(a.assetId, a.amount);
  // A name comes out of a decryption: only names the contract could have issued are shown.
  const names = [...new Set(inbox.payments.map((p) => p.name).filter((n) => n && tryName(n) === n))].sort();
  return {
    visibility: VISIBILITY.visible,
    totals,
    entryCount: inbox.payments.length + inbox.saleProceeds.length,
    paymentCount: inbox.payments.length,
    saleCount: inbox.saleProceeds.length,
    names,
    owns: inbox.domains.length > 0,
    checkedAt: at,
  };
}

export const unsupportedSummary = (at = Date.now()) => ({ visibility: VISIBILITY.unsupported, totals: new Map(), entryCount: 0, paymentCount: 0, saleCount: 0, names: [], owns: null, checkedAt: at });

export const isEmpty = (s) => !s || s.entryCount === 0;

/**
 * What claiming everything now costs and whether it can go: { canClaim, transactions, fee,
 * reason: null | 'unsupported' | 'nothing' | 'needsBeam', costsMoreThanItReturns }.
 * A claim that releases BEAM pays its own fee from it (FundsUnlock counts against the fee);
 * a claim of tokens only needs the fee in the wallet already.
 */
export function advise(summary, beamAvailable) {
  if (!summary || summary.visibility !== VISIBILITY.visible) return { canClaim: false, transactions: 0, fee: 0n, reason: 'unsupported', costsMoreThanItReturns: false };
  if (isEmpty(summary)) return { canClaim: false, transactions: 0, fee: 0n, reason: 'nothing', costsMoreThanItReturns: false };
  const transactions = Math.ceil(summary.entryCount / CLAIMS_PER_TRANSACTION);
  const fee = CLAIM_FEE * BigInt(transactions);
  const beamWaiting = summary.totals.get(0) || 0n;
  const needsBeam = BigInt(beamAvailable) + beamWaiting < fee;
  return {
    canClaim: !needsBeam,
    transactions,
    fee,
    reason: needsBeam ? 'needsBeam' : null,
    costsMoreThanItReturns: summary.totals.size === 1 && summary.totals.has(0) && beamWaiting <= fee,
  };
}

/** BEAM first, then by asset id. */
export function orderedIds(totals) {
  return [...totals.keys()].sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : a - b));
}

/** "2.5 BEAM + 1,000 FOMO". fmt(groth) and unit(assetId) come from the screen. */
export function amountsText(totals, fmt, unit) {
  return orderedIds(totals).map((id) => `${fmt(totals.get(id))} ${unit(id)}`).join(' + ');
}

/** What the balance gains once a claim confirms: "+2.489 BEAM", "+1,000 FOMO, −0.011 BEAM" (the fee taken from BEAM). */
export function balanceChange(receives, fee, fmt, unit) {
  const ids = orderedIds(receives);
  const beamNet = (receives.get(0) || 0n) - fee;
  const change = [];
  if (beamNet > 0n) change.push(`+${fmt(beamNet)} BEAM`);
  for (const id of ids) if (id !== 0) change.push(`+${fmt(receives.get(id))} ${unit(id)}`);
  if (beamNet < 0n) change.push(`−${fmt(-beamNet)} BEAM`);
  return change.length ? change.join(', ') : '0 BEAM';
}

/** The Home line: { lead, amounts }, or null when nothing waits or this engine cannot see it. */
export function namePaymentsText(summary, fmt, unit) {
  if (!summary || summary.visibility !== VISIBILITY.visible || isEmpty(summary) || !summary.totals.size) return null;
  let lead;
  if (summary.names.length === 1) lead = t('Sent to your name {name}', { name: display(summary.names[0]) });
  else if (summary.paymentCount > 0) lead = t('Sent to your names');
  else lead = t('From names you sold');
  return { lead, amounts: amountsText(summary.totals, fmt, unit) };
}

/**
 * The claim's words for the approve sheet and the screens before it, from the summary on
 * screen and the advice; once the engine built the claim, from what it built (`built.receives`,
 * `built.fee`). { headline, receive[], from, fee, balanceChange, feeNote, warning, blocker,
 * batches, privacyNote, cta }.
 */
export function claimText({ summary, advice, canSpend, built = null, fmt, unit }) {
  const totals = built ? built.receives : summary.totals;
  const ids = orderedIds(totals);
  const receive = ids.map((id) => `${fmt(totals.get(id))} ${unit(id)}`);
  const feeGroth = built ? built.fee : CLAIM_FEE;
  const fee = `${fmt(feeGroth)} BEAM`;
  const beamWaiting = summary.totals.get(0) || 0n;

  let feeNote;
  if (beamWaiting >= feeGroth) feeNote = t('Pays its own fee: it comes out of the BEAM you are claiming, so this works even with an empty wallet.');
  else if (beamWaiting > 0n) feeNote = t("Part of the fee comes from this wallet's BEAM.");
  else feeNote = t("The fee is paid from this wallet's BEAM.");

  const warning = advice.costsMoreThanItReturns ? t('The network fee ({fee}) is at least as much as the {amount} BEAM waiting, so claiming now gains you nothing. You can wait until more arrives.', { fee, amount: fmt(beamWaiting) }) : null;

  let blocker = null;
  if (!canSpend) blocker = t('Claiming is paused until the wallet is up to date. It catches up by itself.');
  else if (advice.reason === 'needsBeam') blocker = t('You need {fee} in this wallet to pay the fee. Receive some BEAM first, then claim.', { fee });
  else if (advice.reason === 'unsupported') blocker = t("This version of BEAM Campfire can't claim name payments yet. They stay safe and waiting for you.");
  else if (advice.reason === 'nothing') blocker = t('There is nothing waiting to be claimed.');

  // Three sentences, each with its own count (more than 30 payments, more than one claim).
  const batches =
    advice.transactions > 1
      ? [
          tn({ one: '{n} payment is waiting.', other: '{n} payments are waiting.' }, summary.entryCount),
          tn({ one: 'One claim takes up to {max}, so this takes {n} claim of {fee} each.', other: 'One claim takes up to {max}, so this takes {n} claims of {fee} each.' }, advice.transactions, { max: CLAIMS_PER_TRANSACTION, fee }),
          t('Claim again for the rest once this one is confirmed.'),
        ].join(' ')
      : null;

  const names = summary.names.map(display);
  return {
    headline: names.length === 1 && summary.saleCount === 0 ? t('Claim what was sent to {name}', { name: names[0] }) : summary.paymentCount === 0 ? t('Claim what your sold names earned') : t('Claim what was sent to your names'),
    receive,
    from: names.length ? names.join(', ') : null,
    fee,
    // The fee comes out of BEAM, so the BEAM line is net; gains first.
    balanceChange: balanceChange(totals, feeGroth, fmt, unit),
    feeNote,
    warning,
    blocker,
    batches,
    privacyNote: summary.paymentCount > 0 ? t('A payment to your name and your claim of it can be linked on the blockchain. Claiming later, or several payments at once, makes that harder.') : null,
    cta: receive.length === 1 ? t('Claim {amount}', { amount: receive[0] }) : t('Claim all'),
  };
}

/** A wallet that owns no name is checked again after this long (a name can be transferred to it). */
export const RECHECK_UNOWNED_MS = 24 * 3600 * 1000;

/**
 * Whether Home reads the inbox, from what this wallet is known to hold (hint: {owns, at} or null)
 * and how it came to be. One created here from new words owns nothing until it registers, buys or
 * is given a name; one restored or imported may own names from before.
 */
export function homeShouldRead({ hint, record, now = Date.now() }) {
  if (hint) return hint.owns === true || now - hint.at > RECHECK_UNOWNED_MS;
  return Boolean(record && (record.imported || record.restored));
}

/**
 * Keeps the newest summary: never two reads at once, not more often than minIntervalMs
 * unless forced. A failed read keeps the last good summary (a stale "2.5 BEAM waiting"
 * beats a flicker to nothing); only an engine that cannot read the inbox at all changes it.
 *   read() -> Promise<inbox> (lib/bans.js inbox()); throws BansError 'claimUnsupported'
 */
export class NameInbox {
  constructor(read, { minIntervalMs = 20000, now = () => Date.now() } = {}) {
    this.read = read;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.latest = null;
    this.lastError = null;
    this.lastRead = null;
    this.inFlight = null;
    this.claiming = null; // { at, receives } after a claim was sent, until a read shows it gone
    this.listeners = new Set();
    this.disposed = false;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      try {
        fn(this.latest);
      } catch (e) {
        console.error(e);
      }
    }
  }

  refresh({ force = false } = {}) {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (!force && this.lastRead != null && this.now() - this.lastRead < this.minIntervalMs) return Promise.resolve();
    const p = this.readOnce().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  async readOnce() {
    this.lastRead = this.now();
    let summary;
    try {
      summary = summarize(await this.read(), this.now());
      this.lastError = null;
    } catch (e) {
      this.lastError = e;
      if (!(e && e.code === 'claimUnsupported')) {
        this.emit();
        return;
      }
      summary = unsupportedSummary(this.now());
    }
    if (this.disposed) return;
    // A claim sent is shown as on its way until the inbox no longer holds it.
    if (this.claiming && (summary.entryCount === 0 || this.now() - this.claiming.at > 30 * 60000)) this.claiming = null;
    this.latest = summary;
    this.emit();
  }

  markClaiming(receives) {
    this.claiming = { at: this.now(), receives };
    this.emit();
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}
