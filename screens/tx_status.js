/* Payment status (and swap status)
 * Spec: ONE job: follow this payment (or swap) until it is done.
 *       Primary CTA: "Done" (secondary while waiting: "Cancel payment"; a swap cannot be cancelled).
 *       Taps from app open: 3 (right after confirming a payment or approving a swap).
 * Exit-intent reasons and answers:
 *   - "Did it go through?" -> live status in words: waiting for receiver -> sending -> sent / failed.
 *   - "It's taking long" -> explains the receiver must be online, and that the app must stay open.
 *   - "It failed - did I lose money?" -> says the plain reason and that the money stayed.
 */
import { h, shorten, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, copyText } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet, txStatusText, contractMoves } from '../lib/wallet.js';

export default function txStatus(app, p) {
  if (p && p.kind === 'swap') return swapStatus(app, p);
  const body = h('div', { class: 'content' });
  const actions = h('div', { class: 'actions' });
  let tx = null;
  let cancelling = false;

  function render() {
    const s = tx ? Number(tx.status) : 0;
    const done = s === 3;
    const failed = s === 4 || s === 2;
    const unit = wallet.label(p.assetId || 0).unit;
    const title = tx ? txStatusText(tx) : 'Sending';
    put(body, 
      h('div', { class: `status-icon ${done ? 'ok' : failed ? 'bad' : 'wait'}` }, icon(done ? 'check' : failed ? 'close' : 'clock')),
      h('h2', { class: 'title center', 'data-testid': 'tx-title', 'data-status': String(s), text: done ? 'Payment sent' : failed ? (s === 2 ? 'Payment cancelled' : 'Payment failed') : title }),
      h('div', { class: 'big-amount', text: `${formatAmount(p.amount)} ${unit}` }),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'To' }), h('span', { class: 'v mono', text: shorten(p.address, 10, 8) })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', text: `${formatAmount(p.fee)} BEAM` })),
        tx && tx.kernel && /[1-9a-f]/.test(tx.kernel)
          ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Kernel ID' }), h('button', { class: 'v mono btn-text', 'data-testid': 'tx-kernel', onclick: () => copyText(tx.kernel, 'Kernel ID copied'), text: shorten(tx.kernel, 10, 8) }))
          : null,
      ),
      done
        ? notice('success', p.name ? `It is on the blockchain, waiting in BEAM's name vault for the owner of ${p.name}.beam to claim.` : 'The receiver accepted the payment and it is on the blockchain.')
        : failed
          ? notice(s === 2 ? 'info' : 'error', s === 2 ? 'Nothing was sent. The money stays in your wallet.' : `${tx.failure_reason || 'The payment did not go through.'} The money stays in your wallet.`)
          : notice('info', p.mustBeOnline === false ? 'The payment is on its way to the blockchain.' : "Waiting for the receiver's wallet to come online and accept. Keep BEAM Campfire open; this can take up to 12 hours."),
    );
    const canCancel = tx && (s === 0 || s === 1) && !tx.income && !cancelling;
    put(actions, primary('Done', () => app.go('home'), { 'data-testid': 'tx-done' }), canCancel ? secondary('Cancel payment', cancel, { 'data-testid': 'tx-cancel' }) : null);
  }

  async function cancel() {
    cancelling = true;
    render();
    try {
      await wallet.cancelTx(p.txId);
    } catch (e) {
      body.appendChild(notice('error', `It could not be cancelled: ${e.message}. It may already be on its way.`));
    }
    cancelling = false;
    poll();
  }

  async function poll() {
    try {
      tx = await wallet.txStatus(p.txId);
      render();
    } catch {
      /* keep the last state */
    }
  }

  const timer = setInterval(poll, 3000);
  const off = wallet.onChange(() => {
    const t = wallet.state.txs.find((x) => x.txId === p.txId);
    if (t) {
      tx = { ...tx, ...t };
      render();
    }
  });
  render();
  poll();

  const el = h('main', { class: 'screen' }, h('header', { class: 'topbar' }, h('h1', { text: 'Payment' })), body, actions);
  return {
    el,
    destroy() {
      clearInterval(timer);
      off();
    },
  };
}

