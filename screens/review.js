/* Review payment
 * Spec: ONE job: confirm exactly what will happen before any money moves.
 *       Primary CTA: "Send <amount> <unit>" (then Face ID / password); to a name, "Send <amount> to alice"
 *       (then the approve sheet with the wallet's own figures, and Face ID / password).
 *       Taps from app open: 2 (Home -> Send -> Review), then confirm.
 * Exit-intent reasons and answers:
 *   - "What exactly am I signing?" -> amount, receiver, address type, fee and total, in words.
 *   - "Is the fee a surprise?" -> fee and total are on this screen, nothing is added later.
 *   - "What if they're offline?" -> says the receiver must come online within ~12 h, and that
 *     a payment nobody accepts is returned (cancelled), not lost.
 *   - "Is alice.beam really them?" -> the owner key's 16 characters, and how to compare them with the
 *     person; a name paid before says whether its owner is the same (a node could lie: audit D-1).
 */
import { h, shorten, put } from '../lib/dom.js';
import { screen, primary, notice, textButton } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet, sendModeFor } from '../lib/wallet.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { checkCode, display } from '../lib/bans.js';
import { bans, nameProblemText } from './names.js';
import { contactNameFor, readNamePin, pinNamePayment, NAME_PIN_UNREAD } from '../lib/contacts.js';
import { cleanNote } from '../lib/payments.js';
import { t } from '../lib/i18n.js';

export default function review(app, p) {
  if (p && p.kind === 'name' && p.name && p.ownerKey && p.amount != null) return nameReview(app, p);
  if (!p || !p.address || p.amount == null) {
    queueMicrotask(() => app.go('send', {}, { replace: true }));
    return { el: h('div') };
  }
  const mode = sendModeFor(p.type) || sendModeFor('regular');
  const unit = wallet.label(p.assetId).unit;
  const isBeam = Number(p.assetId) === 0;
  const total = isBeam ? `${formatAmount(p.amount + p.fee)} BEAM` : t('{amount} {unit} + {fee} BEAM fee', { amount: formatAmount(p.amount), unit, fee: formatAmount(p.fee) });
  const msg = h('div', { 'aria-live': 'polite' });
  const label = t('Send {amount} {unit}', { amount: formatAmount(p.amount), unit });
  const cta = primary(label, confirm, { 'data-testid': 'confirm-send' });
  const note = cleanNote(p.note);
  const contact = contactNameFor(p.address);

  async function confirm() {
    if (!wallet.state.sync.canSend) {
      put(msg, notice('warn', t('{title}. Sending is paused until the wallet is up to date.', { title: wallet.state.sync.title })));
      return;
    }
    cta.disabled = true;
    const ok = await confirmIdentity(app, { title: t('Confirm the payment'), detail: t('{amount} {unit} to {address}', { amount: formatAmount(p.amount), unit, address: shorten(p.address, 10, 8) }), cta: t('Confirm') });
    if (!ok) {
      cta.disabled = false;
      return;
    }
    cta.textContent = t('Sending…');
    try {
      const txId = await wallet.send({ address: p.address, amount: p.amount, assetId: p.assetId, mode, comment: note });
      app.sendDraft = null;
      app.go('txStatus', { txId, amount: p.amount, fee: p.fee, assetId: p.assetId, address: p.address, mustBeOnline: mode.receiverMustBeOnline }, { replace: true });
    } catch (e) {
      cta.disabled = false;
      cta.textContent = label;
      put(msg, notice('error', t('The payment was not sent: {reason} Nothing left your wallet.', { reason: plain(e) })));
    }
  }

  const el = screen(
    { title: t('Review payment'), back: () => app.back('send'), actions: [cta, textButton(t('Change'), () => app.back('send'))] },
    h('p', { class: 'center small', text: t('You send') }),
    h('div', { class: 'big-amount', 'data-testid': 'review-amount', text: `${formatAmount(p.amount)} ${unit}` }),
    h(
      'div',
      { class: 'card' },
      contact
        ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('To') }), h('span', { class: 'v list' }, h('span', { 'data-testid': 'review-contact', text: contact }), h('span', { class: 'mono', 'data-testid': 'review-to', text: shorten(p.address, 10, 8) })))
        : h('div', { class: 'kv' }, h('span', { class: 'k', text: t('To') }), h('span', { class: 'v mono', 'data-testid': 'review-to', text: shorten(p.address, 10, 8) })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Address type') }), h('span', { class: 'v', text: mode.label })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Network fee') }), h('span', { class: 'v', 'data-testid': 'review-fee', text: `${formatAmount(p.fee)} BEAM` })), // i18n-ignore: an amount and its ticker
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Total') }), h('span', { class: 'v', 'data-testid': 'review-total', text: total })),
      note ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Note (only you see it)') }), h('span', { class: 'v', 'data-testid': 'review-note', text: note })) : null,
    ),
    notice('info', mode.explanation, mode.receiverMustBeOnline ? ` ${t('Keep BEAM Campfire open until it completes. If nobody accepts it, it is cancelled and the money stays yours.')}` : ''),
    msg,
  );
  return { el };
}

