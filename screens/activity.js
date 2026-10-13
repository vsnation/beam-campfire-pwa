/* Activity
 * Spec: ONE job: see every payment and what happened to it.
 *       Primary CTA: none on the list (tap a payment for details); empty list: "Receive BEAM".
 *       Taps from app open: 1 (tab), 2 for a payment's details.
 * Exit-intent reasons and answers:
 *   - "Is my payment stuck?" -> status in words, and for my own waiting payments a Cancel button;
 *     an arriving payment says the sender's wallet must be online to finish it.
 *   - "Proof it happened?" -> kernel ID (copyable), fee, both addresses, date.
 *   - "Nothing here" -> says why and offers Receive.
 *   - "I need it for my accountant" -> the download button at the top: every payment as a CSV file, as
 *     BEAM's wallets write it (lib/tx_csv.js). 2 taps: prepare, then save (a share sheet needs a fresh tap).
 */
import { h, shorten, fmtDate, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, openSheet, primary, secondary, notice, copyText } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet, txStatusText, isContractTx, contractMoves, contractLabel, contractStatusText, spentElsewhere } from '../lib/wallet.js';
import { spentElsewhereNotice } from './tx_status.js';
import { txRow } from './home.js';
import { splitDetail } from './coins_ui.js';
import { isSplitTx } from '../lib/coins.js';
import { noteRow, paymentExtras } from './payment_extras.js';
import { loadContacts } from '../lib/contacts.js';
import { buildCsv, csvFileName, readAllTxs, readProofs, isCsvPayment } from '../lib/tx_csv.js';
import { exportProof } from '../lib/payments.js';
import { deliverExport } from '../lib/export.js';
import { listWallets, nameOf } from '../lib/wallets.js';

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
      if (isContractTx(t)) return contractDetail(app, t, close, rerender);
      if (isSplitTx(t)) return splitDetail(app, t, close, (k, v, opts = {}) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), opts.copy ? h('button', { class: 'v mono btn-text', onclick: () => copyText(opts.copy, `${k} copied`), text: v }) : h('span', { class: 'v', text: v })));
      const unit = wallet.label(t.asset_id || 0).unit;
      const s = Number(t.status);
      const canCancel = !t.income && (s === 0 || s === 1);
      const kv = (k, v, opts = {}) => h('div', { class: 'kv', 'data-testid': opts.testid }, h('span', { class: 'k', text: k }), opts.copy ? h('button', { class: 'v mono btn-text', onclick: () => copyText(opts.copy, `${k} copied`), text: v }) : h('span', { class: `v${opts.mono ? ' mono' : ''}`, text: v }));
      const other = t.income ? t.sender : t.receiver;
      const msg = h('div');
      // An arriving payment: the sender's wallet finishes it (it puts it on the blockchain).
      const arriving = t.income && (s === 0 || s === 1 || s === 5);
      if (arriving)
        put(msg, h('div', { 'data-testid': 'tx-arriving-help' }, notice('info', s === 5
          ? "BEAM Campfire has accepted it. The sender's wallet now puts it on the blockchain, so it must be online. Paid from another app on this phone? Open that app again."
          : 'It finishes while both wallets are online: keep BEAM Campfire open.')));
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
          spentElsewhere(t) ? kv('Reason', 'Its coins were already spent elsewhere') : t.failure_reason ? kv('Reason', t.failure_reason) : null,
          noteRow(t, kv),
        ),
        spentElsewhere(t) ? spentElsewhereNotice(app, { onRescan: close }) : null,
        msg,
        ...paymentExtras(app, t, { close, rerender, msg }),
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
  // Contact names on the rows and in the details (sealed per wallet; read once per unlock).
  loadContacts(app).then(() => render(wallet.state), () => {});
  const csvBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Save payment history as a CSV file', 'data-testid': 'activity-csv', onclick: () => csvSheet(app) }, icon('download'));
  const el = screen({ title: 'Activity', tabs: 'activity', app, right: csvBtn }, listBox);
  return { el, destroy: () => off() };
}

