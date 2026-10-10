/* Activity
 * Spec: ONE job: see every payment and what happened to it.
 *       Primary CTA: none on the list (tap a payment for details); empty list: "Receive BEAM".
 *       Taps from app open: 1 (tab), 2 for a payment's details.
 * Exit-intent reasons and answers:
 *   - "Is my payment stuck?" -> status in words, and for my own waiting payments a Cancel button.
 *   - "Proof it happened?" -> kernel ID (copyable), fee, both addresses, date.
 *   - "Nothing here" -> says why and offers Receive.
 */
import { h, shorten, fmtDate, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, openSheet, primary, secondary, notice, copyText } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet, txStatusText, isContractTx, contractMoves } from '../lib/wallet.js';
import { txRow } from './home.js';

export default function activity(app, params = {}) {
  const listBox = h('div');
  let opened = false;

  function render(s) {
    const txs = s.txs;
    put(listBox, 
      txs.length
        ? h('div', { class: 'card list', 'data-testid': 'activity-list' }, ...txs.map((t) => txRow(app, t, () => detail(t.txId))))
        : h('div', { class: 'card empty' }, icon('activity'), h('p', { text: s.status ? 'No payments yet.' : 'Payments show up here once the wallet is up to date.' }), primary('Receive BEAM', () => app.go('receive'))),
    );
    if (params.txId && !opened && txs.some((t) => t.txId === params.txId)) {
      opened = true;
      detail(params.txId);
    }
  }

  function detail(txId) {
    openSheet((close, rerender) => {
      const t = wallet.state.txs.find((x) => x.txId === txId);
      if (!t) return [h('h2', { text: 'Payment' }), h('p', { text: 'This payment is no longer in the list.' })];
      if (isContractTx(t)) return contractDetail(t, close);
      const unit = wallet.label(t.asset_id || 0).unit;
      const s = Number(t.status);
      const canCancel = !t.income && (s === 0 || s === 1);
      const kv = (k, v, opts = {}) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), opts.copy ? h('button', { class: 'v mono btn-text', onclick: () => copyText(opts.copy, `${k} copied`), text: v }) : h('span', { class: `v${opts.mono ? ' mono' : ''}`, text: v }));
      const other = t.income ? t.sender : t.receiver;
      const msg = h('div');
      return [
        h('h2', { 'data-testid': 'tx-detail-title', text: txStatusText(t) }),
        h('div', { class: 'big-amount', text: `${t.income ? '+' : '−'}${formatAmount(BigInt(t.value || 0))} ${unit}` }),
        h(
          'div',
          { class: 'card' },
          kv('Status', t.status_string ? `${txStatusText(t)}` : txStatusText(t)),
          kv('Date', fmtDate(t.create_time)),
          t.income ? null : kv('Network fee', `${formatAmount(BigInt(t.fee || 0))} BEAM`),
          other ? kv(t.income ? 'From' : 'To', shorten(other, 10, 8), { copy: other }) : null,
          t.kernel && /[1-9a-f]/.test(t.kernel) ? kv('Kernel ID', shorten(t.kernel, 10, 8), { copy: t.kernel }) : null,
          t.confirmations != null ? kv('Confirmations', String(t.confirmations)) : null,
          t.failure_reason ? kv('Reason', t.failure_reason) : null,
          t.comment ? kv('Note', t.comment) : null,
        ),
        msg,
        canCancel
          ? secondary('Cancel payment', async () => {
              try {
                await wallet.cancelTx(t.txId);
                rerender();
              } catch (e) {
                put(msg, notice('error', `It could not be cancelled: ${e.message}. It may already be on its way.`));
              }
            }, { 'data-testid': 'detail-cancel' })
          : null,
        h('button', { class: 'btn btn-text', onclick: () => close() }, 'Close'),
      ];
    }, { label: 'Payment details' });
  }

  const off = wallet.onChange(render);
  render(wallet.state);
  wallet.refreshTxs();
  const el = screen({ title: 'Activity', tabs: 'activity', app }, listBox);
  return { el, destroy: () => off() };
}

/** A swap or other contract call: what left, what arrived, the fee, which app. */
function contractDetail(t, close) {
  const m = contractMoves(t);
  const kv = (k, v, opts = {}) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), opts.copy ? h('button', { class: 'v mono btn-text', onclick: () => copyText(opts.copy, `${k} copied`), text: v }) : h('span', { class: 'v', text: v }));
  const amt = (a) => `${formatAmount(a.amount)} ${wallet.label(a.assetId).unit}`;
  const head = m.receives[0] ? `+${amt(m.receives[0])}` : m.spends[0] ? `−${amt(m.spends[0])}` : `−${formatAmount(BigInt(t.fee || 0))} BEAM`;
  return [
    h('h2', { 'data-testid': 'tx-detail-title', text: txStatusText(t) }),
    h('div', { class: 'big-amount', text: head }),
    h(
      'div',
      { class: 'card' },
      kv('Status', txStatusText(t)),
      kv('Date', fmtDate(t.create_time)),
      ...m.spends.map((a) => kv('You paid', amt(a))),
      ...m.receives.map((a) => kv('You got', amt(a))),
      kv('Network fee', `${formatAmount(BigInt(t.fee || 0))} BEAM`),
      t.appname ? kv('App', t.appname) : null,
      t.kernel && /[1-9a-f]/.test(t.kernel) ? kv('Kernel ID', shorten(t.kernel, 10, 8), { copy: t.kernel }) : null,
      t.confirmations != null ? kv('Confirmations', String(t.confirmations)) : null,
      t.failure_reason ? kv('Reason', t.failure_reason) : null,
    ),
    h('button', { class: 'btn btn-text', onclick: () => close() }, 'Close'),
  ];
}
