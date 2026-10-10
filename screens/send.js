/* Send
 * Spec: ONE job: say who gets how much.
 *       Primary CTA: "Review payment" (nothing moves until the next screen is confirmed).
 *       Taps from app open: 1 (Home -> Send), then paste + amount.
 * Exit-intent reasons and answers:
 *   - "Is this address right?" -> checked by the wallet as you paste, with its type in words.
 *   - "Can I pay a name?" -> the same field takes alice.beam: it is looked up as you type, with
 *     its owner key and how a name payment arrives; an address always wins over a name.
 *   - "How much will it cost?" -> the network fee is shown under the amount, before review.
 *   - "Max leaves dust / fails" -> Max = available minus the fee, exactly.
 *   - "Why is the button grey?" -> the reason is always written next to it.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { parseAmount, formatAmount, toInputString } from '../lib/amount.js';
import { wallet, sendModeFor } from '../lib/wallet.js';
import { classifyRecipient, describeNameProblem, canReceivePayments, display, fingerprint, dateOf, holdEndHeight, STATUS, NAME_CALL_FEE } from '../lib/bans.js';
import { bans, day } from './names.js';

/** How a payment to a name goes out: through BEAM's name vault, a contract call. */
const NAME_MODE = { fee: NAME_CALL_FEE, label: 'Name payment' };