/** Save the payment history as a CSV file (issue #51): prepare, then a fresh tap hands it out. */
function csvSheet(app) {
  openSheet((close) => {
    const msg = h('div', { 'data-testid': 'csv-msg' });
    const go = primary('Get my payment history', prepare, { 'data-testid': 'csv-prepare' });
    let busy = false;
    async function prepare() {
      if (busy) return;
      busy = true;
      go.disabled = true;
      try {
        if (!wallet.session) throw new Error('The wallet is still starting. Try again in a moment.');
        put(msg, notice('info', 'Reading your payments…'));
        const txs = await readAllTxs(wallet.session);
        const n = txs.filter(isCsvPayment).length;
        if (!n) {
          put(msg, notice('info', 'No payments to save yet. They show up here once you send or receive BEAM.'));
          return;
        }
        const proofs = await readProofs(wallet.session, txs, exportProof, (d, total) => put(msg, notice('info', `Adding payment proofs: ${d} of ${total}`)));
        let walletName = null;
        try {
          if ((await listWallets()).length > 1) walletName = nameOf(app.record);
        } catch {
          /* one wallet */
        }
        // A token's unit with its number: anyone can mint a token named BEAM.
        const text = buildCsv(txs, { unit: (id) => (id === 0 ? 'BEAM' : `${wallet.label(id).unit} #${id}`), proofs });
        const file = new File([text], csvFileName(new Date(), walletName), { type: 'text/csv' });
        put(
          msg,
          h('p', { class: 'lead', 'data-testid': 'csv-ready', text: `${n === 1 ? '1 payment' : `${n} payments`} in ${file.name}.` }),
          primary(
            'Save the file',
            async () => {
              const r = await deliverExport(file, { title: 'BEAM payment history' });
              if (r !== 'cancelled') close();
            },
            { 'data-testid': 'csv-save' },
          ),
        );
        go.remove();
      } catch (e) {
        put(msg, notice('error', `The file could not be made: ${e.message}`));
      } finally {
        busy = false;
        go.disabled = false;
      }
    }
    return [
      h('h2', { text: 'Save your payment history' }),
      h('p', { class: 'lead', text: "Every payment as a CSV file, the way BEAM's wallets write it. It opens in Excel, Numbers or Google Sheets." }),
      notice('warn', 'It lists amounts, addresses and comments: anyone who has the file can read them. It is made on this device and goes only where you save it.'),
      msg,
      go,
      h('button', { class: 'btn btn-text', type: 'button', onclick: () => close() }, 'Cancel'),
    ];
  }, { label: 'Save your payment history' });
}

/** A swap or other contract call: what left, what arrived, the fee, which app. */
function contractDetail(app, t, close, rerender) {
  const msg = h('div');
  const m = contractMoves(t);
  const kv = (k, v, opts = {}) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), opts.copy ? h('button', { class: 'v mono btn-text', onclick: () => copyText(opts.copy, `${k} copied`), text: v }) : h('span', { class: 'v', text: v }));
  const amt = (a) => `${formatAmount(a.amount)} ${wallet.label(a.assetId).unit}`;
  const head = m.receives[0] ? `+${amt(m.receives[0])}` : m.spends[0] ? `−${amt(m.spends[0])}` : `−${formatAmount(BigInt(t.fee || 0))} BEAM`;
  return [
    h('h2', { 'data-testid': 'tx-detail-title', text: contractLabel(t) }),
    h('div', { class: 'big-amount', text: head }),
    h(
      'div',
      { class: 'card' },
      kv('Status', contractStatusText(t)),
      kv('Date', fmtDate(t.create_time)),
      ...m.spends.map((a) => kv('You paid', amt(a))),
      ...m.receives.map((a) => kv('You got', amt(a))),
      kv('Network fee', `${formatAmount(BigInt(t.fee || 0))} BEAM`),
      t.appname ? kv('App', t.appname) : null,
      t.kernel && /[1-9a-f]/.test(t.kernel) ? kv('Kernel ID', shorten(t.kernel, 10, 8), { copy: t.kernel }) : null,
      t.confirmations != null ? kv('Confirmations', String(t.confirmations)) : null,
      spentElsewhere(t) ? kv('Reason', 'Its coins were already spent elsewhere') : t.failure_reason ? kv('Reason', t.failure_reason) : null,
    ),
    spentElsewhere(t) ? spentElsewhereNotice(app, { onRescan: close }) : null,
    msg,
    ...paymentExtras(app, t, { close, rerender, msg }),
    h('button', { class: 'btn btn-text', onclick: () => close() }, 'Close'),
  ];
}
