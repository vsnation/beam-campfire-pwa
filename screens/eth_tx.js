/* Ethereum transaction status (right after sending; also any row of Ethereum activity)
 * Spec: ONE job: follow this payment until Ethereum has it.
 *       Primary CTA: "Done" (back to Ethereum Home); secondary: "View on Etherscan" (a link).
 *       Taps from app open: 5 after sending (Ethereum, Send, Send <amount>, Send <amount>, Face ID);
 *       2 from the activity list.
 * Exit-intent reasons and answers:
 *   - "Did it go through?" -> live status in words: waiting for Ethereum -> confirmed, with the block.
 *   - "It failed - is my money gone?" -> says what was spent (only the network fee) and that the
 *     amount stayed; "replaced" and "not sent" say plainly that nothing more will happen.
 *   - "The app lost signal while sending" -> it was saved before sending; the same bytes go again by
 *     themselves, never a second payment.
 *   - "Can I check elsewhere?" -> the hash copies with a tap, and Etherscan is one tap.
 */
import { h, put, shorten, fmtDate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, copyText } from '../lib/ui.js';
import { ethWallet } from '../lib/eth/wallet.js';
import { entryFee } from '../lib/eth/send.js';
import { txExplorerUrl } from '../lib/eth/hosts.js';
import { tokenBySymbol, ETH } from '../lib/eth/tokens.js';
import { amountText, ethText, ethMaxText, groupedAddress } from './eth_ui.js';

const FOLLOW_MS = 4000;

function texts(state, assetSym) {
  switch (state) {
    case 'signed':
      return { title: 'Sending', icon: 'clock', cls: 'wait', kind: 'info', note: 'Saved on this device and being handed to Ethereum. If the connection drops, the same payment is sent again by itself - never twice.' };
    case 'pending':
      return { title: 'Waiting for Ethereum', icon: 'clock', cls: 'wait', kind: 'info', note: 'On its way. Ethereum usually takes it into a block within a minute. You can leave this screen; it carries on without the app.' };
    case 'confirmed':
      return { title: 'Payment confirmed', icon: 'check', cls: 'ok', kind: 'success', note: 'Ethereum has it in a block. It cannot be undone.' };
    case 'failed':
      return { title: 'Payment failed', icon: 'close', cls: 'bad', kind: 'error', note: `Ethereum refused it, so no ${assetSym} was sent. Only the network fee was spent.` };
    case 'replaced':
      return { title: 'Replaced', icon: 'close', cls: 'bad', kind: 'info', note: 'Another transaction from this wallet, sent from another device with the same words, took its place. This payment will not happen, and its amount did not leave.' };
    case 'rejected':
      return { title: 'Not sent', icon: 'close', cls: 'bad', kind: 'error', note: "Ethereum's server refused it, so it never left. Nothing was spent." };
    default:
      return { title: 'Payment', icon: 'clock', cls: 'wait', kind: 'info', note: '' };
  }
}

export default function ethTx(app, p = {}) {
  const body = h('div', { class: 'stack' });
  let w = null;
  let entry = null;
  let dead = false;

  function render() {
    if (dead) return;
    // A row from the history index (not sent from this device): show what the index said.
    const item = p.item || null;
    const state = entry ? entry.state : item ? item.state : 'pending';
    const asset = entry ? (entry.token ? tokenBySymbol(entry.asset) : ETH) : item ? item.asset : ETH;
    const amount = entry ? BigInt(entry.amount) : item ? item.amount : 0n;
    const to = entry ? entry.to : item && item.direction !== 'in' ? item.counterparty : null;
    const from = !entry && item && item.direction === 'in' ? item.counterparty : null;
    const t = texts(state, asset.symbol);
    const title = !entry && item && item.direction === 'in' ? (state === 'failed' ? 'Failed' : `Received ${asset.symbol}`) : t.title;
    const fee = entry ? entryFee(entry) : item && item.fee != null ? { wei: item.fee, final: true } : null;
    const block = entry && entry.receipt ? entry.receipt.blockNumber : item ? item.blockNumber : null;
    put(
      body,
      h('div', { class: `status-icon ${t.cls}` }, icon(t.icon)),
      h('h2', { class: 'title center', 'data-testid': 'eth-tx-title', 'data-state': state, text: title }),
      h('div', { class: 'big-amount', 'data-testid': 'eth-tx-amount', text: amountText(amount, asset) }),
      h(
        'div',
        { class: 'card' },
        to ? h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: 'To' }), h('span', { class: 'v mono addr-groups', text: groupedAddress(to.startsWith('0x') ? to : `0x${to}`) })) : null,
        from ? h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: 'From' }), h('span', { class: 'v mono addr-groups', text: groupedAddress(from) })) : null,
        fee ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'eth-tx-fee', 'data-wei': String(fee.wei), text: fee.final ? ethText(fee.wei) : `at most ${ethMaxText(fee.wei)}` })) : null,
        block ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Block' }), h('span', { class: 'v', 'data-testid': 'eth-tx-block', text: block.toLocaleString('en-US') })) : null,
        entry ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Sent' }), h('span', { class: 'v', text: fmtDate(Math.floor(entry.createdAt / 1000)) })) : null,
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Transaction' }), h('button', { class: 'v mono btn-text', 'data-testid': 'eth-tx-hash', 'data-hash': p.hash, onclick: () => copyText(p.hash, 'Transaction hash copied'), text: shorten(p.hash, 10, 8) })),
      ),
      t.note && (entry || item) ? notice(t.kind, t.note) : null,
      entry && entry.error && (state === 'signed' || state === 'rejected') ? h('p', { class: 'small', 'data-testid': 'eth-tx-error', text: `The server said: ${entry.error}` }) : null,
    );
  }

  async function follow() {
    if (dead || !w || !entry || document.visibilityState !== 'visible' || !app.dbPass) return;
    if (entry.state !== 'signed' && entry.state !== 'pending') return;
    try {
      await w.followOpen();
      entry = w.state.outbox.find((e) => e.hash === p.hash) || entry;
      render();
    } catch {
      /* the next look tries again */
    }
  }

  // Receipts only while this screen is visible and the wallet unlocked.
  const timer = setInterval(follow, FOLLOW_MS);
  const onVis = () => follow();
  document.addEventListener('visibilitychange', onVis);

  (async () => {
    w = await ethWallet(app).catch(() => null);
    if (!w || dead) return w ? null : app.go('ethHome');
    entry = w.state.outbox.find((e) => e.hash === p.hash) || null;
    render();
    follow();
  })();
  render();

  const link = /^0x[0-9a-fA-F]{64}$/.test(p.hash || '') ? h('a', { class: 'btn btn-text', href: txExplorerUrl(p.hash), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'eth-tx-explorer' }, icon('external'), 'View on Etherscan') : null;
  const el = screen({ title: 'Ethereum payment', back: () => app.back('ethHome'), actions: [primary('Done', () => app.go('ethHome'), { 'data-testid': 'eth-tx-done' }), link] }, body);
  return {
    el,
    destroy() {
      dead = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
