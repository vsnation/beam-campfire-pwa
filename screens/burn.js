/* Burn tokens
 * Spec: ONE job: destroy some of a token for good (lower its supply, in public).
 *       Primary CTA: "Burn 5 MYT"; then, typed confirmation, "Burn 5 MYT forever"; then the approve sheet
 *       "Burn 5 MYT forever".
 *       Taps from app open: Tokens (1) -> Burn tokens (2), the amount, "Burn …" (3), type the ticker,
 *       "… forever" (4), approve. Deliberately not fast: it cannot be undone.
 * Exit-intent reasons and answers:
 *   - "Can I undo this?" -> no, and the screen says so before anything else, again on the second step,
 *     and on the approve sheet.
 *   - "Is my BEAM at risk?" -> BEAM is never offered here, and the library refuses it.
 *   - "I have nothing to burn" -> says why, and that tokens you receive or mint show up here.
 *   - "Why is the button grey?" -> the reason is written right above it.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, focusSoon } from '../lib/ui.js';
import { formatAmount, toInputString } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { parseUnits, MAX_PER_TX } from '../lib/minter.js';
import { BURN_FEE, confirmWord, confirms } from '../lib/burn.js';
import { burner, tokenAmount, problemNotice, tokenTitle, pausedReason, forgetOnLock } from './minter.js';

/** Tokens this wallet can burn now: every asset but BEAM with something available, verified first. */
export function burnable() {
  return [...wallet.state.totals.entries()]
    .filter(([id, t]) => id !== 0 && t.available > 0n)
    .map(([id]) => id)
    .sort((a, b) => {
      const va = wallet.label(a).verified;
      const vb = wallet.label(b).verified;
      return va === vb ? a - b : va ? -1 : 1;
    });
}

