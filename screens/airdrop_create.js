/* Airdrop: create codes
 * Spec: ONE job: lock tokens into one-time codes to hand out.
 *       Primary CTA: "Create 10 codes" (the approve sheet that follows shows exactly what is locked and the fee).
 *       Taps from app open: 2 (Home -> Airdrop codes -> Create codes), type the amount, 3 ("Create ..."), then approve.
 * Exit-intent reasons and answers:
 *   - "What will this cost?" -> the locked total, the 1% airdrop fee, the claim fees paid ahead and the
 *     network fee update as you type, before the button, with what leaves the wallet in total.
 *   - "My friends have no BEAM for the fee" -> "Pay the claim fee for each code" is on by default: 0.022
 *     BEAM per code, so people with an empty wallet can claim. One tap turns it off.
 *   - "What if I lose the codes?" -> said up front: they are kept only on this device, saved before
 *     anything is sent; unclaimed ones can be taken back later.
 *   - "Can I share them right away?" -> said before the button: the codes are checked on the network
 *     first, a few minutes after the batch is confirmed.
 *   - "Is a code safe to hand out?" -> "Codes work like cash" before the button: anyone with one can
 *     claim it; claiming never shows it to the network.
 *   - "I tapped twice - did I pay twice?" -> one batch per tap, refused in the library as well.
 *   - "Why is the button grey?" -> the reason is written right above it.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice } from '../lib/ui.js';
import { parseAmount, formatAmount, toInputString } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { v3CreationFee, createFee, cancelFee, GAS_PER_VOUCHER, V3_MAX_VOUCHERS } from '../lib/airdrop_v3.js';
import { airdrop, amountText, dropProblemText, forgetOnLock, BEARER_TEXT_V3 } from './airdrop.js';
import { confirmKeptHere } from './storage_warning.js';
import { syncReason } from '../lib/sync.js';

// The engine writes a call's funds as signed 64-bit numbers.
const I64_MAX = (1n << 63n) - 1n;

/**
 * p.again: { assetId, value, count, gas } after a batch whose codes failed their check, to make new
 * codes for the same airdrop (screens/airdrop_codes.js "Make new codes").
 */
