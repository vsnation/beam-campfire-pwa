// A transaction of this Ethereum wallet whose fate is in doubt, and the rule that follows from it
// (release audit BM-1): while one is, nothing new is signed from this account.
//
// "In doubt" is an open outbox entry (signed or pending) that lib/eth/send.js marked:
//   unsureSince  its server says its nonce is used up but cannot show by what ("Not sure yet");
//   refusedAt    its server refused its bytes, which it may have passed on first ("Not sent yet").
// Either may still be mined. A new transaction takes its nonce from the server's 'pending' count,
// one past the doubtful one when the server counts it: both could then be mined, and the person
// pays twice. So every way out of this account (a payment, a Uniswap swap or permission, a move to
// BEAM over the bridge) asks here first, before the key is opened, and is refused while one is in
// doubt. The ways out are said with it: wait until it is settled (the screens keep following it),
// or pick another Ethereum server in Settings, which then follows it there; with History from
// Stack Wallet off, turning it on (the index can show what took its nonce).
//
// A doubt no listed server can settle (re-audit RE2-2: no state at past blocks, History off, or a
// server that contradicts itself) would pause this wallet for good. Once it has been in doubt for
// FORGET_AFTER_MS and a look that long after it began still failed (entry.doubtLookAt, written by
// lib/eth/send.js followOnce), the person may forget it, after a plain warning: that entry only
// leaves the outbox, and sending opens up again. That look must also be recent (FORGET_LOOK_FRESH_MS,
// release audit RE3-2): marks left from days ago never offer it; the next look, a moment after the
// screen opens, does (or settles it).

import { isOpen, loadOutbox, removeFromOutbox } from './outbox.js';
import { formatUnits } from './units.js';
import { ETH, tokenBySymbol, tokenByAddress } from './tokens.js';

/** 'unsure' | 'refused' for an open entry in doubt, else null. */
export function doubtOf(entry) {
  if (!entry || !isOpen(entry)) return null;
  if (entry.unsureSince) return 'unsure';
  if (entry.refusedAt) return 'refused';
  return null;
}

/** The newest entry of `outbox` (newest first, as stored) whose fate is in doubt, or null. */
export function entryInDoubt(outbox) {
  return (Array.isArray(outbox) ? outbox : []).find((e) => doubtOf(e) !== null) || null;
}

/** What the status screens and the activity list call it. */
export const DOUBT_TITLE = Object.freeze({ unsure: 'Not sure yet', refused: 'Not sent yet' });

/** The way out, said wherever something is refused because of it. */
export const DOUBT_WAY_OUT = 'Wait until BEAM Campfire knows what happened to it, or choose another Ethereum server in Settings: it is checked there.';
/** One more way out while History from Stack Wallet is off: its index can show what took the nonce (send.js findNonceTaker). */
export const HISTORY_WAY_OUT = 'Or turn on History from Stack Wallet in Settings: it then finds what took its place, if anything did.';

/** In doubt this long, with a look this long after it began failing the same way: it may be forgotten. */
export const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;
/**
 * ...and that failing look no older than this. The screens that offer Forget look every few seconds
 * while open (at most once a minute is written: lib/eth/send.js NONCE_LOOK_MS), so this only ever
 * hides the button on marks from an earlier session.
 */
export const FORGET_LOOK_FRESH_MS = 5 * 60 * 1000;
/** Said before it is forgotten. */
export const FORGET_WARNING = 'It may still go through. If it does and you send again, both go through.';

/** When its doubt began (ms), or null. */
export function doubtSince(entry) {
  const d = doubtOf(entry);
  return d === 'unsure' ? entry.unsureSince : d === 'refused' ? entry.refusedAt : null;
}

/** Whether the last failing look at `entry` was a day or more after its doubt began. */
const dayOfLooks = (entry) => {
  const since = doubtSince(entry);
  return Number.isFinite(since) && Number.isFinite(entry.doubtLookAt) && entry.doubtLookAt - since >= FORGET_AFTER_MS;
};

/** Whether the last look at `entry` is recent (FORGET_LOOK_FRESH_MS before `now`, or later). */
const lookedLately = (entry, now) => Number.isFinite(entry.doubtLookAt) && now - entry.doubtLookAt < FORGET_LOOK_FRESH_MS;

/**
 * Whether `entry` has been in doubt for FORGET_AFTER_MS with a look that long after still failing,
 * and that look a recent one (RE3-2).
 */
