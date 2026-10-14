// Where a move is, in plain words: the line under its headline, its short
// status for a list, and its steps. A port of the desktop app's BridgeWords and
// bridgeSteps (lib/pages/bridge/bridge_widgets.dart). Pure.
//
// In the person's language: a move's lastError is kept in English and compared as it is; it is shown
// through lastErrorText (controller.js).

import { BEAM_DECIMALS, BEAM_CONFIRMATIONS, routeById } from '../lib/bridge/routes.js';
import { STATES, DIRECTIONS, isOpen } from '../lib/bridge/store.js';
import { LOCK_FAILED_SHARED, LOCK_FAILED_TAKEN, LOCK_REFUSED, lastErrorText } from '../lib/bridge/controller.js';
import { t, tn } from '../lib/i18n.js';
import { coin, exact, ago, sourceDecimals, sourceSymbol, destinationDecimals, destinationSymbol, destinationChain } from './bridge_text.js';

/** mood: progress | success | warning | error; needsYou: it waits for the person (Collect), not for a chain. */
const words = (title, detail, short, mood, needsYou = false) => Object.freeze({ title, detail, short, mood, needsYou });

/**
 * A move to BEAM whose lock names a bridge message another record of this list already follows
 * (controller.js, release audit BM-3): it ended there, its coins are collected through that one.
 */
const handedOver = (c) => c.direction === DIRECTIONS.toBeam && c.state === STATES.claimed && c.msgId === null && c.origin !== 'found';

/** "1,000 BEAM → Ethereum"; coins found waiting on BEAM: "0.5 bETH found on BEAM". */
export function headline(c) {
  const r = routeById(c.route);
  if (c.origin === 'found') return t('{amount} found on BEAM', { amount: arrivesCoin(c) });
  return `${coin(c.amount, sourceDecimals(r, c.direction), sourceSymbol(r, c.direction))} → ${destinationChain(c.direction)}`;
}

/** What arrives: "1,000 WBEAM". */
export function arrivesCoin(c) {
  const r = routeById(c.route);
  return coin(c.receives, destinationDecimals(r, c.direction), destinationSymbol(r, c.direction));
}