/** A swap on its way: what was paid, what arrives, until the blockchain has it. */
function swapStatus(app, p) {
  const body = h('div', { class: 'content' });
  const actions = h('div', { class: 'actions' });
  let tx = null;

  function render() {
    const s = tx ? Number(tx.status) : 1;
    const done = s === 3;
    const failed = s === 4 || s === 2;
    const moved = tx ? contractMoves(tx) : null;
    const got = moved && moved.receives.find((r) => r.assetId === p.receive.assetId);
    const paid = moved && moved.spends.find((r) => r.assetId === p.pay.assetId);
    const payAmt = paid ? paid.amount : p.pay.amount;
    const getAmt = got ? got.amount : p.receive.amount;
    const payU = wallet.label(p.pay.assetId).unit;
    const getU = wallet.label(p.receive.assetId).unit;
    const approx = done && got ? '' : '≈ ';
    put(
      body,
      h('div', { class: `status-icon ${done ? 'ok' : failed ? 'bad' : 'wait'}` }, icon(done ? 'check' : failed ? 'close' : 'swap')),
      h('h2', { class: 'title center', 'data-testid': 'tx-title', 'data-status': String(s), text: done ? 'Swap complete' : failed ? (s === 2 ? 'Swap cancelled' : 'Swap failed') : 'Swapping' }),
      h('div', { class: 'big-amount swap-amounts' }, h('span', { text: `${formatAmount(payAmt)} ${payU}` }), h('span', { class: 'arrow', text: '→' }), h('span', { text: `${approx}${formatAmount(getAmt)} ${getU}` })),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'You pay' }), h('span', { class: 'v', text: `${formatAmount(payAmt)} ${payU}` })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: done ? 'You got' : 'You get' }), h('span', { class: 'v', 'data-testid': 'tx-receive', text: `${approx}${formatAmount(getAmt)} ${getU}` })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', text: `${formatAmount(tx && tx.fee != null ? BigInt(tx.fee) : p.fee)} BEAM` })),
        tx && tx.kernel && /[1-9a-f]/.test(tx.kernel)
          ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Kernel ID' }), h('button', { class: 'v mono btn-text', 'data-testid': 'tx-kernel', onclick: () => copyText(tx.kernel, 'Kernel ID copied'), text: shorten(tx.kernel, 10, 8) }))
          : null,
      ),
      done
        ? notice('success', 'The swap is on the blockchain. Your new balance is on the Wallet tab.')
        : failed
          ? notice(s === 2 ? 'info' : 'error', `${s === 4 && tx.failure_reason ? tx.failure_reason + '. ' : ''}Nothing was swapped. Your ${payU} stays in your wallet.`)
          : notice('info', 'On its way to the blockchain. This usually takes a minute or two; keep BEAM Campfire open until it is done.'),
    );
    put(actions, primary('Done', () => app.go('home'), { 'data-testid': 'tx-done' }));
  }

  async function poll() {
    try {
      const t = await wallet.txStatus(p.txId);
      tx = { ...(wallet.state.txs.find((x) => x.txId === p.txId) || {}), ...t };
      render();
    } catch {
      /* keep the last state */
    }
  }

  const timer = setInterval(poll, 3000);
  const off = wallet.onChange(() => {
    const t = wallet.state.txs.find((x) => x.txId === p.txId);
    if (t) {
      tx = { ...tx, ...t };
      render();
    }
  });
  render();
  poll();
  const el = h('main', { class: 'screen' }, h('header', { class: 'topbar' }, h('h1', { text: 'Swap' })), body, actions);
  return {
    el,
    destroy() {
      clearInterval(timer);
      off();
    },
  };
}
