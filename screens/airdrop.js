/* Airdrop codes: claim a code
 * Spec: ONE job: turn an airdrop code into tokens in this wallet.
 *       Primary CTA: "Claim 5 bETH" (the approve sheet that follows shows the amount and the fee).
 *       Taps from app open: 1 (Home -> Airdrop codes), paste the code (2), 3 ("Claim ..."), then approve.
 * Exit-intent reasons and answers:
 *   - "What will I get, and what does it cost?" -> the code is checked as soon as it is complete:
 *     what it gives, the network fee, and what the balance really gains, before any button.
 *   - "I have no BEAM for the fee" -> a code whose maker paid its fee says so ("No BEAM needed") and
 *     claims from an empty wallet; any other says exactly how much BEAM it needs, with Receive BEAM.
 *   - "The code doesn't work" -> says why (not found, already claimed) and what to check.
 *   - "It costs more than it gives" -> said in plain numbers before claiming.
 *   - "Did I get it?" -> after approving: sent, then received once the network confirms it (only
 *     then); if it does not go through, what happened and that nothing left the wallet.
 *   - "I want to give codes away" -> Create codes and My batches sit right under the button.
 *   - "Can someone take my code?" -> said with the code it found, in the words of its contract.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { walletStore } from '../lib/wallet_scope.js';
import { codeVault, resealCodeVault, normaliseCode, formatCode, isWellFormedCode, CODE_LENGTH } from '../lib/airdrop.js';
import { airdropFor, claimCost, createFee } from '../lib/airdrop_v3.js';
import { scanCode } from './scan_sheet.js';
import { syncReason } from '../lib/sync.js';

const CHECK_DEBOUNCE_MS = 300;
const CLAIM_POLL_MS = 5000;

/**
 * What a code on the old airdrop contract is, said where its codes are claimed (issue #17), in the
 * app's words (lib/widgets/beam/airdrop/airdrop_text.dart AirdropBearerText). That contract redeems
 * with the code itself, so a claim carries the code in a transaction the network sees before it is
 * in a block; BEAM Campfire cannot change that contract, so it says so.
 */
export const BEARER_TEXT = Object.freeze({
  createTitle: 'Codes work like cash',
  createMessage:
    'Anyone who has a code can claim it. Claiming also shows the code to the network before it is confirmed, so someone watching could claim it first. Use codes for small amounts, and give each one to one person.',
  claimMessage:
    'Claiming shows this code to the network before it is confirmed, so someone watching could claim it first. That is how this airdrop contract works; codes are meant for small amounts.',
});

/**
 * The same for Airdrop v3, where every new code is made. A claim there is signed with a key made
 * from the code, so the code never reaches the network and a copied claim pays only its claimer.
 * The code itself still works like cash, and its maker can take it back until a claim is confirmed.
 */
export const BEARER_TEXT_V3 = Object.freeze({
  createTitle: 'Codes work like cash',
  createMessage:
    'Anyone who has a code can claim it, so give each code only to its person. Claiming never shows the code to the network, so nobody watching can take it. Codes nobody has claimed can be taken back.',
  claimMessage:
    'The network never sees this code, so nobody watching can take your claim. Until the claim is confirmed, anyone else who has the code could still claim it first, and whoever made it could still take it back.',
});

/** The airdrop for the running wallet (one per session). Codes are kept encrypted in this wallet's storage. */
export function airdrop(app) {
  return airdropFor(wallet.session, {
    vault: async () => {
      if (!app.dbPass || !app.record) throw Object.assign(new Error('Unlock the wallet first.'), { code: 'noCodeStore' });
      // Bound to this wallet: codes saved after a switch still go to their own wallet. An imported
      // wallet's secret is its password: its codes are sealed with PBKDF2 (lib/airdrop.js codeVault).
      return codeVault({ kv: walletStore(app.record), walletId: app.record.id, secret: app.dbPass, imported: Boolean(app.record.imported) });
    },
    txStatus: (txId) => wallet.txStatus(txId),
    tipHeight: async () => Number(wallet.state.status && wallet.state.status.current_height) || 0,
  });
}

/**
 * After an unlock (screens/unlock.js): an imported wallet's codes saved by an earlier version under
 * one HKDF over its password are sealed again with PBKDF2, every code kept. Nothing for any other
 * wallet, or when there are no codes. Never stops the unlock: the next one tries again.
 */
