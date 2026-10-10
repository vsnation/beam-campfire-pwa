/* Send on Ethereum
 * Spec: ONE job: say who gets how much ETH (or which token).
 *       Primary CTA: "Send <amount> <symbol>" - opens the review sheet; nothing is signed before it.
 *       Taps from app open: 2 (Home -> Ethereum -> Send), then paste + amount, 3 to the review.
 * Exit-intent reasons and answers:
 *   - "Is this address right?" -> checked as it is pasted: format, EIP-55 checksum (a mistyped
 *     character), this wallet's own address, and contracts that would swallow the coins (the
 *     bridge's pipes, token contracts) are refused in words.
 *   - "How much is the fee?" -> shown before review, in ETH, as "about"; the review adds "at most".
 *   - "Max leaves dust or fails" -> Max is the ETH balance less the most the fee can be.
 *   - "Why is the button grey?" -> the reason is always written next to it.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { ethWallet } from '../lib/eth/wallet.js';
import { walletFees } from '../lib/eth/rpc.js';
import { parseUnits, toInputString } from '../lib/eth/units.js';
import { ETH, TOKENS } from '../lib/eth/tokens.js';
import { recipientProblem, prepareSend, SendError, ETH_TRANSFER_GAS } from '../lib/eth/send.js';
import { amountText, ethText, serverProblem } from './eth_ui.js';
import { openEthReview } from './eth_review.js';

/** What a token transfer usually costs in gas, for the estimate shown before the real one. */
const TYPICAL_TOKEN_GAS = 65000n;

