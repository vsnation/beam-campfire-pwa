// Where a move is, in plain words: the line under its headline, its short
// status for a list, and its steps. A port of the desktop app's BridgeWords and
// bridgeSteps (lib/pages/bridge/bridge_widgets.dart). Pure.

import { BEAM_DECIMALS, BEAM_CONFIRMATIONS, routeById } from '../lib/bridge/routes.js';
import { STATES, DIRECTIONS, isOpen } from '../lib/bridge/store.js';
import { coin, exact, ago, sourceDecimals, sourceSymbol, destinationDecimals, destinationSymbol, destinationChain } from './bridge_text.js';

/** mood: progress | success | warning | error; needsYou: it waits for the person (Collect), not for a chain. */
const words = (title, detail, short, mood, needsYou = false) => Object.freeze({ title, detail, short, mood, needsYou });

/** "1,000 BEAM → Ethereum". */
export function headline(c) {
  const r = routeById(c.route);
  return `${coin(c.amount, sourceDecimals(r, c.direction), sourceSymbol(r, c.direction))} → ${destinationChain(c.direction)}`;
}

/** What arrives: "1,000 WBEAM". */
export function arrivesCoin(c) {
  const r = routeById(c.route);
  return coin(c.receives, destinationDecimals(r, c.direction), destinationSymbol(r, c.direction));
}

const blocksText = (n) => `${n} BEAM ${n === 1 ? 'block' : 'blocks'} to go`;

