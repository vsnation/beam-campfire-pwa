// Send's additions: pick a contact, scan a QR code, the line that says whose
// address it is (or that it only looks like a contact's), and the note. Kept
// out of send.js so that screen stays one job: who gets how much.
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { notice, textButton } from '../lib/ui.js';
import { toInputString } from '../lib/amount.js';
import { cachedContacts, findByAddress, lookalikeOf, loadContacts } from '../lib/contacts.js';
import { cleanNote, noteHint, NOTE_MAX } from '../lib/payments.js';
import { shortAddress } from '../lib/addresses.js';
import { pickContact, contactForm } from './contacts.js';
import { scanAddress } from './scan_sheet.js';

/**
 * Paying another wallet of this device (re-audit RE1-12): one wallet runs in one tab at a time, and
 * a regular payment needs the receiver's wallet open too. Which wallet an address is cannot be
 * known while that wallet is locked (its addresses are only in its own encrypted file, and none
 * are kept anywhere else), so this is said for a regular address whenever the device has another.
 */
export const OTHER_WALLET_HINT = 'Paying another of your wallets here? A regular payment needs both open, and only one can be: use its offline address, or after sending, switch to it and then back.';

/** OTHER_WALLET_HINT when it applies: `wallets` on this device, `mode` the checked address's (lib/wallet.js sendModeFor). */
export function otherWalletHint({ wallets, mode }) {
  return wallets > 1 && mode && mode.receiverMustBeOnline ? OTHER_WALLET_HINT : null;
}

/**
 * The Contacts and Scan buttons beside Paste. fill({address, amount?}) puts what
 * was picked or scanned into the form; paste() runs Paste.
 */
export function recipientButtons(app, { fill, paste }) {
  const contactsBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'send-contacts', 'aria-label': 'Pay a contact' }, icon('person'), 'Contacts');
  const scanBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'send-scan', 'aria-label': 'Scan a QR code' }, icon('scan'), 'Scan');
  contactsBtn.addEventListener('click', async () => {
    const c = await pickContact(app);
    if (c) fill({ address: c.address });
  });
  scanBtn.addEventListener('click', async () => {
    const r = await scanAddress({ title: 'Scan an address' });
    if (r && r.paste) return paste();
    if (r && r.address) fill(r);
  });
  return [contactsBtn, scanBtn];
}

/** The amount a scanned "beam:" link carried, as the amount field writes it. */
export const scannedAmount = (r) => (r && typeof r.amount === 'bigint' ? toInputString(r.amount) : null);

/**
 * Under the address: "Alice (your contact)", a warning when it only looks like a
 * contact's address, or "Save as a contact" for a checked address that is new.
 */
export function contactLine(app, { onSaved = () => {} } = {}) {
  const el = h('div', { class: 'contact-line', 'data-testid': 'send-contact-line' });
  let last = '';
  let lastState = {};
  loadContacts(app).then(() => update(last, lastState), () => {});
  function update(address, { ok = false, name = false } = {}) {
    last = address;
    lastState = { ok, name };
    const list = cachedContacts();
    if (!address || name || !list) return put(el);
    const c = findByAddress(list, address);
    if (c) return put(el, h('p', { class: 'hint good', 'data-testid': 'send-contact-name' }, icon('person', 'inline-icon'), ` ${c.name} · your contact`));
    const look = lookalikeOf(list, address);
    if (look)
      return put(el, h('div', { 'data-testid': 'send-lookalike' }, notice('warn', h('strong', { text: `Not ${look.name}'s saved address. ` }), `It starts and ends like it (${shortAddress(look.address, 6)}) but the middle differs. Check it with ${look.name} before sending.`)));
    if (!ok) return put(el);
    put(el, textButton(h('span', {}, 'Save as a contact'), async () => {
      const saved = await contactForm(app, { address });
      if (saved) {
        update(address, lastState);
        onSaved(saved);
      }
    }, { class: 'btn btn-text btn-inline-left', 'data-testid': 'send-save-contact' }));
  }
  return { el, update };
}

/**
 * The note: folded behind "Add a note" until used (one less field to read on the
 * way to Review), open when the draft has one. draft.note holds it.
 */
export function noteField(draft) {
  const input = h('input', { class: 'input', type: 'text', maxlength: String(NOTE_MAX), autocomplete: 'off', placeholder: 'e.g. Rent for March', 'aria-label': 'Note', 'data-testid': 'send-note' });
  input.value = draft.note || '';
  const hint = h('p', { class: 'hint', 'data-testid': 'send-note-hint', text: noteHint() });
  const field = h('label', { class: 'field' }, 'Note (only you see it)', input);
  const open = h('div', { class: draft.note ? '' : 'hidden', 'data-testid': 'send-note-box' }, field, hint);
  const opener = textButton(h('span', {}, 'Add a note (only you see it)'), () => {
    opener.classList.add('hidden');
    open.classList.remove('hidden');
    input.focus();
  }, { class: `btn btn-text btn-inline-left${draft.note ? ' hidden' : ''}`, 'data-testid': 'send-add-note' });
  input.addEventListener('input', () => {
    draft.note = input.value;
  });
  return {
    el: h('div', { class: 'note-wrap' }, opener, open),
    /** A name payment is a contract call: no note. */
    setToName(toName) {
      input.disabled = toName;
      hint.textContent = noteHint({ toName });
      opener.disabled = toName;
    },
    value: () => cleanNote(input.value),
  };
}
