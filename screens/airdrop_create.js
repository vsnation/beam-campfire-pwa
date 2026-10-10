/* Airdrop: create codes
 * Spec: ONE job: lock tokens into one-time codes to hand out.
 *       Primary CTA: "Create 10 codes" (the approve sheet that follows shows exactly what is locked and the fee).
 *       Taps from app open: 2 (Home -> Airdrop codes -> Create codes), type the amount, 3 ("Create ..."), then approve.
 * Exit-intent reasons and answers:
 *   - "What will this cost?" -> the locked total, the 1% airdrop fee and the 0.121 BEAM network fee
 *     update as you type, before the button.
 *   - "What if I lose the codes?" -> said up front: they are kept only on this device, saved before
 *     anything is sent; unclaimed ones can be cancelled later to get the rest back.
 *   - "I tapped twice - did I pay twice?" -> one batch per tap, refused in the library as well.
 *   - "Why is the button grey?" -> the reason is written right above it.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice } from '../lib/ui.js';
import { parseAmount, formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { creationFee, CALL_FEE, CANCEL_FEE, MAX_VOUCHERS, MAX_TOTAL } from '../lib/airdrop.js';
import { airdrop, amountText, dropProblemText, forgetOnLock } from './airdrop.js';

export default function airdropCreate(app) {
  forgetOnLock(app);
  const draft = (app.dropCreateDraft = app.dropCreateDraft || { assetId: 0, amount: '', count: '10' });
  let creating = false;
  let result = null;
  let alive = true;

  const assetSel = h('select', { class: 'input', 'aria-label': 'Asset', 'data-testid': 'drop-asset' });
  const assetField = h('label', { class: 'field' }, 'What to give away', assetSel);
  const amount = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Each code gives', 'data-testid': 'drop-amount' });
  amount.value = draft.amount;
  const unitLabel = h('span', { class: 'suffix-text', 'aria-hidden': 'true' });
  const count = h('input', { class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '10', 'aria-label': 'Number of codes', 'data-testid': 'drop-count' });
  count.value = draft.count;
  const fieldHint = h('p', { class: 'hint', 'data-testid': 'drop-hint' });
  const summary = h('div', { class: 'card flat swap-details' });
  const notes = h('div', { class: 'swap-notes' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'drop-reason', 'aria-live': 'polite' });
  const cta = primary('Create codes', create, { disabled: true, 'data-testid': 'drop-cta' });

  function assets() {
    const list = [0];
    for (const [id, t] of wallet.state.totals) if (id !== 0 && t.available > 0n) list.push(id);
    return list;
  }

  function fillAssets() {
    const list = assets();
    put(assetSel, ...list.map((id) => h('option', { value: String(id), text: `${wallet.label(id).unit} (${formatAmount(wallet.available(id))} available)` })));
    assetSel.value = list.includes(Number(draft.assetId)) ? String(draft.assetId) : '0';
    draft.assetId = Number(assetSel.value);
  }

  /** {value, n, total, fee, error} from the two fields. */
  function plan() {
    let value = null;
    let n = null;
    let error = null;
    const t = amount.value.trim();
    if (t) {
      try {
        value = parseAmount(t);
        if (value <= 0n) error = 'Each code must give more than zero.';
      } catch (e) {
        error = e.message;
      }
    }
    const c = count.value.trim();
    if (c) {
      n = /^\d+$/.test(c) ? Number(c) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > MAX_VOUCHERS) error = error || `Choose 1 to ${MAX_VOUCHERS} codes.`;
    }
    if (value == null || error || !Number.isInteger(n) || n < 1 || n > MAX_VOUCHERS) return { value, n, error };
    const total = value * BigInt(n);
    if (total > MAX_TOTAL) return { value, n, error: 'That is more than one batch can hold. Lower the amount or the number of codes.' };
    return { value, n, total, fee: creationFee(total), error: null };
  }

  function ctaState(p) {
    const id = Number(draft.assetId);
    const u = wallet.label(id).unit;
    if (creating) return { off: 'Saving your codes and building the batch…' };
    if (p.error) return { off: p.error };
    if (p.value == null) return { off: `Enter how much ${u} each code gives.` };
    if (!p.n) return { off: 'Enter how many codes to create.' };
    if (!wallet.state.sync.canSend) return { off: `Creating codes is paused: ${wallet.state.sync.title.toLowerCase().replace(/[.…]+$/, '')}.` };
    const lock = p.total + p.fee;
    if (id === 0) {
      const need = lock + CALL_FEE;
      if (wallet.available(0) < need) return { off: `Not enough BEAM. This needs ${formatAmount(need)} BEAM, network fee included. You have ${formatAmount(wallet.available(0))} BEAM.`, receive: true };
    } else {
      if (wallet.available(id) < lock) return { off: `Not enough ${u}. This needs ${formatAmount(lock)} ${u} with the 1% fee. You have ${formatAmount(wallet.available(id))} ${u}.` };
      if (wallet.available(0) < CALL_FEE) return { off: `The network fee is paid in BEAM: ${formatAmount(CALL_FEE)} BEAM. You have ${formatAmount(wallet.available(0))} BEAM.`, receive: true };
    }
    return { off: null };
  }

  function render() {
    if (!alive) return;
    const id = Number(draft.assetId);
    const u = wallet.label(id).unit;
    unitLabel.textContent = u;
    const p = plan();
    fieldHint.textContent = `Available: ${amountText(id, wallet.available(id))}`;
    const row = (k, v, testid, sub) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k, sub ? h('div', { class: 'small', text: sub }) : null), h('span', { class: 'v', 'data-testid': testid, text: v }));
    const ok = p.total != null;
    put(
      summary,
      row('Locked for the codes', ok ? amountText(id, p.total) : '—', 'drop-locked', ok ? `${p.n} × ${amountText(id, p.value)}` : null),
      row('Airdrop fee (1%)', ok ? amountText(id, p.fee) : '—', 'drop-fee', 'Kept by the airdrop contract'),
      row('Network fee', `${formatAmount(CALL_FEE)} BEAM`, 'drop-network-fee'),
      row('Leaves your wallet', ok ? (id === 0 ? amountText(0, p.total + p.fee + CALL_FEE) : `${amountText(id, p.total + p.fee)} + ${formatAmount(CALL_FEE)} BEAM`) : '—', 'drop-total'),
    );
    const n = [];
    if (result) {
      const el = notice(result.kind, result.text);
      el.dataset.testid = 'drop-result';
      el.dataset.code = result.code || '';
      n.push(el);
    }
    n.push(
      h(
        'p',
        { class: 'small', 'data-testid': 'drop-keep-note' },
        `The codes are kept only on this device, in this wallet, and saved before anything is sent: copy them somewhere safe. Anyone with a code can claim it. Codes nobody claims can be cancelled later to get the rest back (network fee ${formatAmount(CANCEL_FEE)} BEAM).`,
      ),
    );
    put(notes, ...n);
    const st = ctaState(p);
    cta.disabled = Boolean(st.off);
    cta.textContent = p.n && !p.error ? `Create ${p.n} ${p.n === 1 ? 'code' : 'codes'}` : 'Create codes';
    put(reason, st.off || '', st.receive ? ' ' : null, st.receive ? h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => app.go('receive') }, 'Receive BEAM') : null);
    reason.classList.toggle('hidden', !st.off);
  }

  async function create() {
    const p = plan();
    if (ctaState(p).off || creating) return;
    creating = true;
    result = null;
    render();
    try {
      const r = await airdrop(app).createBatch({ assetId: Number(draft.assetId), values: Array(p.n).fill(p.value) });
      if (!alive) return;
      app.dropCreateDraft = null;
      wallet.refreshTxs();
      wallet.refreshStatus();
      app.go('airdropCodes', { localId: r.batch.localId, justCreated: true, txId: r.txId }, { replace: true });
      return;
    } catch (e) {
      if (!alive) return;
      result = { kind: e.code === 'rejected' ? 'info' : 'error', code: e.code || 'error', text: e.code === 'rejected' ? 'Cancelled. Nothing was sent; the codes made for it will never hold funds.' : dropProblemText(e, 'batch') };
    }
    creating = false;
    render();
  }

  amount.addEventListener('input', () => {
    draft.amount = amount.value;
    result = null;
    render();
  });
  count.addEventListener('input', () => {
    draft.count = count.value;
    result = null;
    render();
  });
  assetSel.addEventListener('change', () => {
    draft.assetId = Number(assetSel.value);
    result = null;
    render();
  });
  const off = wallet.onChange(() => render());
  fillAssets();
  assetField.classList.toggle('hidden', assets().length < 2);
  render();

  const el = screen(
    {
      title: 'Create codes',
      back: () => {
        app.dropCreateDraft = null;
        app.back('airdrop');
      },
      cls: 'airdrop-create feature',
    },
    assetField,
    h(
      'div',
      { class: 'drop-fields' },
      h('label', { class: 'field grow' }, 'Each code gives', h('div', { class: 'input-wrap suffix' }, amount, unitLabel)),
      h('label', { class: 'field count-field' }, 'Codes', count),
    ),
    fieldHint,
    summary,
    notes,
    h('div', { class: 'actions inline-actions' }, reason, cta),
  );
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
