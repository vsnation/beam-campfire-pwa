/* Mint more
 * Spec: ONE job: mint more of a token this wallet created.
 *       Primary CTA: "Mint 1,000 MYT" (the approve sheet that follows says the same and shows the 0.011 BEAM fee).
 *       Taps from app open: Tokens (1) -> My tokens (2) -> Mint more (3), the amount, "Mint …" (4), then approve.
 * Exit-intent reasons and answers:
 *   - "How much can I mint?" -> what can still be minted is under the token, with a one-tap "Most".
 *   - "What does it cost?" -> the 0.011 BEAM network fee is on screen before the button.
 *   - "Why is the button grey?" -> the reason is written right above it.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary } from '../lib/ui.js';
import { formatAmount, toInputString } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { parseUnits, unlimited, MINT_FEE, MAX_PER_TX } from '../lib/minter.js';
import { minter, tokenAmount, rememberMetadata, problemNotice, tokenTitle, pausedReason, forgetOnLock } from './minter.js';
import { t } from '../lib/i18n.js';

export default function minterMint(app, p = {}) {
  forgetOnLock(app);
  const assetId = Number(p.assetId);
  let token = null;
  let loadError = null;
  let minting = false;
  let result = null;
  let alive = true;

  const amount = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '1000', 'aria-label': t('How many to mint'), 'data-testid': 'mint-more-amount' });
  const unit = h('span', { class: 'suffix-text', 'aria-hidden': 'true' });
  const hint = h('p', { class: 'hint', 'data-testid': 'mint-more-hint' });
  const head = h('div', { class: 'card token-head' });
  const notes = h('div', { class: 'swap-notes' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'mint-more-reason', 'aria-live': 'polite' });
  const cta = primary(t('Mint'), mint, { disabled: true, 'data-testid': 'mint-more-cta' });
  const most = () => (token ? (token.mintable < MAX_PER_TX ? token.mintable : MAX_PER_TX) : 0n);
  const mostBtn = h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': 'mint-more-most', onclick: () => {
    amount.value = toInputString(most());
    result = null;
    render();
  } }, t('Most'));

  function plan() {
    const r = parseUnits(amount.value);
    if (r.error === 'over' || (r.value != null && token && r.value > most())) return { value: r.value, error: t('At most {amount}', { amount: tokenAmount(assetId, most()) }) };
    return r;
  }

  function ctaState(pl) {
    if (minting) return { off: t('Building the mint and checking it…') };
    if (!token) return { off: loadError ? t('The token could not be read. Try again above.') : t('Reading the token…') };
    if (!token.isOwner) return { off: t('Only the wallet that created this token can mint it.') };
    if (token.mintable === 0n) return { off: t('Every {unit} that can exist was minted.', { unit: wallet.label(assetId).unit }) };
    if (pl.error) return { off: pl.error };
    if (pl.value == null) return { off: t('Enter how many to mint.') };
    const paused = pausedReason('mint');
    if (paused) return { off: paused };
    if (wallet.available(0) < MINT_FEE) return { off: t('The network fee is paid in BEAM: {fee} BEAM. You have {balance} BEAM.', { fee: formatAmount(MINT_FEE), balance: formatAmount(wallet.available(0)) }), receive: true };
    return { off: null };
  }

  function render() {
    if (!alive) return;
    const l = wallet.label(assetId);
    unit.textContent = l.unit;
    put(head, tokenTitle(assetId, token ? (unlimited(token.limit) ? t('No maximum: mint as much as you like') : t('You can still mint {amount}', { amount: tokenAmount(assetId, token.mintable) })) : loadError ? '' : t('Reading the token…')));
    const pl = plan();
    hint.textContent = pl.error && pl.error !== 'over' ? pl.error : '';
    hint.classList.toggle('bad', Boolean(pl.error));
    put(
      notes,
      loadError ? problemNotice(loadError, 'mint-more-problem') : null,
      loadError ? h('button', { class: 'btn btn-secondary', type: 'button', onclick: load }, t('Try again')) : null,
      h('div', { class: 'card flat swap-details' }, h('div', { class: 'kv' }, h('span', { class: 'k', text: t('New tokens to your wallet') }), h('span', { class: 'v', 'data-testid': 'mint-more-gets', text: pl.value != null && !pl.error ? tokenAmount(assetId, pl.value) : '—' })), h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Network fee') }), h('span', { class: 'v', 'data-testid': 'mint-more-fee', text: `${formatAmount(MINT_FEE)} BEAM` }))), // i18n-ignore: an amount and its ticker
      result ? problemNotice(result, 'mint-more-result') : null,
    );
    const st = ctaState(pl);
    cta.disabled = Boolean(st.off);
    cta.textContent = pl.value != null && !pl.error ? t('Mint {amount}', { amount: tokenAmount(assetId, pl.value) }) : t('Mint {unit}', { unit: l.unit });
    put(reason, st.off || '', st.receive ? ' ' : null, st.receive ? h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => app.go('receive') }, t('Receive BEAM')) : null);
    reason.classList.toggle('hidden', !st.off);
    mostBtn.disabled = !token || token.mintable === 0n;
  }

  async function load() {
    loadError = null;
    render();
    try {
      const tok = await minter().token(assetId);
      if (!alive) return;
      if (!tok) loadError = { code: 'noSuchToken' };
      else {
        rememberMetadata(assetId, tok.metadata);
        token = tok;
      }
    } catch (e) {
      if (!alive) return;
      loadError = e;
    }
    render();
  }

  async function mint() {
    const pl = plan();
    if (ctaState(pl).off || minting) return;
    minting = true;
    result = null;
    render();
    try {
      await minter().mint({ assetId, value: pl.value, ticker: wallet.label(assetId).unit });
      if (!alive) return;
      wallet.refreshTxs();
      wallet.refreshStatus();
      app.go('minterTokens', { done: { assetId, value: String(pl.value) } }, { replace: true });
      return;
    } catch (e) {
      if (!alive) return;
      result = e;
      if (e.code === 'aboveLimit') load();
    }
    minting = false;
    render();
  }

  amount.addEventListener('input', () => {
    result = null;
    render();
  });
  amount.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') mint();
  });
  const off = wallet.onChange(() => render());

  const el = screen(
    { title: t('Mint more'), back: () => app.back('minterTokens'), cls: 'minter-mint feature sticky-actions' },
    head,
    // "Most" sits beside the label, not inside it: a tap on a label's words would press it.
    h('div', { class: 'field' }, h('span', { class: 'banner field-head' }, h('span', { class: 'grow', text: t('How many to mint') }), mostBtn), h('div', { class: 'input-wrap suffix' }, amount, unit)),
    hint,
    notes,
  );
  el.appendChild(h('div', { class: 'actions inline-actions' }, reason, cta));
  render();
  load();
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}
