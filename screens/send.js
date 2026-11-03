/* Send
 * Spec: ONE job: say who gets how much.
 *       Primary CTA: "Review payment" (nothing moves until the next screen is confirmed).
 *       Taps from app open: 1 (Home -> Send), then paste + amount.
 * Exit-intent reasons and answers:
 *   - "Is this address right?" -> checked by the wallet as you paste, with its type in words.
 *   - "Can I pay a name?" -> the same field takes alice.beam: it is looked up as you type, with
 *     its owner key and how a name payment arrives; an address always wins over a name.
 *   - "Is it still the same person?" -> a name this wallet paid before is compared with the owner
 *     key it was paid then; a different one stops here with both keys and an explicit choice
 *     (a name can be sold or expire, and a node can lie about it: audit D-1).
 *   - "How much will it cost?" -> the network fee is shown under the amount, before review.
 *   - "Max leaves dust / fails" -> Max = available minus the fee, exactly.
 *   - "Why is the button grey?" -> the reason is always written next to it.
 *   - "I don't want to paste it again" -> Contacts picks a saved one (its address shown), Scan reads
 *     a QR code with the camera; a checked new address can be saved as a contact. An address that
 *     only looks like a contact's is called out.
 *   - "What was this for?" -> an optional note, kept with the payment in this wallet only.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { parseAmount, formatAmount, toInputString } from '../lib/amount.js';
import { wallet, sendModeFor } from '../lib/wallet.js';
import { classifyRecipient, describeNameProblem, canReceivePayments, display, fingerprint, checkCode, pinVerdict, dateOf, holdEndHeight, STATUS, NAME_CALL_FEE } from '../lib/bans.js';
import { readNamePin, NAME_PIN_UNREAD } from '../lib/contacts.js';
import { bans, day } from './names.js';
import { hiddenIds } from '../lib/hidden_tokens.js';
import { recipientButtons, contactLine, noteField, scannedAmount, otherWalletHint } from './send_extras.js';
import { listWallets } from '../lib/wallets.js';
import { t, asSentence } from '../lib/i18n.js';

/** How a payment to a name goes out: through BEAM's name vault, a contract call. */
const NAME_MODE = {
  fee: NAME_CALL_FEE,
  // In the language of the moment it is read.
  get label() {
    return t('Name payment');
  },
};