export default function ethSend(app) {
  const draft = (app.ethSendDraft = app.ethSendDraft || { to: '', amount: '', symbol: 'ETH' });
  let w = null;
  let fees = null; // walletFees(), for the fee shown before review
  let preparing = false;

  const addr = h('textarea', { class: 'input mono', rows: 2, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'Paste the 0x… address', 'aria-label': 'Ethereum address', 'data-testid': 'eth-send-to' });
  addr.value = draft.to;
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'eth-paste-to' }, icon('paste'), 'Paste');
  const addrHint = h('p', { class: 'hint', 'data-testid': 'eth-to-hint' });
  const assetSel = h('select', { class: 'input', 'aria-label': 'What to send', 'data-testid': 'eth-send-asset' });
  const assetField = h('label', { class: 'field hidden' }, 'What to send', assetSel);
  const amount = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount', 'data-testid': 'eth-send-amount' });
  amount.value = draft.amount;
  const unitLabel = h('span', { class: 'small' });
  const maxBtn = h('button', { class: 'btn btn-secondary btn-small inside', type: 'button', 'data-testid': 'eth-max' }, 'Max');
  const amountHint = h('p', { class: 'hint', 'data-testid': 'eth-amount-hint' });
  const feeLine = h('div', { class: 'kv' });
  const msg = h('div', { 'aria-live': 'polite' });
  const cta = primary('Send', review, { disabled: true, 'data-testid': 'eth-send-review' });

  const asset = () => (draft.symbol === 'ETH' ? ETH : TOKENS.find((t) => t.symbol === draft.symbol) || ETH);
  const balanceOf = (a) => (w ? (a === ETH ? w.state.eth : w.state.tokens.get(a.symbol)) : null);
  const typicalUpTo = (a) => (fees ? (a === ETH ? ETH_TRANSFER_GAS : TYPICAL_TOKEN_GAS) * fees.maxFeePerGas : null);
  const typicalLikely = (a) => (fees ? (a === ETH ? ETH_TRANSFER_GAS : TYPICAL_TOKEN_GAS) * (fees.baseFee + fees.maxPriorityFeePerGas) : null);

  function fillAssets() {
    const list = [ETH, ...TOKENS.filter((t) => (balanceOf(t) ?? 0n) > 0n)];
    put(assetSel, ...list.map((a) => h('option', { value: a.symbol, text: `${a.symbol} (${amountText(balanceOf(a) ?? 0n, a)} available)` })));
    if (!list.some((a) => a.symbol === draft.symbol)) draft.symbol = 'ETH';
    assetSel.value = draft.symbol;
    assetField.classList.toggle('hidden', list.length < 2);
  }

  function evaluate() {
    const a = asset();
    unitLabel.textContent = a.symbol;
    const like = typicalLikely(a);
    put(feeLine, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'eth-send-fee', text: like == null ? 'Checking…' : `about ${ethText(like)}` }));
    const prob = recipientProblem(addr.value, { own: w && w.state.address });
    addrHint.textContent = prob ? prob.message : addr.value.trim() ? 'An Ethereum address. Check the first and last characters with the receiver.' : '';
    addrHint.className = `hint${prob && prob.code !== 'empty' ? ' bad' : !prob ? ' good' : ''}`;
    addr.classList.toggle('bad', Boolean(prob && prob.code !== 'empty'));
    addr.classList.toggle('good', !prob);

    const have = balanceOf(a);
    let amt = null;
    let err = null;
    if (amount.value.trim()) {
      try {
        amt = parseUnits(amount.value, a.decimals, { symbol: a.symbol });
        if (amt <= 0n) err = 'The amount must be more than zero.';
      } catch (e) {
        err = e.message;
      }
    }
    const upTo = typicalUpTo(a);
    if (amt != null && !err && have != null) {
      if (amt > have) err = `That's more than you have (${amountText(have, a)}).`;
      else if (a === ETH && upTo != null && amt + upTo > have) err = `With the network fee that's more than you have. Up to ${ethText(have > upTo ? have - upTo : 0n)} after the fee.`;
      else if (a !== ETH && upTo != null && (w.state.eth ?? 0n) < upTo) err = `The network fee is paid in ETH (about ${ethText(typicalLikely(a))}), and this wallet has ${ethText(w.state.eth ?? 0n)}.`;
    }
    amountHint.textContent = err || (have == null ? 'Checking the balance…' : `Available: ${amountText(have, a)}`);
    amountHint.className = `hint${err ? ' bad' : ''}`;
    amount.classList.toggle('bad', Boolean(err));
    const ok = w && !prob && amt != null && !err && have != null && !preparing;
    cta.disabled = !ok;
    cta.textContent = preparing ? 'Checking with Ethereum…' : ok ? `Send ${amountText(amt, a, { approx: false })}` : 'Send';
    return ok ? { asset: a, amount: amt } : null;
  }

  async function review() {
    const ok = evaluate();
    if (!ok) return;
    preparing = true;
    put(msg);
    evaluate();
    try {
      const prepared = await prepareSend(w.rpc, { from: w.state.address, asset: ok.asset, recipient: addr.value.trim(), amount: ok.amount, balances: w.balances() });
      preparing = false;
      evaluate();
      openEthReview(app, w, prepared);
    } catch (e) {
      preparing = false;
      evaluate();
      if (e instanceof SendError) put(msg, notice('error', e.message));
      else put(msg, serverProblem(app, e, { retry: review, switched: () => review() }));
    }
  }

  let t = null;
  addr.addEventListener('input', () => {
    draft.to = addr.value.trim();
    clearTimeout(t);
    t = setTimeout(evaluate, 200);
  });
  pasteBtn.addEventListener('click', async () => {
    try {
      addr.value = (await navigator.clipboard.readText()).trim();
      draft.to = addr.value;
      evaluate();
    } catch {
      addrHint.textContent = 'Press and hold in the box, then tap Paste.';
      addr.focus();
    }
  });
  amount.addEventListener('input', () => {
    draft.amount = amount.value;
    evaluate();
  });
  assetSel.addEventListener('change', () => {
    draft.symbol = assetSel.value;
    evaluate();
  });
  maxBtn.addEventListener('click', () => {
    const a = asset();
    const have = balanceOf(a) ?? 0n;
    const upTo = a === ETH ? typicalUpTo(a) ?? 0n : 0n;
    amount.value = toInputString(have > upTo ? have - upTo : 0n, a.decimals);
    draft.amount = amount.value;
    evaluate();
  });

  (async () => {
    w = await ethWallet(app).catch(() => null);
    if (!w) return app.go('ethHome');
    if (w.state.eth === null) await w.refresh().catch(() => {});
    fillAssets();
    evaluate();
    try {
      fees = await walletFees(w.rpc);
    } catch (e) {
      put(msg, serverProblem(app, e, { retry: () => app.go('ethSend'), switched: () => app.go('ethSend') }));
    }
    evaluate();
  })();
  evaluate();

  const el = screen(
    {
      title: 'Send on Ethereum',
      back: () => {
        app.ethSendDraft = null;
        app.back('ethHome');
      },
      actions: [cta],
    },
    assetField,
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'To' }), pasteBtn), addr),
    addrHint,
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'Amount' }), unitLabel), h('div', { class: 'input-wrap' }, amount, maxBtn)),
    amountHint,
    h('div', { class: 'card flat' }, feeLine),
    msg,
  );
  return { el, destroy: () => clearTimeout(t) };
}