export default function burn(app, p = {}) {
  forgetOnLock(app);
  const draft = (app.burnDraft = app.burnDraft && (p.assetId == null || app.burnDraft.assetId === Number(p.assetId)) ? app.burnDraft : { assetId: p.assetId != null ? Number(p.assetId) : null, amount: '', step: 'form' });
  // Opening again keeps the token and amount, and starts on the first step: the confirm word is typed afresh.
  draft.step = 'form';
  let burning = false;
  let result = null;
  let done = null; // { text }
  let alive = true;
  let shown = null;

  const body = h('div', { class: 'content' });
  const actions = h('div', { class: 'actions inline-actions' });

  const assetSel = h('select', { class: 'input', 'aria-label': 'Token', 'data-testid': 'burn-asset' });
  const assetField = h('label', { class: 'field' }, 'Token to burn', assetSel);
  const tokenBox = h('div', { class: 'card', 'data-testid': 'burn-token' });
  const amount = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'How many to burn', 'data-testid': 'burn-amount' });
  amount.value = draft.amount;
  const unit = h('span', { class: 'suffix-text', 'aria-hidden': 'true' });
  const hint = h('p', { class: 'hint', 'data-testid': 'burn-hint' });
  const allBtn = h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': 'burn-all', onclick: () => {
    const id = current();
    if (id == null) return;
    const all = wallet.available(id) < MAX_PER_TX ? wallet.available(id) : MAX_PER_TX;
    amount.value = toInputString(all);
    draft.amount = amount.value;
    result = null;
    render();
  } }, 'All of it');
  const fee = h('div', { class: 'card flat swap-details' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'burn-reason', 'aria-live': 'polite' });
  const cta = primary('Burn tokens', () => setStep('confirm'), { disabled: true, 'data-testid': 'burn-cta' });
  const typed = h('input', { class: 'input code-input', type: 'text', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', 'data-testid': 'burn-type' });

  /** The token picked: the one asked for when the wallet holds it, else the first it holds. */
  function current() {
    const ids = burnable();
    if (draft.assetId != null && ids.includes(draft.assetId)) return draft.assetId;
    return ids.length ? ids[0] : null;
  }

  function plan() {
    const id = current();
    const r = parseUnits(amount.value);
    if (id == null) return { value: null, error: null };
    const have = wallet.available(id);
    if (r.error === 'over' || (r.value != null && r.value > have)) return { value: r.value, error: `You have ${tokenAmount(id, have)}` };
    return r;
  }

  function formState(pl) {
    if (pl.error) return { off: pl.error };
    if (pl.value == null) return { off: 'Enter how many to burn.' };
    const paused = pausedReason('Burning');
    if (paused) return { off: paused };
    if (wallet.available(0) < BURN_FEE) return { off: `The network fee is paid in BEAM: ${formatAmount(BURN_FEE)} BEAM. You have ${formatAmount(wallet.available(0))} BEAM.`, receive: true };
    return { off: null };
  }

  const warnFirst = () => {
    const el = notice('warn', h('strong', { text: 'Burning cannot be undone. ' }), 'Burned tokens are destroyed for good: nobody, you included, can ever get them back. BEAM itself can never be burned here.');
    el.dataset.testid = 'burn-intro';
    return el;
  };

  function formBody(id) {
    if (id == null) {
      return [
        warnFirst(),
        h('div', { class: 'card empty', 'data-testid': 'burn-empty' }, icon('flame'), h('h3', { text: 'No tokens to burn' }), h('p', { class: 'small', text: 'This wallet holds no tokens other than BEAM, and BEAM cannot be burned. Tokens you receive or mint show up here.' })),
      ];
    }
    return [
      h('p', { class: 'step', text: 'Step 1 of 2: how much' }),
      warnFirst(),
      assetField,
      tokenBox,
      h('div', { class: 'field' }, h('span', { class: 'banner field-head' }, h('span', { class: 'grow', text: 'How many to burn' }), allBtn), h('div', { class: 'input-wrap suffix' }, amount, unit)),
      hint,
      fee,
      h('div', { 'data-testid': 'burn-result-box' }, result ? problemNotice(result, 'burn-result') : null),
    ];
  }

  function renderForm(id) {
    if (id == null) {
      put(actions, primary('Back', () => app.back('home'), { 'data-testid': 'burn-back' }));
      return;
    }
    draft.assetId = id;
    const ids = burnable();
    put(assetSel, ...ids.map((x) => h('option', { value: String(x), text: `${wallet.distinctUnit(x)} (${formatAmount(wallet.available(x))} available)` })));
    assetSel.value = String(id);
    assetField.classList.toggle('hidden', ids.length < 2);
    put(tokenBox, tokenTitle(id, `You have ${tokenAmount(id, wallet.available(id))}`));
    unit.textContent = wallet.label(id).unit;
    const pl = plan();
    hint.textContent = pl.error && pl.error !== 'over' ? pl.error : '';
    hint.classList.toggle('bad', Boolean(pl.error));
    put(fee, h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'burn-fee', text: `${formatAmount(BURN_FEE)} BEAM` })));
    const st = formState(pl);
    cta.disabled = Boolean(st.off);
    cta.textContent = pl.value != null && !pl.error ? `Burn ${tokenAmount(id, pl.value)}` : 'Burn tokens';
    put(reason, st.off || '', st.receive ? ' ' : null, st.receive ? h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => app.go('receive') }, 'Receive BEAM') : null);
    reason.classList.toggle('hidden', !st.off);
    put(actions, reason, cta);
  }

  // ------------------------------------------------------------ the second step: slow on purpose
  function confirmBody(id, value) {
    const what = tokenAmount(id, value);
    const word = confirmWord(wallet.label(id).symbol, id);
    typed.setAttribute('aria-label', `Type ${word} to confirm`);
    typed.placeholder = word;
    const warn = notice('error', h('strong', { text: `This destroys ${what} forever. ` }), 'Nobody can undo it: not you, not the token creator, not us. The tokens are locked in a contract that has no way to give anything back.');
    warn.dataset.testid = 'burn-warning';
    return [
      h('p', { class: 'step', text: 'Step 2 of 2: confirm' }),
      warn,
      h('div', { class: 'card' }, tokenTitle(id)),
      h(
        'div',
        { class: 'card flat swap-details' },
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Destroyed for good' }), h('span', { class: 'v', 'data-testid': 'burn-confirm-amount', text: what })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'burn-confirm-fee', text: `${formatAmount(BURN_FEE)} BEAM` })),
      ),
      h('label', { class: 'field' }, `Type ${word} to confirm`, typed),
      h('div', { 'data-testid': 'burn-confirm-result-box' }, result ? problemNotice(result, 'burn-confirm-result') : null),
    ];
  }

  function renderConfirm(id, value) {
    const what = tokenAmount(id, value);
    const word = confirmWord(wallet.label(id).symbol, id);
    const ok = confirms(typed.value, word);
    const paused = pausedReason('Burning');
    const why = burning ? 'Building the burn and checking it…' : paused || (ok ? null : `Type ${word} above to confirm.`);
    put(
      actions,
      why ? h('p', { class: 'hint center', 'data-testid': 'burn-confirm-reason', text: why }) : null,
      h('button', { class: 'btn btn-primary wrap danger-cta', type: 'button', 'data-testid': 'burn-confirm-cta', disabled: !ok || burning || Boolean(paused), onclick: () => doBurn(id, value, ok) }, `Burn ${what} forever`),
      h('button', { class: 'btn btn-text', type: 'button', 'data-testid': 'burn-change', disabled: burning, onclick: () => setStep('form') }, 'Change the amount'),
    );
  }

  function doneBody() {
    return [
      h('div', { class: 'status-icon bad' }, icon('flame')),
      h('h2', { class: 'title center', 'data-testid': 'burn-done', text: `${done.text} sent to be burned` }),
      h('p', { class: 'center small', text: 'They are gone for good once the network confirms it, usually within a few minutes.' }),
    ];
  }

  function setStep(step) {
    draft.step = step;
    result = null;
    // The confirm word is typed afresh every time the second step opens.
    if (step === 'confirm') typed.value = '';
    window.scrollTo(0, 0);
    render(true);
  }

  function render(rebuild = false) {
    if (!alive) return;
    const id = current();
    const pl = plan();
    let step = done ? 'done' : draft.step;
    if (step === 'confirm' && (id == null || pl.error || pl.value == null) && !burning) step = 'form';
    const key = `${step}:${id}`;
    if (rebuild || key !== shown) {
      shown = key;
      title.textContent = step === 'confirm' ? 'Confirm burn' : 'Burn tokens';
      put(body, ...(step === 'done' ? doneBody() : step === 'confirm' ? confirmBody(id, pl.value) : formBody(id)));
      if (step === 'confirm') focusSoon(typed);
    }
    if (step === 'done') put(actions, primary('Done', () => app.go('home'), { 'data-testid': 'burn-done-home' }));
    else if (step === 'confirm') renderConfirm(id, pl.value);
    else renderForm(id);
  }

  async function doBurn(id, value, ok) {
    if (burning || !ok) return;
    // Read before anything re-renders: only what the person typed acknowledges the loss.
    const acknowledged = confirms(typed.value, confirmWord(wallet.label(id).symbol, id));
    burning = true;
    result = null;
    render(true);
    try {
      await burner().burn({ assetId: id, amount: value, ticker: wallet.label(id).unit, acknowledged });
      if (!alive) return;
      done = { text: tokenAmount(id, value) };
      app.burnDraft = null;
      wallet.refreshTxs();
      wallet.refreshStatus();
    } catch (e) {
      if (!alive) return;
      result = e;
    }
    burning = false;
    render(true);
  }

  amount.addEventListener('input', () => {
    draft.amount = amount.value;
    result = null;
    render();
  });
  assetSel.addEventListener('change', () => {
    draft.assetId = Number(assetSel.value);
    amount.value = '';
    draft.amount = '';
    result = null;
    render();
  });
  typed.addEventListener('input', () => render());
  const off = wallet.onChange(() => {
    if (!burning) render();
  });

  const el = screen(
    {
      title: 'Burn tokens',
      back: () => {
        if (!done && draft.step === 'confirm' && !burning) return setStep('form');
        app.burnDraft = null;
        app.back('home');
      },
      cls: 'burn feature sticky-actions',
    },
    body,
  );
  const title = el.querySelector('.topbar h1');
  el.appendChild(actions);
  render(true);
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
