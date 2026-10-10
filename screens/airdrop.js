/* Airdrop codes: claim a code
 * Spec: ONE job: turn an airdrop code into tokens in this wallet.
 *       Primary CTA: "Claim 5 FOMO" (the approve sheet that follows shows the amount and the fee).
 *       Taps from app open: 1 (Home -> Airdrop codes), paste the code (2), 3 ("Claim ..."), then approve.
 * Exit-intent reasons and answers:
 *   - "What will I get, and what does it cost?" -> the code is checked as soon as it is complete:
 *     what it gives, the network fee, and what the balance really gains, before any button.
 *   - "The code doesn't work" -> says why (not found, already claimed) and what to check.
 *   - "It costs more than it gives" -> said in plain numbers before claiming.
 *   - "I want to give codes away" -> Create codes and My batches sit right under the button.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { store } from '../lib/store.js';
import { airdropFor, codeVault, normaliseCode, formatCode, isWellFormedCode, CALL_FEE, CODE_LENGTH } from '../lib/airdrop.js';

const CHECK_DEBOUNCE_MS = 300;

/** The airdrop for the running wallet (one per session). Codes are kept encrypted in this wallet's storage. */
export function airdrop(app) {
  return airdropFor(wallet.session, {
    vault: async () => {
      if (!app.dbPass || !app.record) throw Object.assign(new Error('Unlock the wallet first.'), { code: 'noCodeStore' });
      return codeVault({ kv: store, walletId: app.record.id, secret: app.dbPass });
    },
  });
}

/** "5 FOMO" with every digit. */
export const amountText = (assetId, amount) => `${formatAmount(amount)} ${wallet.label(assetId).unit}`;

/** Plain words for whatever stopped an airdrop transaction. */
export function dropProblemText(e, what) {
  const code = e && e.code;
  if (code === 'rejected') return 'Cancelled. Nothing was sent.';
  if (code === 'timeout') return 'The wallet did not answer in time. Check Activity before trying again.';
  if (code === 'busy') return 'Another airdrop transaction is still in progress. Wait for it to finish, then try again.';
  if (code === 'load' || code === 'mismatch') return e.message;
  if (e && e.message && code && code !== 'rpc' && code !== 'error') return e.message;
  const m = String((e && e.message) || e || 'unknown error');
  return `The ${what} was not sent: ${m}${/\.$/.test(m) ? '' : '.'} Nothing left your wallet.`;
}

/** What the balance really gains, one line per asset: ["+5 FOMO", "−0.121 BEAM"], or for a BEAM voucher the net. */
export function balanceChange(assetId, value, fee = CALL_FEE) {
  if (assetId === 0) {
    const net = value - fee;
    return [`${net < 0n ? '−' : '+'}${formatAmount(net < 0n ? -net : net)} BEAM`];
  }
  return [`+${amountText(assetId, value)}`, `−${formatAmount(fee)} BEAM`];
}

let hooked = false;
/** A typed code is a key to someone's funds: forgotten when the wallet locks, with the create draft. */
export function forgetOnLock(app) {
  if (hooked || !app.lockHooks) return;
  hooked = true;
  app.lockHooks.add(() => {
    app.dropDraft = null;
    app.dropCreateDraft = null;
  });
}