/** What crossing c is doing; blocksLeft from the controller (null while unknown). */
export function crossingWords(c, { blocksLeft = null, now = Date.now() } = {}) {
  const r = routeById(c.route);
  const out = coin(c.amount, sourceDecimals(r, c.direction), sourceSymbol(r, c.direction));
  const arrives = arrivesCoin(c);
  // Compared as the record keeps it (English); shown in the person's language.
  const err = c.lastError;
  const shown = lastErrorText(err);
  const withError = (s) => (err ? `${s}\n${shown}` : s);
  switch (c.state) {
    case STATES.sending:
      return words(t('Sending {amount} to Ethereum', { amount: out }), t('Waiting for you to approve it in your BEAM wallet.'), t('Sending'), 'progress');
    case STATES.sent:
      return words(t('Sent: waiting for the BEAM network'), t('It goes into the next BEAM blocks, usually within a minute or two.'), t('Sending'), 'progress');
    case STATES.confirmed:
      if (blocksLeft == null) {
        return words(
          t('On its way to Ethereum'),
          tn({ one: 'The bridge pays your Ethereum wallet {n} BEAM block after it was sent, about an hour.', other: 'The bridge pays your Ethereum wallet {n} BEAM blocks after it was sent, about an hour.' }, BEAM_CONFIRMATIONS),
          t('On its way'),
          'progress',
        );
      }
      if (blocksLeft > 0) {
        return words(
          tn({ one: 'On its way: {n} BEAM block to go', other: 'On its way: {n} BEAM blocks to go' }, blocksLeft),
          tn({ one: 'The bridge pays your Ethereum wallet after {n} BEAM block (about one a minute). Nothing needs doing; you can close BEAM Campfire.', other: 'The bridge pays your Ethereum wallet after {n} BEAM blocks (about one a minute). Nothing needs doing; you can close BEAM Campfire.' }, BEAM_CONFIRMATIONS),
          tn({ one: '{n} block to go', other: '{n} blocks to go' }, blocksLeft),
          'progress',
        );
      }
      return words(t('Due now: the bridge is paying it'), t('It usually lands in your Ethereum wallet within minutes of the {n}st block.', { n: BEAM_CONFIRMATIONS }), t('Due now'), 'progress');
    case STATES.waitingForGas:
      // Nothing for the person to do: said calmly, not as an alarm.
      return words(
        t('Waiting for Ethereum gas to come down'),
        t('Ethereum costs more right now than the bridge fee you paid. The bridge retries about every 30 minutes and pays as soon as gas comes down to it. Your coins are safe; nothing needs doing.'),
        t('Waiting for gas'),
        'progress',
      );
    case STATES.paid:
      return words(t('{amount} arrived in your Ethereum wallet', { amount: arrives }), null, t('Arrived'), 'success');
    case STATES.failed:
      return words(err && /did not approve/.test(err) ? t('Not sent') : t('The BEAM transaction failed'), shown || t('Nothing left your wallet.'), t('Not sent'), 'error');
    case STATES.approving:
      return words(
        t('Letting the bridge take your {coin}', { coin: r.ethSymbol }),
        t('First an Ethereum transaction allows the bridge to take exactly {amount}, then it is sent. Keep BEAM Campfire open for a minute.', { amount: coin(c.amount + c.relayerFee, r.ethDecimals, r.ethSymbol) }),
        t('Starting'),
        'progress',
      );
    case STATES.locking:
      // One server said the lock reverted: BEAM is watched for it before that is believed (controller.js).
      if (c.revertSeenAt) return words(t('Checking whether it reached the bridge'), shown || t('BEAM Campfire watches BEAM for it before saying anything is lost.'), t('Checking'), 'warning');
      return words(t('Sending {amount} to the bridge', { amount: out }), withError(t('Waiting for Ethereum, usually under a minute.')), t('Waiting for Ethereum'), 'progress');
    case STATES.locked:
      return words(t('On its way to BEAM'), t('Ethereum has it. The bridge brings it to BEAM, usually within 2 minutes; then you collect it.'), t('On its way'), 'progress');
    case STATES.notDeliveredYet:
      return words(
        t('Taking longer than usual'),
        c.lockedAt
          ? t('Sent to the bridge {when}. The bridge is sometimes slow when it is busy; BEAM Campfire keeps looking. If you use this wallet on another device too, it may have been collected there.', { when: ago(c.lockedAt, now) })
          : t('Sent to the bridge over 30 minutes ago. The bridge is sometimes slow when it is busy; BEAM Campfire keeps looking. If you use this wallet on another device too, it may have been collected there.'),
        t('Taking longer'),
        'warning',
      );
    case STATES.delivered: {
      const fee = coin(c.beamNetworkFee, BEAM_DECIMALS, 'BEAM');
      return words(
        t('Ready to collect'),
        withError(
          c.origin === 'found'
            ? t('BEAM Campfire found it waiting on BEAM for this wallet. Collecting it is a BEAM transaction with a {fee} network fee.', { fee })
            : t('It is on BEAM. Collecting it is a BEAM transaction with a {fee} network fee.', { fee }),
        ),
        t('Collect'),
        err ? 'warning' : 'progress',
        true,
      );
    }
    case STATES.claiming:
      return words(t('Collecting {amount}', { amount: arrives }), withError(t('Waiting for the BEAM network, usually a minute or two.')), t('Collecting'), 'progress');
    case STATES.claimed:
      if (handedOver(c)) return words(t('Followed by another move'), shown, t('Under another move'), 'success');
      return words(t('{amount} is in your BEAM wallet', { amount: arrives }), shown, t('Arrived'), 'success');
    case STATES.lockFailed:
      // Refused on one server's word while coins of its amount reached BEAM that another move may own.
      if (err === LOCK_FAILED_SHARED) return words(t('Refused, says your Ethereum server'), shown, t('Check Waiting for you'), 'warning');
      // ... whose coins turned out to be another move's (re-audit RE2-3).
      if (err === LOCK_FAILED_TAKEN) return words(t('Refused, says your Ethereum server'), shown, t('Refused'), 'warning');
      // Refused for the whole watch: the server's word, as a refused payment (re-audit RE2-3).
      if (err === LOCK_REFUSED) return words(t('Refused by your Ethereum server'), shown, t('Not sent'), 'error');
      return words(t('Nothing was moved'), shown || t('The bridge did not take your {coin}.', { coin: r.ethSymbol }), t('Not sent'), 'error');
    case STATES.unknown:
      return words(
        t("BEAM Campfire can't tell yet whether it was sent"),
        withError(
          c.direction === DIRECTIONS.toEthereum
            ? t('Your BEAM wallet did not confirm sending it. Check its Activity before trying again: BEAM Campfire keeps looking for it and shows it here when it finds it.')
            : t('Ethereum did not confirm it. Check your Ethereum wallet before trying again: BEAM Campfire keeps looking for it on BEAM and shows it here when it arrives.'),
        ),
        t('Checking'),
        'warning',
      );
    default:
      return words(t('Unknown state'), null, '—', 'warning');
  }
}