export default function send(app) {
  const draft = (app.sendDraft = app.sendDraft || { address: '', amount: '', assetId: 0 });
  let check = { state: 'empty' }; // empty | checking | ok | bad
  let checkSeq = 0;

  const addr = h('textarea', { class: 'input mono', rows: 3, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'Paste a BEAM address, or type a name like alice.beam', 'aria-label': 'Address or name', 'data-testid': 'send-address' });
  addr.value = draft.address;
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'paste' }, icon('paste'), 'Paste');
  const addrHint = h('p', { class: 'hint', 'data-testid': 'address-hint' });

  const assetSel = h('select', { class: 'input', 'aria-label': 'Asset', 'data-testid': 'send-asset' });
  const assetField = h('label', { class: 'field' }, 'Asset', assetSel);

  const amount = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount', 'data-testid': 'send-amount' });
  amount.value = draft.amount;
  const unitLabel = h('span', { class: 'small' });
  const maxBtn = h('button', { class: 'btn btn-secondary btn-small inside', type: 'button', 'data-testid': 'max' }, 'Max');
  const amountHint = h('p', { class: 'hint' });
  const feeLine = h('div', { class: 'kv' });
  const syncMsg = h('div');
  const cta = primary('Review payment', review, { disabled: true, 'data-testid': 'review' });

  function assets() {
    const list = [[0, wallet.state.totals.get(0) || { available: 0n }]];
    for (const [id, t] of wallet.state.totals) if (id !== 0 && t.available > 0n) list.push([id, t]);
    return list;
  }

  function fillAssets() {
    const list = assets();
    const cur = String(draft.assetId);
    put(assetSel, ...list.map(([id, t]) => h('option', { value: String(id), text: `${wallet.label(id).unit} (${formatAmount(t.available)} available)` })));
    assetSel.value = list.some(([id]) => String(id) === cur) ? cur : '0';
    draft.assetId = Number(assetSel.value);
    assetField.classList.toggle('hidden', list.length < 2);
  }

  function mode() {
    if (check.state === 'ok' && check.name) return NAME_MODE;
    return (check.state === 'ok' && sendModeFor(check.type)) || sendModeFor('regular');
  }

  /** A typed name: looked up on the wallet's own node; only a name that accepts payments is ok. */
  async function resolveName(name, seq) {
    check = { state: 'checking' };
    addrHint.textContent = `Looking up ${display(name)}…`;
    addrHint.className = 'hint';
    evaluate();
    try {
      const r = await bans().resolve(name);
      if (seq !== checkSeq) return;
      if (canReceivePayments(r.status) && r.ownerKey) {
        const clock = { tipHeight: r.tipHeight, tipTime: r.tipTime };
        check = { state: 'ok', name, ownerKey: r.ownerKey };
        const parts = [`${display(name)}: registered name, owner key ${fingerprint(r.ownerKey)}${r.status !== STATUS.onHold ? `, active until ${day(dateOf(r.domain.expireHeight, clock))}` : ''}.`];
        parts.push('Anonymous name payment: the amount is visible on the blockchain, the recipient is not. They claim it from their wallet.');
        if (r.status === STATUS.onHold) parts.push(`This name has lapsed: payments still reach its owner, who can renew it until ${day(dateOf(holdEndHeight(r.domain.expireHeight), clock))}. If they don't, it can pass to someone else.`);
        if (r.status === STATUS.forSale) parts.push('It is listed for sale and may change owner before your payment arrives.');
        if (!r.inSync) parts.push('Your wallet was still catching up, so this may be out of date; it is checked again before anything is sent.');
        addrHint.textContent = parts.join(' ');
        addrHint.className = r.status === STATUS.onHold ? 'hint' : 'hint good';
      } else {
        check = { state: 'bad' };
        addrHint.textContent =
          r.status === STATUS.availableAgain
            ? `${display(name)} has expired; payments to it are refused. Ask the person for their address or their new name.`
            : `No one owns ${display(name)}, and it isn't a BEAM address. Check the spelling, or ask for their address.`;
        addrHint.className = 'hint bad';
      }
    } catch (e) {
      if (seq !== checkSeq) return;
      check = { state: 'bad' };
      addrHint.textContent = `Couldn't check ${display(name)}: ${e.message} Type it again to retry.`;
      addrHint.className = 'hint bad';
    }
    addr.classList.toggle('bad', check.state === 'bad');
    addr.classList.toggle('good', check.state === 'ok');
    evaluate();
  }

  function evaluate() {
    const id = Number(draft.assetId);
    const unit = wallet.label(id).unit;
    unitLabel.textContent = unit;
    const t = wallet.state.totals.get(id) || { available: 0n };
    const beam = wallet.state.totals.get(0) || { available: 0n };
    const fee = mode().fee;
    put(feeLine, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'fee', text: `${formatAmount(fee)} BEAM` }));
    let amt = null;
    let amtErr = null;
    if (amount.value.trim()) {
      try {
        amt = parseAmount(amount.value);
        if (amt <= 0n) amtErr = 'The amount must be more than zero.';
      } catch (e) {
        amtErr = e.message;
      }
    }
    if (amt != null && !amtErr) {
      if (id === 0 && amt + fee > t.available) amtErr = `That's more than you have. Up to ${formatAmount(t.available > fee ? t.available - fee : 0n)} BEAM after the fee.`;
      else if (id !== 0 && amt > t.available) amtErr = `That's more than you have (${formatAmount(t.available)} ${unit}).`;
      else if (id !== 0 && fee > beam.available) amtErr = `The fee is paid in BEAM, and you have ${formatAmount(beam.available)} BEAM.`;
    }
    amountHint.textContent = amtErr || `Available: ${formatAmount(t.available)} ${unit}`;
    amountHint.className = 'hint' + (amtErr ? ' bad' : '');
    amount.classList.toggle('bad', Boolean(amtErr));

    const sync = wallet.state.sync;
    put(syncMsg, sync.canSend ? null : notice('warn', `${sync.title}. ${sync.detail}`));
    const ok = check.state === 'ok' && amt != null && !amtErr && sync.canSend;
    cta.disabled = !ok;
    return ok ? { amount: amt, fee, assetId: id } : null;
  }

  async function validate() {
    const a = addr.value.trim();
    draft.address = a;
    const seq = ++checkSeq;
    if (!a) {
      check = { state: 'empty' };
      addrHint.textContent = '';
      addrHint.className = 'hint';
      addr.classList.remove('bad', 'good');
      return evaluate();
    }
    const kind = classifyRecipient(a);
    if (kind.kind === 'name') return resolveName(kind.name, seq);
    if (kind.kind === 'invalid') {
      check = { state: 'bad' };
      addrHint.textContent = `This isn't a BEAM address or a name. ${kind.problem === 'invalidCharacter' ? 'Names use only lowercase letters, numbers, - _ and ~.' : describeNameProblem(kind.problem)}`;
      addrHint.className = 'hint bad';
      addr.classList.add('bad');
      addr.classList.remove('good');
      return evaluate();
    }
    check = { state: 'checking' };
    addrHint.textContent = 'Checking the address…';
    addrHint.className = 'hint';
    evaluate();
    try {
      const r = await wallet.validateAddress(a);
      if (seq !== checkSeq) return;
      const m = r && r.is_valid ? sendModeFor(r.type) : null;
      if (!m) {
        check = { state: 'bad' };
        addrHint.textContent = "This isn't a BEAM address. Copy it again from the person you're paying.";
        addrHint.className = 'hint bad';
      } else if (r.is_mine) {
        check = { state: 'bad' };
        addrHint.textContent = "This is one of your own addresses. Paste the receiver's address.";
        addrHint.className = 'hint bad';
      } else {
        check = { state: 'ok', type: r.type };
        addrHint.textContent = `${m.label}. ${m.receiverMustBeOnline ? 'The receiver must come online within about 12 hours.' : 'Arrives even if the receiver is offline.'}`;
        addrHint.className = 'hint good';
      }
      addr.classList.toggle('bad', check.state === 'bad');
      addr.classList.toggle('good', check.state === 'ok');
    } catch (e) {
      if (seq !== checkSeq) return;
      check = { state: 'bad' };
      addrHint.textContent = `The address could not be checked: ${e.message}`;
      addrHint.className = 'hint bad';
    }
    evaluate();
  }

  let t = null;
  addr.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(validate, 350);
  });
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      addr.value = text.trim();
      validate();
    } catch {
      addrHint.textContent = 'Press and hold in the box, then tap Paste.';
      addrHint.className = 'hint';
      addr.focus();
    }
  });
  amount.addEventListener('input', () => {
    draft.amount = amount.value;
    evaluate();
  });
  assetSel.addEventListener('change', () => {
    draft.assetId = Number(assetSel.value);
    evaluate();
  });
  maxBtn.addEventListener('click', () => {
    const id = Number(draft.assetId);
    const t2 = wallet.state.totals.get(id) || { available: 0n };
    const fee = id === 0 ? mode().fee : 0n;
    const max = t2.available > fee ? t2.available - fee : 0n;
    amount.value = toInputString(max);
    draft.amount = amount.value;
    evaluate();
  });

  function review() {
    const ok = evaluate();
    if (!ok) return;
    if (check.name) return app.go('review', { kind: 'name', name: check.name, ownerKey: check.ownerKey, amount: ok.amount, fee: ok.fee, assetId: ok.assetId });
    app.go('review', { address: draft.address, amount: ok.amount, fee: ok.fee, assetId: ok.assetId, type: check.type });
  }

  fillAssets();
  const off = wallet.onChange(() => evaluate());
  if (draft.address) validate();
  else evaluate();

  const el = screen(
    {
      title: 'Send',
      back: () => {
        app.sendDraft = null;
        app.back('home');
      },
      actions: [cta],
      cls: 'plain',
    },
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'To' }), pasteBtn), addr),
    addrHint,
    assetField,
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'Amount' }), unitLabel), h('div', { class: 'input-wrap' }, amount, maxBtn)),
    amountHint,
    h('div', { class: 'card flat' }, feeLine),
    syncMsg,
  );
  return { el, destroy: () => off() };
}
