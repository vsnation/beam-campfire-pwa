/* Check a payment proof (Settings; a received payment's details)
 * Spec: ONE job: tell whether a proof someone sent really shows a payment.
 *       Primary CTA: "Check proof".
 *       Taps from app open: 3 (Settings -> Check a payment proof -> paste -> Check proof).
 * Exit-intent reasons and answers:
 *   - "Did it work?" -> one sentence: valid with the amount, who paid whom and the transaction ID,
 *     or not valid; "to you" when it was this wallet that was paid.
 *   - "Is it on the blockchain?" -> says plainly the check happens on this phone (the receiver's
 *     signature), and links the transaction ID to the explorer for "is it in a block".
 *   - "I pasted something wrong" -> explained without blaming anyone, with what to ask the sender.
 */
import { h, put, fmtDate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, copyText } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { parseProofInput, verifyProof, ownIdentities, proofVerdict, explorerUrl, short, paymentWithKernel, identityOf, PROOF_TEXT, EXPLORER_NOTE } from '../lib/payments.js';
import { loadContacts } from '../lib/contacts.js';

export default function checkProof(app, params = {}) {
  const input = h('textarea', { class: 'input mono', rows: 5, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'Payment proof', 'aria-label': 'Payment proof', 'data-testid': 'proof-input' });
  if (params.proof) input.value = params.proof;
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'proof-paste' }, icon('paste'), 'Paste');
  const result = h('div', { class: 'stack', 'aria-live': 'polite', 'data-testid': 'proof-result' });
  const cta = primary('Check proof', check, { 'data-testid': 'proof-check', disabled: !input.value.trim() });
  let busy = false;

  input.addEventListener('input', () => {
    cta.disabled = !input.value.trim();
    put(result);
  });
  pasteBtn.addEventListener('click', async () => {
    try {
      input.value = (await navigator.clipboard.readText()).trim();
      cta.disabled = !input.value;
      put(result);
    } catch {
      input.focus();
    }
  });

  async function check() {
    if (busy) return;
    const p = parseProofInput(input.value);
    if (!p.ok) return put(result, notice('warn', p.problem === 'empty' ? PROOF_TEXT.checkIntro : PROOF_TEXT.notProof));
    if (!wallet.session) return put(result, notice('info', PROOF_TEXT.notConnected));
    busy = true;
    cta.disabled = true;
    cta.textContent = 'Checking…';
    try {
      const info = await verifyProof(wallet.session, p.hex);
      if (info && info.parseError) return put(result, h('div', { 'data-testid': 'proof-not-a-proof' }, notice('warn', PROOF_TEXT.notProof)));
      const mine = await ownIdentities(wallet.session, wallet.state.txs).catch(() => []);
      // Contacts saved with an old-style address name the key a proof shows.
      const names = new Map();
      for (const c of (await loadContacts(app).catch(() => null)) || []) {
        const id = identityOf(c.address);
        if (id) names.set(id, c.name);
      }
      const v = proofVerdict(info, { mine, names, describe: (a, id) => `${formatAmount(a)} ${wallet.label(id).unit}` });
      if (!v.valid) return put(result, h('div', { 'data-testid': 'proof-invalid' }, notice('error', v.sentence)));
      const url = explorerUrl(v.kernel);
      // The same payment in this wallet's list: the proof and the list agree on it.
      const inList = paymentWithKernel(wallet.state.txs, v.kernel);
      const kv = (k, val, opts = {}) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), opts.copy ? h('button', { class: 'v mono btn-text', onclick: () => copyText(opts.copy, `${k} copied`), text: val }) : h('span', { class: 'v', text: val }));
      put(
        result,
        h('div', { 'data-testid': 'proof-valid' }, notice('success', v.sentence)),
        h(
          'div',
          { class: 'card' },
          kv('Amount', `${formatAmount(v.amount)} ${wallet.label(v.assetId).unit}`),
          kv('Paid by', v.fromYou ? 'You' : v.senderName || short(v.sender, 10, 8), { copy: v.fromYou ? null : v.sender }),
          kv('Paid to', v.toYou ? 'You (this wallet)' : v.receiverName || short(v.receiver, 10, 8), { copy: v.toYou ? null : v.receiver }),
          kv('Transaction ID', short(v.kernel, 10, 8), { copy: v.kernel }),
        ),
        inList ? h('div', { 'data-testid': 'proof-in-list' }, notice('info', `It is a payment in your list: ${inList.income ? 'received' : 'sent'} ${fmtDate(inList.create_time)}.`)) : null,
        h('p', { class: 'small', text: PROOF_TEXT.howChecked }),
        url ? h('a', { class: 'btn btn-text', href: url, target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'proof-explorer' }, icon('external'), 'See it on the BEAM explorer') : null,
        url ? h('p', { class: 'small center', text: EXPLORER_NOTE }) : null,
      );
    } catch (e) {
      put(result, notice('error', `It could not be checked just now: ${e.message} Try again in a moment.`));
    } finally {
      busy = false;
      cta.disabled = !input.value.trim();
      cta.textContent = 'Check proof';
    }
  }

  const el = screen(
    { title: 'Check a payment proof', back: () => app.back('settings'), actions: [cta], cls: 'plain' },
    h('p', { class: 'lead', text: 'Someone says they paid you? Paste the payment proof they sent. It shows the amount, who paid whom and the transaction ID.' }),
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'Payment proof' }), pasteBtn), input),
    result,
  );
  return { el };
}