export function resealAirdropCodes(app) {
  if (!app.dbPass || !app.record || !app.record.imported) return Promise.resolve(false);
  return resealCodeVault({ kv: walletStore(app.record), walletId: app.record.id, secret: app.dbPass, imported: true }).catch((e) => {
    console.warn('[campfire] airdrop codes: re-seal later:', e && e.message);
    return false;
  });
}

/** "5 bETH" with every digit. */
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

const beamLine = (v) => `${v < 0n ? '−' : '+'}${formatAmount(v < 0n ? -v : v)} BEAM`;

/** What the balance really gains, one line per asset: ["+5 bETH", "+0.001 BEAM"], or for a BEAM voucher the net. */
export function balanceChange(info) {
  const c = claimCost(info);
  if (info.assetId === 0) return [beamLine(c.beamChange)];
  return [`+${amountText(info.assetId, info.value)}`, ...(c.beamChange !== 0n ? [beamLine(c.beamChange)] : [])];
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
  let done = null; // { info, txId, code, status: sent | received | failed }
  let result = null;
  let seq = 0;
  let timer = null;
  let pollTimer = null;
  let alive = true;

  const input = h('input', { class: 'input code-input', type: 'text', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', placeholder: 'XXXX-XXXX-XXXX-XXXX', 'aria-label': 'Code', 'data-testid': 'airdrop-code' });
  input.value = draft.code;
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'airdrop-paste' }, icon('paste'), 'Paste');
  const scanBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'airdrop-scan', 'aria-label': 'Scan a QR code' }, icon('scan'), 'Scan');
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
    if (!wallet.state.sync.canSend) return { off: `Claiming is paused: ${syncReason(wallet.state.sync.title)}.` };
    // What the claim brings in of BEAM (a prepaid fee, a BEAM voucher) pays the fee first.
    const c = claimCost(info);
    if (c.need > 0n && wallet.available(0) < c.need) return { off: `Claiming needs ${formatAmount(c.need)} BEAM for the network fee and this wallet has ${formatAmount(wallet.available(0))} BEAM. Add BEAM, then claim.`, receive: true };
    const worthLess = info.assetId === 0 && c.beamChange <= 0n;
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
    const c = claimCost(info);
    const worthLess = info.assetId === 0 && c.beamChange <= 0n;
    // A token code whose maker paid its fee: claimable with no BEAM at all.
    const free = info.assetId !== 0 && c.need === 0n;
    const l = wallet.label(info.assetId);
    const row = (k, sub, v, testid) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k, sub ? h('div', { class: 'small', text: sub }) : null), h('span', { class: 'v', 'data-testid': testid }, ...(Array.isArray(v) ? v.map((t) => h('div', { text: t })) : [v])));
    const gasless = free ? notice('success', h('strong', { text: 'No BEAM needed. ' }), 'Whoever made this code paid its network fee, so you can claim it even with an empty wallet.') : null;
    if (gasless) gasless.dataset.testid = 'airdrop-gasless';
    return h(
      'div',
      { 'data-testid': 'airdrop-result', 'data-state': 'found', 'data-contract': info.contract, class: 'drop-found' },
      gasless,
      h(
        'div',
        { class: 'card flat swap-details' },
        row('You get', null, amountText(info.assetId, info.value), 'airdrop-gets'),
        row('Network fee', c.codePaysFee ? 'Paid by the code' : null, `${formatAmount(c.fee)} BEAM`, 'airdrop-fee'),
        row('Balance change', null, balanceChange(info), 'airdrop-net'),
      ),
      info.assetId !== 0 && !l.verified ? h('p', { class: 'small', text: `${l.symbol} is asset #${info.assetId}: not on BEAM Campfire's list of known assets.` }) : null,
      worthLess ? notice('warn', `This code gives ${amountText(0, info.value)} and claiming it costs ${formatAmount(c.fee)} BEAM, so your balance goes down. Claim only if you want it anyway.`) : null,
      h('p', { class: 'small', 'data-testid': 'airdrop-bearer', text: info.contract === 'v3' ? BEARER_TEXT_V3.claimMessage : BEARER_TEXT.claimMessage }),
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

  /** Sent, then received only once the network confirms it; or what happened when it did not go through. */
  function renderDone() {
    const what = amountText(done.info.assetId, done.info.value);
    const again = () => {
      const code = done.code;
      done = null;
      clearTimeout(pollTimer);
      input.value = formatCode(code);
      draft.code = input.value;
      check = { state: 'idle' };
      put(body, ...formParts());
      onInput();
    };
    const another = h('button', { class: 'btn btn-text', 'data-testid': 'airdrop-done-another', onclick: () => {
      done = null;
      app.go('airdrop');
    } }, 'Claim another code');
    if (done.status === 'received') {
      put(
        body,
        h('div', { class: 'status-icon ok' }, icon('check')),
        h('h2', { class: 'title center', 'data-testid': 'airdrop-done', 'data-status': 'received', text: `${what} received` }),
        h('p', { class: 'center small', text: 'The network confirmed your claim. It is in your balance now.' }),
        h('div', { class: 'actions' }, primary('Done', () => app.go('home'), { 'data-testid': 'airdrop-done-home' }), another),
      );
      return;
    }
    if (done.status === 'failed') {
      put(
        body,
        h('div', { class: 'status-icon bad' }, icon('close')),
        h('h2', { class: 'title center', 'data-testid': 'airdrop-done', 'data-status': 'failed', text: 'The claim did not go through' }),
        h('p', { class: 'center small', text: 'Nothing left your wallet. Someone else may have claimed the code first, or whoever made it took it back. Check the code again to see.' }),
        h('div', { class: 'actions' }, primary('Check the code again', again, { 'data-testid': 'airdrop-done-again' }), h('button', { class: 'btn btn-text', onclick: () => app.go('home') }, 'Done')),
      );
      return;
    }
    put(
      body,
      h('div', { class: 'status-icon wait' }, icon('clock')),
      h('h2', { class: 'title center', 'data-testid': 'airdrop-done', 'data-status': 'sent', text: 'Claim sent' }),
      h('p', { class: 'center small', text: `${what} is yours once the network confirms the claim, usually within 2 minutes. You can leave this screen; it shows in your balance then.` }),
      h('div', { class: 'actions' }, primary('Done', () => app.go('home'), { 'data-testid': 'airdrop-done-home' }), another),
    );
  }

  async function pollClaim() {
    clearTimeout(pollTimer);
    if (!alive || !done || done.status !== 'sent' || !done.txId) return;
    try {
      const t = await wallet.txStatus(done.txId);
      const s = Number(t && t.status);
      if (!alive || !done) return;
      if (s === 3) done.status = 'received';
      else if (s === 4 || s === 2) done.status = 'failed';
      if (done.status !== 'sent') {
        wallet.refreshTxs();
        wallet.refreshStatus();
        render();
        return;
      }
    } catch {
      /* asked again shortly */
    }
    pollTimer = setTimeout(pollClaim, CLAIM_POLL_MS);
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
      // Airdrop v3 first, then the old contract.
      const info = await airdrop(app).checkVoucher(input.value);
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
    const code = input.value;
    claiming = true;
    result = null;
    render();
    try {
      const r = await airdrop(app).redeem(code);
      if (!alive) return;
      app.dropDraft = null;
      done = { info: r.info, txId: r.txId, code: normaliseCode(code), status: 'sent' };
      wallet.refreshTxs();
      wallet.refreshStatus();
      pollTimer = setTimeout(pollClaim, CLAIM_POLL_MS);
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
  scanBtn.addEventListener('click', async () => {
    const r = await scanCode();
    if (!r) return;
    if (r.paste) return pasteBtn.click();
    input.value = formatCode(r.code);
    onInput();
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

  const formParts = () => [
    h('p', { class: 'lead', text: 'Got a code? Paste it to see what it gives, then claim it into this wallet.' }),
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'Code' }), scanBtn, pasteBtn), input),
    hint,
    card,
    h('div', { class: 'actions inline-actions' }, reason, cta),
    h('p', { class: 'section-title', text: 'Give tokens away' }),
    h('p', { class: 'small', 'data-testid': 'airdrop-give-note', text: `Lock tokens into one-time codes and hand them out. Creating costs a 1% airdrop fee and a network fee that grows with the number of codes (${formatAmount(createFee(10))} BEAM for 10).` }),
    more,
  ];
  put(body, ...formParts());
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
      clearTimeout(pollTimer);
      off();
    },
  };
}