export default function airdropClaim(app) {
  forgetOnLock(app);
  const draft = (app.dropDraft = app.dropDraft || { code: '' });
  let check = { state: 'idle' }; // idle | checking | found | notFound | claimed | error
  let claiming = false;
  let done = null; // { assetId, value }
  let result = null;
  let seq = 0;
  let timer = null;
  let alive = true;

  const input = h('input', { class: 'input code-input', type: 'text', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', placeholder: 'XXXX-XXXX-XXXX-XXXX', 'aria-label': 'Code', 'data-testid': 'airdrop-code' });
  input.value = draft.code;
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'airdrop-paste' }, icon('paste'), 'Paste');
  const hint = h('p', { class: 'hint', 'data-testid': 'airdrop-hint' });
  const card = h('div', { 'aria-live': 'polite' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'airdrop-reason', 'aria-live': 'polite' });
  const cta = primary('Claim', claim, { disabled: true, 'data-testid': 'airdrop-cta' });
  const more = h(
    'div',
    { class: 'btn-row' },
    secondary('Create codes', () => app.go('airdropCreate'), { 'data-testid': 'airdrop-create' }),
    secondary('My batches', () => app.go('airdropBatches'), { 'data-testid': 'airdrop-batches' }),
  );
  const body = h('div', { class: 'content' });

  const normalised = () => normaliseCode(input.value);

  function ctaState() {
    const n = normalised();
    if (claiming) return { off: 'Building your claim…' };
    if (!n) return { off: 'Paste the code you were given above.' };
    if (check.state === 'idle') return { off: null, label: 'Check code' };
    if (check.state === 'checking') return { off: 'Checking the code…' };
    if (check.state === 'error') return { off: null, label: 'Check again' };
    if (check.state === 'notFound' || check.state === 'claimed') return { off: 'Check the code above, or paste another one.' };
    const { info } = check;
    if (!wallet.state.sync.canSend) return { off: `Claiming is paused: ${wallet.state.sync.title.toLowerCase().replace(/[.…]+$/, '')}.` };
    // A BEAM voucher pays its own fee when it is worth more than it.
    const need = info.assetId === 0 ? (CALL_FEE > info.value ? CALL_FEE - info.value : 0n) : CALL_FEE;
    if (need > 0n && wallet.available(0) < need) return { off: `Claiming needs ${formatAmount(need)} BEAM for the network fee and this wallet has ${formatAmount(wallet.available(0))} BEAM. Add BEAM, then claim.`, receive: true };
    const worthLess = info.assetId === 0 && info.value <= CALL_FEE;
    return { off: null, label: worthLess ? 'Claim anyway' : `Claim ${amountText(info.assetId, info.value)}` };
  }

  function checkCard() {
    if (check.state === 'checking') return h('div', { class: 'card name-result', 'data-testid': 'airdrop-result', 'data-state': 'checking' }, h('div', { class: 'name-line' }, h('span', { class: 'spinner small' }), h('span', { text: 'Checking the code…' })));
    if (check.state === 'notFound') {
      const el = notice('error', h('strong', { text: 'No voucher has this code. ' }), 'Check it letter by letter; codes never contain I, O, 0 or 1. If it still does not work, ask whoever gave it to you.');
      el.dataset.testid = 'airdrop-result';
      el.dataset.state = 'notFound';
      return el;
    }
    if (check.state === 'claimed') {
      const el = notice('warn', h('strong', { text: 'This code was already claimed. ' }), 'Each code works once. Ask whoever gave it to you for a new one.');
      el.dataset.testid = 'airdrop-result';
      el.dataset.state = 'claimed';
      return el;
    }
    if (check.state === 'error') {
      const el = notice('error', `The code could not be checked: ${check.error.message} `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => checkNow() }, 'Try again'));
      el.dataset.testid = 'airdrop-result';
      el.dataset.state = 'error';
      return el;
    }
    if (check.state !== 'found') return null;
    const { info } = check;
    const worthLess = info.assetId === 0 && info.value <= CALL_FEE;
    const l = wallet.label(info.assetId);
    return h(
      'div',
      { 'data-testid': 'airdrop-result', 'data-state': 'found', class: 'drop-found' },
      h(
        'div',
        { class: 'card flat swap-details' },
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'You get' }), h('span', { class: 'v', 'data-testid': 'airdrop-gets', text: amountText(info.assetId, info.value) })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'airdrop-fee', text: `${formatAmount(CALL_FEE)} BEAM` })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Balance change' }), h('span', { class: 'v', 'data-testid': 'airdrop-net' }, ...balanceChange(info.assetId, info.value).map((t) => h('div', { text: t })))),
      ),
      info.assetId !== 0 && !l.verified ? h('p', { class: 'small', text: `${l.unit} is asset #${info.assetId}: not on BEAM Campfire's list of known assets.` }) : null,
      worthLess ? notice('warn', `This code gives ${amountText(0, info.value)} and claiming it costs ${formatAmount(CALL_FEE)} BEAM, so your balance goes down. Claim only if you want it anyway.`) : null,
    );
  }

  function render() {
    if (!alive) return;
    if (done) return renderDone();
    const n = normalised();
    hint.textContent = n ? `${Math.min(n.length, CODE_LENGTH)} of ${CODE_LENGTH} letters and digits${n.length > CODE_LENGTH ? ' (longer codes are fine if that is what you were given)' : ''}` : 'Codes look like ABCD-EFGH-JKLM-NPQR. Dashes and spaces do not matter.';
    let note = null;
    if (result) {
      note = notice(result.kind, result.text);
      note.dataset.testid = 'airdrop-notice';
      note.dataset.code = result.code || '';
    }
    put(card, checkCard(), note);
    const st = ctaState();
    cta.disabled = Boolean(st.off);
    cta.textContent = st.label || (check.state === 'found' ? `Claim ${amountText(check.info.assetId, check.info.value)}` : 'Claim');
    put(reason, st.off || '', st.receive ? ' ' : null, st.receive ? h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => app.go('receive') }, 'Receive BEAM') : null);
    reason.classList.toggle('hidden', !st.off);
  }

  function renderDone() {
    put(
      body,
      h('div', { class: 'status-icon ok' }, icon('check')),
      h('h2', { class: 'title center', 'data-testid': 'airdrop-done', text: `${amountText(done.assetId, done.value)} is on its way` }),
      h('p', { class: 'center small', text: 'It shows in your balance once the network confirms the claim, usually within 2 minutes.' }),
      h('div', { class: 'actions' }, primary('Done', () => app.go('home'), { 'data-testid': 'airdrop-done-home' }), h('button', { class: 'btn btn-text', onclick: () => {
        done = null;
        app.go('airdrop');
      } }, 'Claim another code')),
    );
  }

  function onInput() {
    // Grouped as typed: ABCD-EFGH-…; the caret stays at the end where it was.
    const atEnd = input.selectionStart === input.value.length;
    const n = normalised();
    if (n.length <= CODE_LENGTH && atEnd) input.value = formatCode(input.value);
    draft.code = input.value;
    result = null;
    clearTimeout(timer);
    seq++;
    check = { state: 'idle' };
    render();
    if (isWellFormedCode(input.value)) {
      check = { state: 'checking' };
      render();
      timer = setTimeout(checkNow, CHECK_DEBOUNCE_MS);
    }
  }

  async function checkNow() {
    const n = normalised();
    if (!n) return;
    const mine = ++seq;
    check = { state: 'checking' };
    render();
    try {
      const info = await airdrop(app).checkVoucher(n);
      if (!alive || mine !== seq) return;
      if (info && info.assetId !== 0 && !wallet.assetNamed.has(info.assetId)) wallet.loadAsset(info.assetId);
      check = !info ? { state: 'notFound' } : info.redeemed ? { state: 'claimed' } : { state: 'found', info };
    } catch (e) {
      if (!alive || mine !== seq) return;
      check = e.code === 'invalidCode' ? { state: 'notFound' } : { state: 'error', error: e };
    }
    render();
  }

  async function claim() {
    const st = ctaState();
    if (st.off) return;
    if (check.state !== 'found') return checkNow();
    const info = check.info;
    claiming = true;
    result = null;
    render();
    try {
      await airdrop(app).redeem(normalised());
      if (!alive) return;
      app.dropDraft = null;
      done = { assetId: info.assetId, value: info.value };
      wallet.refreshTxs();
      wallet.refreshStatus();
    } catch (e) {
      if (!alive) return;
      if (e.code === 'alreadyRedeemed') check = { state: 'claimed' };
      else if (e.code === 'voucherNotFound') check = { state: 'notFound' };
      result = { kind: e.code === 'rejected' ? 'info' : 'error', code: e.code || 'error', text: dropProblemText(e, 'claim') };
    }
    claiming = false;
    render();
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') claim();
  });
  pasteBtn.addEventListener('click', async () => {
    try {
      input.value = (await navigator.clipboard.readText()).trim();
      onInput();
      if (normalised() && !isWellFormedCode(input.value)) checkNow();
    } catch {
      hint.textContent = 'Press and hold in the box, then tap Paste.';
      input.focus();
    }
  });
  const off = wallet.onChange(() => render());

  put(
    body,
    h('p', { class: 'lead', text: 'Got a code? Paste it to see what it gives, then claim it into this wallet.' }),
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'Code' }), pasteBtn), input),
    hint,
    card,
    h('div', { class: 'actions inline-actions' }, reason, cta),
    h('p', { class: 'section-title', text: 'Give tokens away' }),
    h('p', { class: 'small', text: 'Lock tokens into one-time codes and hand them out. Creating costs a 1% airdrop fee and a 0.121 BEAM network fee.' }),
    more,
  );
  render();
  if (isWellFormedCode(input.value)) checkNow();

  const el = screen(
    {
      title: 'Airdrop codes',
      back: () => {
        app.dropDraft = null;
        app.back('home');
      },
      cls: 'airdrop feature',
    },
    body,
  );
  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(timer);
      off();
    },
  };
}