export function mayForget(entry, now = Date.now()) {
  return dayOfLooks(entry) && lookedLately(entry, now);
}

/** History from Stack Wallet is on unless the person turned it off (lib/eth/wallet.js ethPrefs). */
const historyOn = (app) => !(app && app.prefs && app.prefs.ethHistory === false);

const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function assetOf(entry) {
  if (!entry.token) return ETH;
  return tokenBySymbol(entry.asset) || tokenByAddress(String(entry.token).toLowerCase()) || { symbol: entry.asset, decimals: 18 };
}

/** 'payment' | 'swap' | 'permission'. */
export function doubtNoun(entry) {
  if (entry.kind === 'swap') return 'swap';
  if (entry.kind === 'approve' || entry.kind === 'approveReset') return 'permission';
  return 'payment';
}

/**
 * Its name in pieces, so a screen can set the address apart: {lead, address} with lead "your
 * payment of 0.01 ETH to" and address "0x7099…79C8"; "your swap of 0.01 ETH" and "your WBEAM
 * permission for Uniswap" have no address (null).
 */
export function doubtNameParts(entry) {
  const a = assetOf(entry);
  const amount = `${formatUnits(BigInt(entry.amount), a.decimals)} ${a.symbol}`;
  const noun = doubtNoun(entry);
  if (noun === 'swap') return { lead: `your swap of ${amount}`, address: null };
  if (noun === 'permission') return { lead: `your ${a.symbol} permission for Uniswap`, address: null };
  return { lead: `your payment of ${amount} to`, address: shortAddr(entry.to) };
}

/** "your payment of 0.01 ETH to 0x7099…79C8", "your swap of 0.01 ETH", "your WBEAM permission for Uniswap". */
export function doubtName(entry) {
  const { lead, address } = doubtNameParts(entry);
  return address ? `${lead} ${address}` : lead;
}

/** Why nothing new goes while it is in doubt, after its name. */
export const DOUBT_WHY = 'It may still go through, so nothing new is sent from this Ethereum wallet until it is settled, or both could go through.';

/** The ways out in words: History is named while it is off. */
export function doubtWayOut({ history = true } = {}) {
  return history ? DOUBT_WAY_OUT : `${DOUBT_WAY_OUT} ${HISTORY_WAY_OUT}`;
}

/** The whole refusal in words: what is in doubt, why nothing new goes, and the way out. */
export function doubtMessage(entry, { history = true } = {}) {
  const name = doubtName(entry);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} is "${DOUBT_TITLE[doubtOf(entry)]}". ${DOUBT_WHY} ${doubtWayOut({ history })}`;
}

/** Thrown instead of signing while a transaction is in doubt; .entry is that transaction. */
export class EthInDoubtError extends Error {
  constructor(entry, { history = true } = {}) {
    super(doubtMessage(entry, { history }));
    this.code = 'in_doubt';
    this.entry = entry;
  }
}

/**
 * Refuses (EthInDoubtError) while a transaction of this Ethereum wallet is in doubt, reading the
 * outbox as stored (not a screen's copy of it). Called before any key is opened.
 */
export async function assertNothingInDoubt(app, { ethId, kv } = {}) {
  const e = entryInDoubt(await loadOutbox(app, { ethId, kv }));
  if (e) throw new EthInDoubtError(e, { history: historyOn(app) });
}

/** Why an entry cannot be forgotten: .code 'not_in_doubt' | 'not_yet' | 'not_lately'. */
export class ForgetRefused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Forgets the transaction `hash` (that entry only leaves the outbox) once mayForget() says so,
 * checked again on the stored entry. The person was told FORGET_WARNING first. Returns the entry.
 */
export async function forgetInDoubt(app, hash, { ethId, kv, now = () => Date.now() } = {}) {
  let why = null;
  const gone = await removeFromOutbox(app, hash, {
    ethId,
    kv,
    when: (e) => {
      if (doubtOf(e) === null) why = new ForgetRefused('not_in_doubt', 'It is settled: there is nothing to forget.');
      else if (!dayOfLooks(e)) why = new ForgetRefused('not_yet', 'It can be forgotten only after a day of looking for it.');
      else if (!lookedLately(e, now())) why = new ForgetRefused('not_lately', 'BEAM Campfire looks for it once more first. Keep this screen open for a minute, then try again.');
      return why === null;
    },
  });
  if (why) throw why;
  if (!gone) throw new ForgetRefused('not_in_doubt', 'It is not in this Ethereum wallet any more.');
  return gone;
}