/** Each step of crossing c: {label, status: done | active | waiting | failed, note}. */
export function crossingSteps(c, { blocksLeft = null, now = Date.now() } = {}) {
  const step = (label, status, note = null) => Object.freeze({ label, status, note });
  const s = c.state;
  const at = ago(c.createdAt, now);
  if (c.direction === DIRECTIONS.toEthereum) {
    const mined = c.msgId !== null;
    const due = mined && (blocksLeft ?? 1) === 0;
    const paid = s === STATES.paid;
    const gas = s === STATES.waitingForGas;
    return [
      step(t('Sent from your BEAM wallet'), s === STATES.failed ? 'failed' : (s === STATES.sending || s === STATES.unknown) && !mined ? 'active' : 'done', at),
      step(mined && c.height != null ? t('In BEAM block {height}', { height: exact(BigInt(c.height), 0) }) : t('In a BEAM block'), mined ? 'done' : s === STATES.sent ? 'active' : 'waiting'),
      step(tn({ one: '{n} BEAM block', other: '{n} BEAM blocks' }, BEAM_CONFIRMATIONS), paid || due || gas ? 'done' : mined ? 'active' : 'waiting', mined && !due && !paid && !gas && blocksLeft != null ? tn({ one: '{n} to go', other: '{n} to go' }, blocksLeft) : null),
      step(t('Paid to your Ethereum wallet'), paid ? 'done' : due || gas ? 'active' : 'waiting', gas ? t('Waiting for gas') : null),
    ];
  }
  const locked = c.msgId !== null;
  const onBeam = s === STATES.delivered || s === STATES.claiming || s === STATES.claimed;
  // Found waiting on BEAM: how it got there is not this device's to say.
  if (c.origin === 'found') return [step(t('Found waiting on BEAM'), 'done', at), step(t('Collected in your BEAM wallet'), s === STATES.claimed ? 'done' : 'active', s === STATES.delivered ? t('Your turn') : null)];
  if (handedOver(c)) return [step(t('Sent to the bridge on Ethereum'), 'done', at), step(t('Followed by another move in this list'), 'done')];
  const steps = [];
  if (c.approveHashes.length || s === STATES.approving) {
    steps.push(step(t('Bridge allowed to take your {coin}', { coin: routeById(c.route).ethSymbol }), s === STATES.approving ? 'active' : s === STATES.lockFailed && !c.lockHash ? 'failed' : 'done', at));
  }
  steps.push(step(t('Sent to the bridge on Ethereum'), s === STATES.lockFailed ? 'failed' : locked || onBeam ? 'done' : s === STATES.approving ? 'waiting' : 'active', steps.length ? null : at));
  steps.push(step(t('Brought to BEAM by the bridge'), onBeam ? 'done' : locked ? 'active' : 'waiting'));
  steps.push(step(t('Collected in your BEAM wallet'), s === STATES.claimed ? 'done' : onBeam ? 'active' : 'waiting', s === STATES.delivered ? t('Your turn') : null));
  return steps;
}

/** For a lock screen: where an open move is, with no amount and no address. */
export function lockedNote(c, { blocksLeft = null } = {}) {
  if (!c || !isOpen(c)) return null;
  const w = crossingWords(c, { blocksLeft });
  if (c.direction === DIRECTIONS.toEthereum) return w.needsYou ? t('Your move to Ethereum is ready to collect.') : t('Your move to Ethereum was at "{status}" when BEAM Campfire locked.', { status: w.short });
  return w.needsYou ? t('Your move to BEAM is ready to collect.') : t('Your move to BEAM was at "{status}" when BEAM Campfire locked.', { status: w.short });
}