export function plain(e) {
  const m = String((e && e.message) || e || '');
  if (/not enough|insufficient|Missing/i.test(m)) return t('There is not enough in the wallet for the amount and the fee.');
  // The engine's own words (English) by their text; the app's own errors also by what they are, so a
  // translated message is recognised too (lib/engine.js: 'stopped' with "The wallet is locked.", 'timeout').
  if (/locked|stopped/i.test(m) || m === t('The wallet is locked.')) return t('The wallet was locked.');
  if (/timeout|did not answer/i.test(m) || (e && e.code === 'timeout')) return t('The wallet did not answer in time. Check Activity before trying again.');
  return m.endsWith('.') ? m : m + '.';
}

/** A payment to a BEAM name: the name, its owner key, and how it arrives. */
function nameReview(app, p) {
  const unit = wallet.label(p.assetId).unit;
  const isBeam = Number(p.assetId) === 0;
  const total = isBeam ? `${formatAmount(p.amount + p.fee)} BEAM` : t('{amount} {unit} + {fee} BEAM fee', { amount: formatAmount(p.amount), unit, fee: formatAmount(p.fee) });
  const msg = h('div', { 'aria-live': 'polite' });
  const label = t('Send {amount} {unit} to {name}', { amount: formatAmount(p.amount), unit, name: p.name });
  const cta = primary(label, confirm, { 'data-testid': 'confirm-send' });

  async function confirm() {
    if (!wallet.state.sync.canSend) {
      put(msg, notice('warn', t('{title}. Sending is paused until the wallet is up to date.', { title: wallet.state.sync.title })));
      return;
    }
    cta.disabled = true;
    cta.textContent = t('Checking the name…');
    put(msg);
    try {
      // A name this wallet paid before must still have that owner, unless the person chose the new one on Send.
      // Unreadable now: what Send read (Review already says when Send could not read it either).
      const pin = await readNamePin(app, p.name);
      const pinnedKey = pin.unread ? p.pinnedKey || null : pin.key;
      // The approve sheet that follows shows the wallet's own figures and asks for Face ID / password.
      const r = await bans().pay(p.name, Number(p.assetId), p.amount, { expectedOwnerKey: p.ownerKey, pinnedKey, acceptedKey: p.acceptedKey || null });
      // Paid: the owner the name is expected to have next time.
      await pinNamePayment(app, p.name, r.ownerKey).catch((e) => console.warn('[campfire] name pin', e && e.message));
      app.sendDraft = null;
      app.go('txStatus', { txId: r.txId, amount: p.amount, fee: r.fee, assetId: p.assetId, address: display(p.name), name: p.name, mustBeOnline: false }, { replace: true });
    } catch (e) {
      cta.disabled = false;
      cta.textContent = label;
      put(msg, notice(e.code === 'rejected' ? 'info' : 'error', nameProblemText(e, 'payment')));
      if (msg.firstChild) msg.firstChild.dataset.testid = 'review-name-result';
    }
  }

  const el = screen(
    // Sticky: the owner key's check and its history push the button down; it stays in view.
    { title: t('Review payment'), back: () => app.back('send'), actions: [cta, textButton(t('Change'), () => app.back('send'))], cls: 'plain sticky-actions' },
    h('p', { class: 'center small', text: t('You send') }),
    h('div', { class: 'big-amount', 'data-testid': 'review-amount', text: `${formatAmount(p.amount)} ${unit}` }),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('To') }), h('span', { class: 'v plain', 'data-testid': 'review-to', text: display(p.name) })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Owner key') }), h('span', { class: 'v mono', 'data-testid': 'review-owner', text: checkCode(p.ownerKey) })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Payment type') }), h('span', { class: 'v', text: t('Name payment') })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Network fee') }), h('span', { class: 'v', 'data-testid': 'review-fee', text: `${formatAmount(p.fee)} BEAM` })), // i18n-ignore: an amount and its ticker
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Total') }), h('span', { class: 'v', 'data-testid': 'review-total', text: total })),
    ),
    // The name's owner is what the node says it is: comparing the key with the person is what makes it theirs.
    h('p', { class: 'small', 'data-testid': 'review-owner-hint', text: t('To be sure it reaches them, ask for their name key (in BEAM Campfire: BEAM names → Receive a name). Its 16 characters must match the owner key above.') }),
    ownerHistory(p),
    notice('info', t("It goes into BEAM's name vault for whoever owns {name}; they claim it from their wallet. The amount is visible on the blockchain, the recipient is not. The name is checked again right before you approve: if its owner changed, nothing is sent.", { name: display(p.name) })),
    msg,
  );
  return { el };
}

/**
 * Whether this wallet paid the name before, and to whom: the same owner, or a new one the person
 * chose; or that the record of earlier payments could not be read, so nothing was compared (BC-3).
 */
function ownerHistory(p) {
  if (p.pinUnread) {
    const n = notice('warn', t(NAME_PIN_UNREAD));
    n.dataset.testid = 'review-owner-pin';
    return n;
  }
  if (p.acceptedKey && p.pinnedKey && p.acceptedKey === p.ownerKey) {
    const n = notice('warn', t('{name} had another owner when you last paid it ({key}). You chose to pay the new one.', { name: display(p.name), key: checkCode(p.pinnedKey) }));
    n.dataset.testid = 'review-owner-pin';
    return n;
  }
  if (p.pinnedKey && p.pinnedKey === p.ownerKey) return h('p', { class: 'small', 'data-testid': 'review-owner-pin', text: t('The same owner as your last payment to {name}.', { name: display(p.name) }) });
  return null;
}