export default function send(app) {
  const draft = (app.sendDraft = app.sendDraft || { address: '', amount: '', assetId: 0, note: '' });
  let check = { state: 'empty' }; // empty | checking | ok | bad
  let checkSeq = 0;

  const addr = h('textarea', { class: 'input mono', rows: 3, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: t('Paste a BEAM address, or type a name like alice.beam'), 'aria-label': t('Address or name'), 'data-testid': 'send-address' });
  addr.value = draft.address;
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'paste' }, icon('paste'), t('Paste'));
  const addrHint = h('p', { class: 'hint', 'data-testid': 'address-hint' });
  // Another wallet of this device as the receiver (re-audit RE1-12): how a regular payment to it goes.
  const otherHint = h('p', { class: 'hint', 'data-testid': 'send-other-wallet-hint', hidden: true });
  let walletCount = 1;
  let checkedMode = null;
  const showOtherHint = () => {
    const hint = otherWalletHint({ wallets: walletCount, mode: checkedMode });
    otherHint.textContent = hint || '';
    otherHint.hidden = !hint;
  };
  listWallets().then(
    (l) => {
      walletCount = l.length;
      showOtherHint();
    },
    () => {},
  );
  // A name whose owner changed since this wallet paid it: both keys, and paying the new one is a choice.
  const nameBox = h('div', { class: 'send-slot', 'aria-live': 'polite' });
  const contactInfo = contactLine(app);
  const note = noteField(draft);
  const pickBtns = recipientButtons(app, {
    fill: (r) => {
      addr.value = r.address;
      const a = scannedAmount(r);
      if (a) amount.value = draft.amount = a;
      validate();
    },
    paste: () => pasteBtn.click(),
  });

  const assetSel = h('select', { class: 'input', 'aria-label': t('Asset'), 'data-testid': 'send-asset' });
  const assetField = h('label', { class: 'field' }, t('Asset'), assetSel);

  const amount = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': t('Amount'), 'data-testid': 'send-amount' });
  amount.value = draft.amount;
  const unitLabel = h('span', { class: 'small' });
  const maxBtn = h('button', { class: 'btn btn-secondary btn-small inside', type: 'button', 'data-testid': 'max' }, t('Max'));
  const amountHint = h('p', { class: 'hint' });
  const feeLine = h('div', { class: 'kv' });
  const syncMsg = h('div', { class: 'send-slot' });
  const cta = primary(t('Review payment'), review, { disabled: true, 'data-testid': 'review' });

  function assets() {
    const list = [[0, wallet.state.totals.get(0) || { available: 0n }]];
    // Tokens hidden from Wallet are left out, as in the desktop's pickers, unless it is the one chosen (its page's Send).
    const hidden = hiddenIds(app);
    for (const [id, tot] of wallet.state.totals) if (id !== 0 && tot.available > 0n && (!hidden.has(id) || id === Number(draft.assetId))) list.push([id, tot]);
    return list;
  }

  function fillAssets() {
    const list = assets();
    const cur = String(draft.assetId);
    put(assetSel, ...list.map(([id, tot]) => h('option', { value: String(id), text: t('{unit} ({amount} available)', { unit: wallet.distinctUnit(id), amount: formatAmount(tot.available) }) })));
    assetSel.value = list.some(([id]) => String(id) === cur) ? cur : '0';
    draft.assetId = Number(assetSel.value);
    assetField.classList.toggle('hidden', list.length < 2);
  }

  function mode() {
    if (check.state === 'ok' && check.name) return NAME_MODE;
    return (check.state === 'ok' && sendModeFor(check.type)) || sendModeFor('regular');
  }

  /** Both owner keys of a name that changed owner since this wallet paid it, and the choice to pay the new one. */
  function ownerChangedCard(name, before, now) {
    return h(
      'div',
      { class: 'card', 'data-testid': 'name-changed' },
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('You paid before') }), h('span', { class: 'v mono', 'data-testid': 'name-before', text: checkCode(before) })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Owner now') }), h('span', { class: 'v mono', 'data-testid': 'name-now', text: checkCode(now) })),
      h(
        'button',
        {
          class: 'btn btn-secondary btn-small',
          type: 'button',
          'data-testid': 'name-accept-new',
          onclick: () => {
            draft.acceptedOwner = { name, key: now };
            validate();
          },
        },
        t('They confirmed it: pay the new owner'),
      ),
    );
  }

  /** A typed name: looked up on the wallet's own node; only a name that accepts payments is ok. */
  async function resolveName(name, seq) {
    check = { state: 'checking' };
    addrHint.textContent = t('Looking up {name}…', { name: display(name) });
    addrHint.className = 'hint';
    evaluate();
    try {
      const r = await bans().resolve(name);
      if (seq !== checkSeq) return;
      const payable = canReceivePayments(r.status) && Boolean(r.ownerKey);
      // The owner key this wallet paid the name before, kept sealed with the contacts. Unreadable:
      // nothing to compare with, and the person is told so (audit BC-3), never "as if never paid".
      const pin = payable ? await readNamePin(app, name) : { key: null, unread: false };
      const pinned = pin.key;
      if (seq !== checkSeq) return;
      const accepted = draft.acceptedOwner && draft.acceptedOwner.name === name ? draft.acceptedOwner.key : null;
      const verdict = payable ? pinVerdict({ pinned, now: r.ownerKey, accepted }) : 'first';
      if (verdict === 'changed') {
        check = { state: 'bad' };
        addrHint.textContent = t('{name} now has a different owner than when you last paid it. Names can be sold, given away or expire, and a node can answer wrongly: check with the person before you pay.', { name: display(name) });
        addrHint.className = 'hint bad';
        put(nameBox, ownerChangedCard(name, pinned, r.ownerKey));
      } else if (payable) {
        const clock = { tipHeight: r.tipHeight, tipTime: r.tipTime };
        check = { state: 'ok', name, ownerKey: r.ownerKey, pinnedKey: pinned, pinUnread: pin.unread, acceptedKey: verdict === 'accepted' ? r.ownerKey : null };
        const parts = [
          r.status !== STATUS.onHold
            ? t('{name}: registered name, owner key {key}, active until {date}.', { name: display(name), key: fingerprint(r.ownerKey), date: day(dateOf(r.domain.expireHeight, clock)) })
            : t('{name}: registered name, owner key {key}.', { name: display(name), key: fingerprint(r.ownerKey) }),
        ];
        if (verdict === 'same') parts.push(t('The same owner as your last payment to it.'));
        if (verdict === 'accepted') parts.push(t('You chose to pay its new owner.'));
        if (pin.unread) parts.push(t(NAME_PIN_UNREAD));
        parts.push(t('Anonymous name payment: the amount is visible on the blockchain, the recipient is not. They claim it from their wallet.'));
        if (r.status === STATUS.onHold) parts.push(t("This name has lapsed: payments still reach its owner, who can renew it until {date}. If they don't, it can pass to someone else.", { date: day(dateOf(holdEndHeight(r.domain.expireHeight), clock)) }));
        if (r.status === STATUS.forSale) parts.push(t('It is listed for sale and may change owner before your payment arrives.'));
        if (!r.inSync) parts.push(t('Your wallet was still catching up, so this may be out of date; it is checked again before anything is sent.'));
        addrHint.textContent = parts.join(' ');
        addrHint.className = r.status === STATUS.onHold || pin.unread ? 'hint' : 'hint good'; // i18n-ignore: CSS classes
      } else {
        check = { state: 'bad' };
        addrHint.textContent =
          r.status === STATUS.availableAgain
            ? t('{name} has expired; payments to it are refused. Ask the person for their address or their new name.', { name: display(name) })
            : t("No one owns {name}, and it isn't a BEAM address. Check the spelling, or ask for their address.", { name: display(name) });
        addrHint.className = 'hint bad';
      }
    } catch (e) {
      if (seq !== checkSeq) return;
      check = { state: 'bad' };
      addrHint.textContent = t("Couldn't check {name}: {reason} Type it again to retry.", { name: display(name), reason: e.message });
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
    const tot = wallet.state.totals.get(id) || { available: 0n };
    const beam = wallet.state.totals.get(0) || { available: 0n };
    const fee = mode().fee;
    put(feeLine, h('span', { class: 'k', text: t('Network fee') }), h('span', { class: 'v', 'data-testid': 'fee', text: `${formatAmount(fee)} BEAM` })); // i18n-ignore: an amount and its ticker
    let amt = null;
    let amtErr = null;
    if (amount.value.trim()) {
      try {
        amt = parseAmount(amount.value);
        if (amt <= 0n) amtErr = t('The amount must be more than zero.');
      } catch (e) {
        amtErr = e.message;
      }
    }
    if (amt != null && !amtErr) {
      if (id === 0 && amt + fee > tot.available) amtErr = t("That's more than you have. Up to {amount} BEAM after the fee.", { amount: formatAmount(tot.available > fee ? tot.available - fee : 0n) });
      else if (id !== 0 && amt > tot.available) amtErr = t("That's more than you have ({amount} {unit}).", { amount: formatAmount(tot.available), unit });
      else if (id !== 0 && fee > beam.available) amtErr = t('The fee is paid in BEAM, and you have {amount} BEAM.', { amount: formatAmount(beam.available) });
    }
    amountHint.textContent = amtErr || t('Available: {amount} {unit}', { amount: formatAmount(tot.available), unit });
    amountHint.className = 'hint' + (amtErr ? ' bad' : '');
    amount.classList.toggle('bad', Boolean(amtErr));

    const sync = wallet.state.sync;
    put(syncMsg, sync.canSend ? null : notice('warn', `${asSentence(sync.title)}${sync.detail}`));
    contactInfo.update(addr.value.trim(), { ok: check.state === 'ok' && !check.name, name: Boolean(check.name) });
    note.setToName(Boolean(check.state === 'ok' && check.name) || classifyRecipient(addr.value).kind === 'name');
    const ok = check.state === 'ok' && amt != null && !amtErr && sync.canSend;
    cta.disabled = !ok;
    return ok ? { amount: amt, fee, assetId: id } : null;
  }

  async function validate() {
    const a = addr.value.trim();
    draft.address = a;
    checkedMode = null;
    showOtherHint();
    const seq = ++checkSeq;
    put(nameBox);
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
      addrHint.textContent = `${t("This isn't a BEAM address or a name.")} ${kind.problem === 'invalidCharacter' ? t('Names use only lowercase letters, numbers, - _ and ~.') : describeNameProblem(kind.problem)}`;
      addrHint.className = 'hint bad';
      addr.classList.add('bad');
      addr.classList.remove('good');
      return evaluate();
    }
    check = { state: 'checking' };
    addrHint.textContent = t('Checking the address…');
    addrHint.className = 'hint';
    evaluate();
    try {
      const r = await wallet.validateAddress(a);
      if (seq !== checkSeq) return;
      const m = r && r.is_valid ? sendModeFor(r.type) : null;
      checkedMode = m && !r.is_mine ? m : null;
      showOtherHint();
      if (!m) {
        check = { state: 'bad' };
        addrHint.textContent = t("This isn't a BEAM address. Copy it again from the person you're paying.");
        addrHint.className = 'hint bad';
      } else if (r.is_mine) {
        check = { state: 'bad' };
        addrHint.textContent = t("This is one of your own addresses. Paste the receiver's address.");
        addrHint.className = 'hint bad';
      } else {
        check = { state: 'ok', type: r.type };
        addrHint.textContent = m.receiverMustBeOnline ? t('{type}. The receiver must come online within about 12 hours.', { type: m.label }) : t('{type}. Arrives even if the receiver is offline.', { type: m.label });
        addrHint.className = 'hint good';
      }
      addr.classList.toggle('bad', check.state === 'bad');
      addr.classList.toggle('good', check.state === 'ok');
    } catch (e) {
      if (seq !== checkSeq) return;
      check = { state: 'bad' };
      addrHint.textContent = t('The address could not be checked: {reason}', { reason: e.message });
      addrHint.className = 'hint bad';
    }
    evaluate();
  }

  let timer = null;
  addr.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(validate, 350);
  });
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      addr.value = text.trim();
      validate();
    } catch {
      addrHint.textContent = t('Press and hold in the box, then tap Paste.');
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
    if (check.name) return app.go('review', { kind: 'name', name: check.name, ownerKey: check.ownerKey, pinnedKey: check.pinnedKey, pinUnread: Boolean(check.pinUnread), acceptedKey: check.acceptedKey, amount: ok.amount, fee: ok.fee, assetId: ok.assetId });
    app.go('review', { address: draft.address, amount: ok.amount, fee: ok.fee, assetId: ok.assetId, type: check.type, note: note.value() });
  }

  fillAssets();
  const off = wallet.onChange(() => evaluate());
  if (draft.address) validate();
  else evaluate();

  const el = screen(
    {
      title: t('Send'),
      back: () => {
        app.sendDraft = null;
        app.back('home');
      },
      actions: [cta],
      // Sticky: a name's owner check, a look-alike warning or a note push the button down; it
      // stays in view (one primary action, visible on a 375x667 phone without scrolling).
      cls: 'plain sticky-actions',
    },
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: t('To') }), ...pickBtns, pasteBtn), addr),
    addrHint,
    otherHint,
    nameBox,
    contactInfo.el,
    assetField,
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: t('Amount') }), unitLabel), h('div', { class: 'input-wrap' }, amount, maxBtn)),
    amountHint,
    h('div', { class: 'card flat' }, feeLine),
    note.el,
    syncMsg,
  );
  return { el, destroy: () => off() };
}