export default function airdropCreate(app, p = {}) {
  forgetOnLock(app);
  // The failed batch's figures win over an older draft; used once, so coming back keeps what was typed since.
  if (p.again) {
    const a = p.again;
    app.dropCreateDraft = { assetId: Number(a.assetId) || 0, amount: a.value != null ? toInputString(BigInt(a.value)) : '', count: String(a.count || '10'), gas: a.gas !== false };
    p.again = null;
  }
  const draft = (app.dropCreateDraft = app.dropCreateDraft || { assetId: 0, amount: '', count: '10', gas: true });
  if (typeof draft.gas !== 'boolean') draft.gas = true;
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
  const gasBox = h('input', { type: 'checkbox', 'data-testid': 'drop-gas', checked: draft.gas });
  const gasRow = h('label', { class: 'check-row', 'data-testid': 'drop-gas-row' }, gasBox, h('span', { text: `Pay the claim fee for each code (${formatAmount(GAS_PER_VOUCHER)} BEAM per code), so people with an empty wallet can claim` }));
  const fieldHint = h('p', { class: 'hint', 'data-testid': 'drop-hint' });
  const summary = h('div', { class: 'card flat swap-details' });
  const notes = h('div', { class: 'swap-notes' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'drop-reason', 'aria-live': 'polite' });
  const cta = primary('Create codes', create, { disabled: true, 'data-testid': 'drop-cta' });

  function assets() {
    const list = [0];
    for (const [id, t] of wallet.state.totals) if (id !== 0 && t.available > 0n) list.push(id);
    if (!list.includes(Number(draft.assetId))) list.push(Number(draft.assetId));
    return list;
  }

  function fillAssets() {
    const list = assets();
    put(assetSel, ...list.map((id) => h('option', { value: String(id), text: `${wallet.distinctUnit(id)} (${formatAmount(wallet.available(id))} available)` })));
    assetSel.value = list.includes(Number(draft.assetId)) ? String(draft.assetId) : '0';
    draft.assetId = Number(assetSel.value);
  }

  /** {value, n, total, fee, gasTotal, networkFee, error} from the fields. */
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
      if (!Number.isInteger(n) || n < 1 || n > V3_MAX_VOUCHERS) error = error || `Choose 1 to ${V3_MAX_VOUCHERS} codes.`;
    }
    if (value == null || error || !Number.isInteger(n) || n < 1 || n > V3_MAX_VOUCHERS) return { value, n, error };
    const total = value * BigInt(n);
    const gasTotal = draft.gas ? GAS_PER_VOUCHER * BigInt(n) : 0n;
    if (total > I64_MAX) return { value, n, error: 'That is more than one batch can hold. Lower the amount or the number of codes.' };
    const fee = v3CreationFee(total);
    if (total + fee + (Number(draft.assetId) === 0 ? gasTotal : 0n) > I64_MAX) return { value, n, error: 'That is more than one batch can hold. Lower the amount or the number of codes.' };
    return { value, n, total, fee, gasTotal, networkFee: createFee(n), error: null };
  }

  function ctaState(p) {
    const id = Number(draft.assetId);
    const u = wallet.label(id).unit;
    if (creating) return { off: 'Saving your codes and building the batch…' };
    if (p.error) return { off: p.error };
    if (p.value == null) return { off: `Enter how much ${u} each code gives.` };
    if (!p.n) return { off: 'Enter how many codes to create.' };
    if (!wallet.state.sync.canSend) return { off: `Creating codes is paused: ${syncReason(wallet.state.sync.title)}.` };
    const lock = p.total + p.fee;
    const beam = p.gasTotal + p.networkFee;
    if (id === 0) {
      const need = lock + beam;
      if (wallet.available(0) < need) return { off: `Not enough BEAM. This needs ${formatAmount(need)} BEAM, fees included. You have ${formatAmount(wallet.available(0))} BEAM.`, receive: true };
    } else {
      if (wallet.available(id) < lock) return { off: `Not enough ${u}. This needs ${formatAmount(lock)} ${u} with the 1% fee. You have ${formatAmount(wallet.available(id))} ${u}.` };
      if (wallet.available(0) < beam) return { off: `${p.gasTotal ? 'The claim fees and the network fee are' : 'The network fee is'} paid in BEAM: ${formatAmount(beam)} BEAM. You have ${formatAmount(wallet.available(0))} BEAM.`, receive: true };
    }
    return { off: null };
  }

  function render() {
    if (!alive) return;
    const id = Number(draft.assetId);
    const u = wallet.label(id).unit;
    unitLabel.textContent = u;
    gasBox.checked = draft.gas;
    const p = plan();
    fieldHint.textContent = `Available: ${amountText(id, wallet.available(id))}`;
    const row = (k, v, testid, sub) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k, sub ? h('div', { class: 'small', text: sub }) : null), h('span', { class: 'v', 'data-testid': testid, text: v }));
    const ok = p.total != null;
    const leaves = () => {
      if (id === 0) return amountText(0, p.total + p.fee + p.gasTotal + p.networkFee);
      return `${amountText(id, p.total + p.fee)} + ${formatAmount(p.gasTotal + p.networkFee)} BEAM`;
    };
    put(
      summary,
      row('Locked for the codes', ok ? amountText(id, p.total) : '—', 'drop-locked', ok ? `${p.n} × ${amountText(id, p.value)}` : null),
      row('Airdrop fee (1%)', ok ? amountText(id, p.fee) : '—', 'drop-fee', 'Kept by the airdrop contract'),
      draft.gas ? row('Claim fees paid ahead', ok ? `${formatAmount(p.gasTotal)} BEAM` : '—', 'drop-gas-total', ok ? `${p.n} × ${formatAmount(GAS_PER_VOUCHER)} BEAM` : null) : null,
      row('Network fee', ok ? `${formatAmount(p.networkFee)} BEAM` : '—', 'drop-network-fee'),
      row('Leaves your wallet', ok ? leaves() : '—', 'drop-total'),
    );
    const n = [];
    if (result) {
      const el = notice(result.kind, result.text);
      el.dataset.testid = 'drop-result';
      el.dataset.code = result.code || '';
      n.push(el);
    }
    const bearer = notice('warn', h('strong', { text: `${BEARER_TEXT_V3.createTitle}. ` }), BEARER_TEXT_V3.createMessage);
    bearer.dataset.testid = 'drop-bearer';
    n.push(
      bearer,
      h('p', { class: 'small', 'data-testid': 'drop-check-note' }, 'Share the codes once BEAM Campfire has checked them: it waits for the network to confirm the batch, then checks every code. This takes a few minutes.'),
      h(
        'p',
        { class: 'small', 'data-testid': 'drop-keep-note' },
        `The codes are kept only on this device, in this wallet, and saved before anything is sent: copy them somewhere safe. Codes nobody claims can be taken back later${draft.gas ? ', with their claim fees' : ''} (network fee from ${formatAmount(cancelFee(1))} BEAM).`,
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
    // The codes are kept only in this browser: where it may delete them, say so first (audit A-7).
    creating = true;
    const go = await confirmKeptHere(app, 'codes');
    creating = false;
    if (!go || !alive) return;
    creating = true;
    result = null;
    render();
    try {
      const r = await airdrop(app).createBatch({ assetId: Number(draft.assetId), values: Array(p.n).fill(p.value), gas: draft.gas });
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
  gasBox.addEventListener('change', () => {
    draft.gas = gasBox.checked;
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
      // The button stays in sight on a small phone, below the summary and the warnings (as Mint's).
      cls: 'airdrop-create feature sticky-actions',
    },
    assetField,
    h(
      'div',
      { class: 'drop-fields' },
      h('label', { class: 'field grow' }, 'Each code gives', h('div', { class: 'input-wrap suffix' }, amount, unitLabel)),
      h('label', { class: 'field count-field' }, 'Codes', count),
    ),
    fieldHint,
    gasRow,
    summary,
    notes,
  );
  el.appendChild(h('div', { class: 'actions inline-actions' }, reason, cta));
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
