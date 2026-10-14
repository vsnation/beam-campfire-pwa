/* A payment's details: what else can be done with it (below Activity's details card)
 * Spec: ONE job of the details stays "see exactly what happened"; these are its secondary actions:
 *       the saved contact (or "Save to contacts"), the explorer link, the payment proof, and
 *       removing a finished record. None is dominant (the desktop's BeamTxDetails: proof and
 *       removal are secondary).
 *       Taps from app open: 2 to a payment (Activity -> payment), 3 for any of these.
 * Exit-intent reasons and answers:
 *   - "How do I prove I paid?" -> "Get payment proof" on a completed payment I sent; the proof
 *     sheet says what it shows (and nothing else).
 *   - "Someone sent me a proof" -> "Check a payment proof" on a payment I received.
 *   - "Is it really on the blockchain?" -> the explorer link, a plain link the person taps; the
 *     app fetches nothing from the explorer.
 *   - "Did removing it lose money?" -> the confirmation says nothing changes on the blockchain.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openSheet, primary, secondary, textButton, notice, copyText, toast } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { txNote, canDeleteTx, canExportProof, canCheckProof, explorerUrl, exportProof, deleteTx, short, PROOF_TEXT, REMOVE_TEXT, EXPLORER_NOTE } from '../lib/payments.js';
import { contactNameFor, looksLikeAddress } from '../lib/contacts.js';
import { contactForm } from './contacts.js';
import { t } from '../lib/i18n.js';

/** The Note row of a payment (or the receiving address's label), for the details card. */
export function noteRow(tx, kv) {
  const n = txNote(tx);
  return n ? kv(n.label, n.text, { testid: 'tx-note' }) : null;
}

/** "Sent · Alice · Rent": what a list row says under its title, past the date. */
export function rowExtra(tx) {
  const other = tx.income ? tx.sender : tx.receiver;
  const name = other ? contactNameFor(other) : null;
  const n = txNote(tx);
  // A note the person wrote (a sent payment's), never a received one's address label.
  return [name, n && !tx.income ? n.text : null].filter(Boolean).join(' · ');
}

/**
 * The extras under a payment's details card. ctx: {close, rerender, msg} of the
 * sheet. Contract calls get the explorer and removal only.
 */
export function paymentExtras(app, tx, { close, msg }) {
  const out = [];
  const contract = Number(tx.tx_type) === 12;
  if (canExportProof(tx)) {
    const b = secondary(h('span', {}, t('Get payment proof')), () => getProof(b, tx, msg), { 'data-testid': 'tx-get-proof' });
    b.prepend(icon('proof'));
    out.push(b);
  }
  const url = explorerUrl(tx.kernel);
  if (url) {
    out.push(
      h('div', { class: 'explorer-link' }, h('a', { class: 'btn btn-text', href: url, target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'tx-explorer' }, icon('external'), t('See it on the BEAM explorer')), h('p', { class: 'small center', text: t(EXPLORER_NOTE) })),
    );
  }
  const other = contract ? null : tx.income ? tx.sender : tx.receiver;
  if (other && looksLikeAddress(other)) {
    const name = contactNameFor(other);
    out.push(
      name
        ? h('p', { class: 'small center', 'data-testid': 'tx-contact' }, icon('person', 'inline-icon'), ` ${tx.income ? t('From your contact {name}', { name }) : t('To your contact {name}', { name })}`)
        : textButton(h('span', {}, t('Save to contacts')), () => {
            contactForm(app, {
              address: other,
              from: tx.income ? t('The address their wallet paid from. It can expire: if a payment to it fails, ask them for a new one.') : null,
            }).then((c) => c && close());
          }, { 'data-testid': 'tx-save-contact' }),
    );
  }
  if (canCheckProof(tx))
    out.push(
      textButton(t('Check a payment proof'), () => {
        close();
        app.go('checkProof');
      }, { 'data-testid': 'tx-check-proof' }),
    );
  if (canDeleteTx(tx)) out.push(textButton(t(REMOVE_TEXT.confirm), () => confirmRemove(tx, close), { class: 'btn btn-text danger', 'data-testid': 'tx-remove' }));
  return out;
}

async function getProof(btn, tx, msg) {
  const span = btn.querySelector('span');
  const label = span.textContent;
  btn.disabled = true;
  span.textContent = t('Getting the proof…');
  put(msg);
  try {
    if (!wallet.session) throw Object.assign(new Error(t(PROOF_TEXT.notConnected)), { code: 'stopped' });
    const proof = await exportProof(wallet.session, tx.txId);
    if (!proof) return put(msg, h('div', { 'data-testid': 'tx-no-proof' }, notice('info', t(PROOF_TEXT.none))));
    showProof(proof);
  } catch (e) {
    put(msg, notice('error', e.code === 'rpc' ? t(PROOF_TEXT.none) : t(PROOF_TEXT.notConnected)));
  } finally {
    btn.disabled = false;
    span.textContent = label;
  }
}

/** The proof, to copy or share (the desktop's BeamProofExportDialog). */
export function showProof(proof) {
  const canShare = typeof navigator.share === 'function';
  openSheet(
    (close) => [
      h('h2', { text: t('Payment proof') }),
      h('p', { class: 'lead', text: t(PROOF_TEXT.exportIntro) }),
      h('div', { class: 'address-box' }, h('p', { class: 'mono', 'data-testid': 'proof-text', 'data-proof': proof, text: short(proof, 24, 24) })),
      primary(h('span', {}, t('Copy proof')), () => copyText(proof, t('Proof copied')), { 'data-testid': 'proof-copy' }),
      canShare
        ? secondary(h('span', {}, t('Share')), async () => {
            try {
              await navigator.share({ text: proof });
            } catch (e) {
              if (e && e.name !== 'AbortError') copyText(proof, t('Proof copied'));
            }
          }, { 'data-testid': 'proof-share' })
        : null,
      textButton(t('Done'), () => close(), { 'data-testid': 'proof-done' }),
    ],
    { label: t('Payment proof') },
  );
}

function confirmRemove(tx, closeDetails) {
  const proofToo = canExportProof(tx);
  const msg = h('div', { class: 'pay-msg' });
  const sheet = openSheet(
    () => [
      h('h2', { text: t(REMOVE_TEXT.title) }),
      h('p', { class: 'lead', text: t(REMOVE_TEXT.body) }),
      proofToo ? notice('info', t(REMOVE_TEXT.proofToo)) : null,
      msg,
      h('button', {
        class: 'btn btn-danger',
        'data-testid': 'tx-remove-confirm',
        onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try {
            if (!wallet.session) throw new Error(t(PROOF_TEXT.notConnected));
            await deleteTx(wallet.session, tx.txId);
            await wallet.persistNow();
            await wallet.refreshTxs();
            sheet.close(true);
            closeDetails();
            toast(t(REMOVE_TEXT.done));
          } catch (err) {
            b.disabled = false;
            put(msg, notice('error', err.code === 'rpc' ? t(REMOVE_TEXT.refused) : t("It wasn't removed: {reason}", { reason: err.message })));
          }
        },
      }, t(REMOVE_TEXT.confirm)),
      textButton(t(REMOVE_TEXT.keep), () => sheet.close(false), { 'data-testid': 'tx-remove-keep' }),
    ],
    { label: t(REMOVE_TEXT.title) },
  );
}
