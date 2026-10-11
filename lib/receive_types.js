// "More ways to receive": offline, max-privacy and public addresses. A port of BEAM
// Campfire's lib/widgets/beam/receive/beam_more_ways.dart, beam_private_receive.dart and
// beam_receive_text.dart, for the web wallet. Pure, except makePrivateAddress at the end.
//
// BEAM's engine makes these addresses only when the wallet can find payments to them itself
// (Wallet::CanDetectCoins: an owned node online, or block-body requests on). Measured on
// mainnet 2026-10-11 (docs/beam/TEST_LOG.md): a new web wallet (no block scanning) is refused
// with -32005; a restored or rescanned one (scanning on) makes them, and a max-privacy payment
// arrived as a private coin. So the gate decides from that evidence, and the types are always
// listed: while the wallet cannot see such payments they are shown off, with what turns them
// on, never offered anyway (an address whose payments the wallet never sees is a lost payment).

import { OFFLINE_FEE, formatAmount } from './amount.js';
import { PRIVATE_LIMIT_HOURS } from './coins.js';

export const PRIVATE_TYPES = Object.freeze(['offline', 'max_privacy', 'public_offline']);

const FEE = `${formatAmount(OFFLINE_FEE)} BEAM`;

/** Title of an address type, as a person would say it (BeamReceiveText.typeTitle). */
export function typeTitle(type) {
  switch (type) {
    case 'offline':
      return 'Offline address';
    case 'max_privacy':
      return 'Max privacy address';
    case 'public_offline':
      return 'Public address';
    case 'regular_new':
      return 'Regular address (with payment proof)';
    case 'regular':
      return 'Regular address';
    default:
      return 'Other address';
  }
}

/**
 * What the address does for the person being paid: that they can be offline, when the money
 * can be spent, and the fee the sender pays (BeamReceiveText.typeExplainer, with the fee and
 * the wait said, which the app leaves to the sender's screen).
 */
export function typeExplainer(type) {
  switch (type) {
    case 'offline':
      return `Works while your wallet is closed. Good for one payment. The sender pays a higher network fee (${FEE}).`;
    case 'max_privacy':
      return `Hides the payment among many others, and works while your wallet is closed. You can spend it after up to ${PRIVATE_LIMIT_HOURS} hours. Use it once. The sender pays ${FEE}.`;
    case 'public_offline':
      return `Safe to post publicly: payments arrive even while your wallet is closed. The sender pays ${FEE}.`;
    default:
      return "The sender's wallet and yours must both be online to finish the payment.";
  }
}

export const MORE_WAYS = Object.freeze({
  title: 'More ways to receive',
  hint: 'Get paid while your wallet is closed, or more privately',
  making: 'Making your address…',
  blockedTitle: 'Your wallet needs to watch the blockchain for these',
  rescan: 'Rescan',
  ownNode: 'Use your own node',
  ownerKey: 'Show owner key',
});

/**
 * Whether this wallet may offer offline, max-privacy and public addresses (BeamPrivateReceive).
 * {available: true} or {available: false, block}:
 *   - 'connecting': the wallet is not running yet;
 *   - 'importing': it is still reading BEAM's snapshot;
 *   - 'ownNodeConnecting': on the person's own node, which has not answered yet;
 *   - 'ownNodeNoKey': on the own node, which does not hold this wallet's owner key;
 *   - 'noScan': a random BEAM node and no block scanning (a new wallet that never rescanned).
 * s: the wallet's state (lib/wallet.js): running, importing, scanning, nodeMode, nodeConnected, connEvent.
 */
export function privateReceiveGate(s) {
  if (!s || !s.running) return { available: false, block: 'connecting' };
  if (s.importing) return { available: false, block: 'importing' };
  if (s.scanning) return { available: true, block: null };
  if (s.nodeMode === 'own') {
    if (s.connEvent && s.connEvent.own_node === true) return { available: true, block: null };
    if (!s.nodeConnected) return { available: false, block: 'ownNodeConnecting' };
    return { available: false, block: 'ownNodeNoKey' };
  }
  return { available: false, block: 'noScan' };
}

/**
 * Why they are off, and what turns them on: {reason, actions}. actions name the screens that
 * help: 'rescan' (Settings -> Rescan), 'ownNode' (your own node), 'ownerKey' (Show owner key).
 */
export function blockedReason(gate) {
  switch (gate && gate.block) {
    case null:
    case undefined:
      return { reason: '', actions: [] };
    case 'connecting':
      return { reason: 'The wallet is still starting. These options appear in a moment.', actions: [] };
    case 'importing':
      return { reason: 'The wallet is still getting ready. These options appear once it has finished.', actions: [] };
    case 'ownNodeConnecting':
      return { reason: "Your node hasn't answered yet. These open once it does, if it holds this wallet's owner key.", actions: [] };
    case 'ownNodeNoKey':
      return {
        reason: "Your node doesn't hold this wallet's owner key, so it can't find these payments for you. Give it the key, or let this wallet check every block itself with Rescan.",
        actions: ['ownerKey', 'rescan'],
      };
    default:
      return {
        reason: `This wallet finds payments to these only by checking every block itself. Rescan turns that on: it downloads BEAM's snapshot once (about 330 MB), then keeps watching. Or use your own BEAM node that holds this wallet's owner key.`,
        actions: ['rescan', 'ownNode'],
      };
  }
}

/** What went wrong making an address, in words that never blame the person, with the fix (BeamReceiveText.error). */
export function receiveErrorText(e) {
  const rpc = e && e.rpc;
  if (rpc && Number(rpc.code) === -32005) return "This wallet can't watch for these payments right now, so the address wasn't made. Settings → Rescan turns that on; your regular address above works meanwhile.";
  if (e && e.code === 'timeout') return 'The wallet is slow to answer. Try again in a moment.';
  if (e && e.code === 'stopped') return 'The wallet was locked. Unlock it and try again.';
  return 'The wallet could not make that address just now. Try again in a moment.';
}

/**
 * The address of a private type, ready to give out. Max privacy and offline addresses are made
 * new each time (each is good for one payment, and a fresh one does not link two payers); a
 * public address is reused. An offline address carries one payment (offline_payments: 1, as the
 * app passes it; more makes it too long for a QR code; measured: 451 characters). Throws the
 * engine's error (-32005 when the wallet cannot watch).
 */
export async function makePrivateAddress(session, type) {
  if (!PRIVATE_TYPES.includes(type)) throw new Error(`not a private address type: ${type}`);
  if (type === 'public_offline') {
    const list = await session.call('addr_list', { own: true }, { timeoutMs: 20000 });
    const existing = (Array.isArray(list) ? list : []).filter((a) => a && a.own !== false && !a.expired && a.type === 'public_offline');
    if (existing.length) return { address: existing[0].address, reused: true };
  }
  const params = { type, expiration: type === 'public_offline' ? 'never' : 'auto' };
  if (type === 'offline') params.offline_payments = 1;
  const address = await session.call('create_address', params, { timeoutMs: 30000 });
  return { address, reused: false };
}
