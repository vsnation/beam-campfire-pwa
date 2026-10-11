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

/** The Note row of a payment (or the receiving address's label), for the details card. */
export function noteRow(t, kv) {
  const n = txNote(t);
  return n ? kv(n.label, n.text, { testid: 'tx-note' }) : null;
}

/** "Sent · Alice · Rent": what a list row says under its title, past the date. */
export function rowExtra(t) {
  const other = t.income ? t.sender : t.receiver;
  const name = other ? contactNameFor(other) : null;
  const n = txNote(t);
  return [name, n && n.label === 'Note' ? n.text : null].filter(Boolean).join(' · ');
}

/**
 * The extras under a payment's details card. ctx: {close, rerender, msg} of the
 * sheet. Contract calls get the explorer and removal only.
 */
export function paymentExtras(app, t, { close, msg }) {
  const out = [];
  const contract = Number(t.tx_type) === 12;
  if (canExportProof(t)) {
    const b = secondary(h('span', {}, 'Get payment proof'), () => getProof(b, t, msg), { 'data-testid': 'tx-get-proof' });
    b.prepend(icon('proof'));
    out.push(b);
  }
  const url = explorerUrl(t.kernel);
  if (url) {
    out.push(
      h('div', { class: 'explorer-link' }, h('a', { class: 'btn btn-text', href: url, target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'tx-explorer' }, icon('external'), 'See it on the BEAM explorer'), h('p', { class: 'small center', text: EXPLORER_NOTE })),
    );
  }
  const other = contract ? null : t.income ? t.sender : t.receiver;
  if (other && looksLikeAddress(other)) {
    const name = contactNameFor(other);
    out.push(
      name
        ? h('p', { class: 'small center', 'data-testid': 'tx-contact' }, icon('person', 'inline-icon'), ` ${t.income ? 'From' : 'To'} your contact ${name}`)
        : textButton(h('span', {}, 'Save to contacts'), () => {
            contactForm(app, {
              address: other,
              from: t.income ? 'The address their wallet paid from. It can expire: if a payment to it fails, ask them for a new one.' : null,
            }).then((c) => c && close());
          }, { 'data-testid': 'tx-save-contact' }),
    );
  }
  if (canCheckProof(t))
    out.push(
      textButton('Check a payment proof', () => {
        close();
        app.go('checkProof');
      }, { 'data-testid': 'tx-check-proof' }),
    );
  if (canDeleteTx(t)) out.push(textButton(REMOVE_TEXT.confirm, () => confirmRemove(t, close), { class: 'btn btn-text danger', 'data-testid': 'tx-remove' }));
  return out;
}

async function getProof(btn, t, msg) {
  const span = btn.querySelector('span');
  const label = span.textContent;
  btn.disabled = true;
  span.textContent = 'Getting the proof…';
  put(msg);
  try {
    if (!wallet.session) throw Object.assign(new Error(PROOF_TEXT.notConnected), { code: 'stopped' });
    const proof = await exportProof(wallet.session, t.txId);
    if (!proof) return put(msg, h('div', { 'data-testid': 'tx-no-proof' }, notice('info', PROOF_TEXT.none)));
    showProof(proof);
  } catch (e) {
    put(msg, notice('error', e.code === 'rpc' ? PROOF_TEXT.none : `${PROOF_TEXT.notConnected}`));
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
      h('h2', { text: 'Payment proof' }),
      h('p', { class: 'lead', text: PROOF_TEXT.exportIntro }),
      h('div', { class: 'address-box' }, h('p', { class: 'mono', 'data-testid': 'proof-text', 'data-proof': proof, text: short(proof, 24, 24) })),
      primary(h('span', {}, 'Copy proof'), () => copyText(proof, 'Proof copied'), { 'data-testid': 'proof-copy' }),
      canShare
        ? secondary(h('span', {}, 'Share'), async () => {
            try {
              await navigator.share({ text: proof });
            } catch (e) {
              if (e && e.name !== 'AbortError') copyText(proof, 'Proof copied');
            }
          }, { 'data-testid': 'proof-share' })
        : null,
      textButton('Done', () => close(), { 'data-testid': 'proof-done' }),
    ],
    { label: 'Payment proof' },
  );
}

function confirmRemove(t, closeDetails) {
  const proofToo = canExportProof(t);
  const msg = h('div', { class: 'pay-msg' });
  const sheet = openSheet(
    () => [
      h('h2', { text: REMOVE_TEXT.title }),
      h('p', { class: 'lead', text: REMOVE_TEXT.body }),
      proofToo ? notice('info', REMOVE_TEXT.proofToo) : null,
      msg,
      h('button', {
        class: 'btn btn-danger',
        'data-testid': 'tx-remove-confirm',
        onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try {
            if (!wallet.session) throw new Error(PROOF_TEXT.notConnected);
            await deleteTx(wallet.session, t.txId);
            await wallet.persistNow();
            await wallet.refreshTxs();
            sheet.close(true);
            closeDetails();
            toast(REMOVE_TEXT.done);
          } catch (err) {
            b.disabled = false;
            put(msg, notice('error', err.code === 'rpc' ? REMOVE_TEXT.refused : `It wasn't removed: ${err.message}`));
          }
        },
      }, REMOVE_TEXT.confirm),
      textButton(REMOVE_TEXT.keep, () => sheet.close(false), { 'data-testid': 'tx-remove-keep' }),
    ],
    { label: REMOVE_TEXT.title },
  );
}