/** What crossing c is doing; blocksLeft from the controller (null while unknown). */
export function crossingWords(c, { blocksLeft = null, now = Date.now() } = {}) {
  const r = routeById(c.route);
  const out = coin(c.amount, sourceDecimals(r, c.direction), sourceSymbol(r, c.direction));
  const arrives = arrivesCoin(c);
  const err = c.lastError;
  const withError = (s) => (err ? `${s}\n${err}` : s);
  switch (c.state) {
    case STATES.sending:
      return words(`Sending ${out} to Ethereum`, 'Waiting for you to approve it in your BEAM wallet.', 'Sending', 'progress');
    case STATES.sent:
      return words('Sent: waiting for the BEAM network', 'It goes into the next BEAM blocks, usually within a minute or two.', 'Sending', 'progress');
    case STATES.confirmed:
      if (blocksLeft == null) return words('On its way to Ethereum', `The bridge pays your Ethereum wallet ${BEAM_CONFIRMATIONS} BEAM blocks after it was sent, about an hour.`, 'On its way', 'progress');
      if (blocksLeft > 0) {
        return words(
          `On its way: ${blocksText(blocksLeft)}`,
          `The bridge pays your Ethereum wallet after ${BEAM_CONFIRMATIONS} BEAM blocks (about one a minute). Nothing needs doing; you can close BEAM Campfire.`,
          `${blocksLeft} ${blocksLeft === 1 ? 'block' : 'blocks'} to go`,
          'progress',
        );
      }
      return words('Due now: the bridge is paying it', `It usually lands in your Ethereum wallet within minutes of the ${BEAM_CONFIRMATIONS}st block.`, 'Due now', 'progress');
    case STATES.waitingForGas:
      // Nothing for the person to do: said calmly, not as an alarm.
      return words(
        'Waiting for Ethereum gas to come down',
        'Ethereum costs more right now than the bridge fee you paid. The bridge retries about every 30 minutes and pays as soon as gas comes down to it. Your coins are safe; nothing needs doing.',
        'Waiting for gas',
        'progress',
      );
    case STATES.paid:
      return words(`${arrives} arrived in your Ethereum wallet`, null, 'Arrived', 'success');
    case STATES.failed:
      return words(err && /did not approve/.test(err) ? 'Not sent' : 'The BEAM transaction failed', err || 'Nothing left your wallet.', 'Not sent', 'error');
    case STATES.approving:
      return words(
        `Letting the bridge take your ${r.ethSymbol}`,
        `First an Ethereum transaction allows the bridge to take exactly ${coin(c.amount + c.relayerFee, r.ethDecimals, r.ethSymbol)}, then it is sent. Keep BEAM Campfire open for a minute.`,
        'Starting',
        'progress',
      );
    case STATES.locking:
      return words(`Sending ${out} to the bridge`, withError('Waiting for Ethereum, usually under a minute.'), 'Waiting for Ethereum', 'progress');
    case STATES.locked:
      return words('On its way to BEAM', 'Ethereum has it. The bridge brings it to BEAM, usually within 2 minutes; then you collect it.', 'On its way', 'progress');
    case STATES.notDeliveredYet:
      return words(
        'Taking longer than usual',
        `Sent to the bridge ${c.lockedAt ? ago(c.lockedAt, now) : 'over 30 minutes ago'}. The bridge is sometimes slow when it is busy; BEAM Campfire keeps looking. If you use this wallet on another device too, it may have been collected there.`,
        'Taking longer',
        'warning',
      );
    case STATES.delivered:
      return words(
        'Ready to collect',
        withError(`It is on BEAM. Collecting it is a BEAM transaction with a ${coin(c.beamNetworkFee, BEAM_DECIMALS, 'BEAM')} network fee.`),
        'Collect',
        err ? 'warning' : 'progress',
        true,
      );
    case STATES.claiming:
      return words(`Collecting ${arrives}`, withError('Waiting for the BEAM network, usually a minute or two.'), 'Collecting', 'progress');
    case STATES.claimed:
      return words(`${arrives} is in your BEAM wallet`, err, 'Arrived', 'success');
    case STATES.lockFailed:
      return words('Nothing was moved', err || `The bridge did not take your ${r.ethSymbol}.`, 'Not sent', 'error');
    case STATES.unknown:
      return words(
        "BEAM Campfire can't tell yet whether it was sent",
        withError(
          c.direction === DIRECTIONS.toEthereum
            ? 'Your BEAM wallet did not confirm sending it. Check its Activity before trying again: BEAM Campfire keeps looking for it and shows it here when it finds it.'
            : 'Ethereum did not confirm it. Check your Ethereum wallet before trying again: BEAM Campfire keeps looking for it on BEAM and shows it here when it arrives.',
        ),
        'Checking',
        'warning',
      );
    default:
      return words('Unknown state', null, '—', 'warning');
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
      step('Sent from your BEAM wallet', s === STATES.failed ? 'failed' : (s === STATES.sending || s === STATES.unknown) && !mined ? 'active' : 'done', at),
      step(mined && c.height != null ? `In BEAM block ${exact(BigInt(c.height), 0)}` : 'In a BEAM block', mined ? 'done' : s === STATES.sent ? 'active' : 'waiting'),
      step(`${BEAM_CONFIRMATIONS} BEAM blocks`, paid || due || gas ? 'done' : mined ? 'active' : 'waiting', mined && !due && !paid && !gas && blocksLeft != null ? `${blocksLeft} to go` : null),
      step('Paid to your Ethereum wallet', paid ? 'done' : due || gas ? 'active' : 'waiting', gas ? 'Waiting for gas' : null),
    ];
  }
  const locked = c.msgId !== null;
  const onBeam = s === STATES.delivered || s === STATES.claiming || s === STATES.claimed;
  const steps = [];
  if (c.approveHashes.length || s === STATES.approving) {
    steps.push(step(`Bridge allowed to take your ${routeById(c.route).ethSymbol}`, s === STATES.approving ? 'active' : s === STATES.lockFailed && !c.lockHash ? 'failed' : 'done', at));
  }
  steps.push(step('Sent to the bridge on Ethereum', s === STATES.lockFailed ? 'failed' : locked || onBeam ? 'done' : s === STATES.approving ? 'waiting' : 'active', steps.length ? null : at));
  steps.push(step('Brought to BEAM by the bridge', onBeam ? 'done' : locked ? 'active' : 'waiting'));
  steps.push(step('Collected in your BEAM wallet', s === STATES.claimed ? 'done' : onBeam ? 'active' : 'waiting', s === STATES.delivered ? 'Your turn' : null));
  return steps;
}

/** For a lock screen: where an open move is, with no amount and no address. */
export function lockedNote(c, { blocksLeft = null } = {}) {
  if (!c || !isOpen(c)) return null;
  const w = crossingWords(c, { blocksLeft });
  const where = c.direction === DIRECTIONS.toEthereum ? 'to Ethereum' : 'to BEAM';
  return w.needsYou ? `Your move ${where} is ready to collect.` : `Your move ${where} was at "${w.short}" when BEAM Campfire locked.`;
}
