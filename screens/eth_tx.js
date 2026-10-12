/* Ethereum transaction status (right after sending; also any row of Ethereum activity)
 * Spec: ONE job: follow this payment until Ethereum has it.
 *       Primary CTA: "Done" (back to Ethereum Home); secondary: "View on Etherscan" (a link).
 *       Taps from app open: 5 after sending (Ethereum, Send, Send <amount>, Send <amount>, Face ID);
 *       2 from the activity list.
 * Exit-intent reasons and answers:
 *   - "Did it go through?" -> live status in words: waiting for Ethereum -> confirmed, with the block.
 *   - "It failed - is my money gone?" -> says what was spent (only the network fee) and that the
 *     amount stayed; "replaced" says plainly that nothing more will happen.
 *     "Replaced" only once the server showed the transaction that took its place (signed by this
 *     wallet: lib/eth/send.js), which is named here.
 *   - "Not sent - is that sure?" -> it is the server's word after half an hour of refusals, said as
 *     such, with Etherscan one tap away; BEAM Campfire asks for its receipt again whenever this screen
 *     or Ethereum Home opens, and a block in the history index outranks it (release audit BM-2).
 *   - "The server says it was replaced, but shows nothing" -> "Not sure yet": don't send it again
 *     yet (the first one may still go through and it would be paid twice); the same payment keeps
 *     being offered and checked; Etherscan is one tap to look for yourself.
 *   - "The server refused it - did it leave?" -> "Not sent yet": most likely not, but the server
 *     may have passed it on, so it is checked for half an hour before it says "Not sent".
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
import { amountText, ethText, ethMaxText, groupedAddress, notSentNotice, indexSaysNotice } from './eth_ui.js';

const FOLLOW_MS = 4000;

function texts(state, assetSym, { unsure = false, refused = false } = {}) {
  const open = state === 'signed' || state === 'pending';
  // The server says this payment's place was taken but cannot show by what: it may still go through.
  if (unsure && open)
    return { title: 'Not sure yet', icon: 'clock', cls: 'wait', kind: 'warn', note: "Don't send it again yet. Your Ethereum server says another transaction from this wallet took this payment's place, but it can't show that transaction, so this payment may still go through. The same payment (never a second one) keeps being offered, and this screen updates by itself." };
  // The server refused the bytes, but may have passed them on first.
  if (refused && state === 'signed')
    return { title: 'Not sent yet', icon: 'clock', cls: 'wait', kind: 'warn', note: "Don't send it again yet. Your Ethereum server refused this payment, so it has most likely not left, but it may have passed it on before refusing. BEAM Campfire keeps checking it, and offering the same payment (never a second one), for half an hour; if it never reaches Ethereum, this then says \"Not sent\"." };
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
      return { title: 'Replaced', icon: 'close', cls: 'bad', kind: 'info', note: 'Another transaction from this wallet, sent from this device or another one with the same words, took its place. This payment will not happen, and its amount did not leave.' };
    case 'rejected':
      // Said as the server's word, with Etherscan in the notice (render: notSentNotice).
      return { title: 'Not sent', icon: 'close', cls: 'bad', kind: 'error', note: '' };
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
    const t = texts(state, asset.symbol, { unsure: Boolean(entry && entry.unsureSince), refused: Boolean(entry && entry.refusedAt) });
    const title = !entry && item && item.direction === 'in' ? (state === 'failed' ? 'Failed' : `Received ${asset.symbol}`) : t.title;
    const own = entry ? entryFee(entry) : null;
    // Settled from the history index, its fee figures come from there until the receipt is read.
    const fee = own && (own.final || !(item && item.fee != null)) ? own : item && item.fee != null ? { wei: item.fee, final: true } : own;
    const block = entry && entry.receipt ? entry.receipt.blockNumber : item ? item.blockNumber : null;
    put(
      body,
      h('div', { class: `status-icon ${t.cls}` }, icon(t.icon)),
      h('h2', { class: 'title center', 'data-testid': 'eth-tx-title', 'data-state': state, 'data-unsure': entry && entry.unsureSince ? 'true' : null, 'data-refused': entry && entry.refusedAt && state === 'signed' ? 'true' : null, text: title }),
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
        entry && state === 'replaced' && entry.replacedBy ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Replaced by' }), h('button', { class: 'v mono btn-text', 'data-testid': 'eth-tx-replaced-by', 'data-hash': entry.replacedBy, onclick: () => copyText(entry.replacedBy, 'Transaction hash copied'), text: shorten(entry.replacedBy, 10, 8) })) : null,
      ),
      t.note && (entry || item) ? notice(t.kind, t.note) : null,
      // A verified "Replaced" the history index contradicts: its word beside it (RE2-5).
      entry && state === 'replaced' && w && w.indexSays(entry.hash) ? indexSaysNotice(w.indexSays(entry.hash), 'payment') : null,
      entry && state === 'rejected' ? notSentNotice(entry.hash) : null,
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
    // "Not sent" (or settled from the index without a receipt yet): its receipt is asked again, once.
    if (entry && !(entry.state === 'signed' || entry.state === 'pending') && (await w.recheckRejected({ hash: entry.hash }).catch(() => false)) && !dead) {
      entry = w.state.outbox.find((e) => e.hash === p.hash) || entry;
      render();
    }
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
