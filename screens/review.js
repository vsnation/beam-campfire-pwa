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
 */
import { h, shorten, put } from '../lib/dom.js';
import { screen, primary, notice, textButton } from '../lib/ui.js';
import { formatAmount } from '../lib/amount.js';
import { wallet, sendModeFor } from '../lib/wallet.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { checkCode, display } from '../lib/bans.js';
import { bans, nameProblemText } from './names.js';

export default function review(app, p) {
  if (p && p.kind === 'name' && p.name && p.ownerKey && p.amount != null) return nameReview(app, p);
  if (!p || !p.address || p.amount == null) {
    queueMicrotask(() => app.go('send', {}, { replace: true }));
    return { el: h('div') };
  }
  const mode = sendModeFor(p.type) || sendModeFor('regular');
  const unit = wallet.label(p.assetId).unit;
  const isBeam = Number(p.assetId) === 0;
  const total = isBeam ? `${formatAmount(p.amount + p.fee)} BEAM` : `${formatAmount(p.amount)} ${unit} + ${formatAmount(p.fee)} BEAM fee`;
  const msg = h('div', { 'aria-live': 'polite' });
  const label = `Send ${formatAmount(p.amount)} ${unit}`;
  const cta = primary(label, confirm, { 'data-testid': 'confirm-send' });

  async function confirm() {
    if (!wallet.state.sync.canSend) {
      put(msg, notice('warn', `${wallet.state.sync.title}. Sending is paused until the wallet is up to date.`));
      return;
    }
    cta.disabled = true;
    const ok = await confirmIdentity(app, { title: 'Confirm the payment', detail: `${formatAmount(p.amount)} ${unit} to ${shorten(p.address, 10, 8)}`, cta: 'Confirm' });
    if (!ok) {
      cta.disabled = false;
      return;
    }
    cta.textContent = 'Sending…';
    try {
      const txId = await wallet.send({ address: p.address, amount: p.amount, assetId: p.assetId, mode });
      app.sendDraft = null;
      app.go('txStatus', { txId, amount: p.amount, fee: p.fee, assetId: p.assetId, address: p.address, mustBeOnline: mode.receiverMustBeOnline }, { replace: true });
    } catch (e) {
      cta.disabled = false;
      cta.textContent = label;
      put(msg, notice('error', `The payment was not sent: ${plain(e)} Nothing left your wallet.`));
    }
  }

  const el = screen(
    { title: 'Review payment', back: () => app.back('send'), actions: [cta, textButton('Change', () => app.back('send'))] },
    h('p', { class: 'center small', text: 'You send' }),
    h('div', { class: 'big-amount', 'data-testid': 'review-amount', text: `${formatAmount(p.amount)} ${unit}` }),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'To' }), h('span', { class: 'v mono', 'data-testid': 'review-to', text: shorten(p.address, 10, 8) })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Address type' }), h('span', { class: 'v', text: mode.label })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'review-fee', text: `${formatAmount(p.fee)} BEAM` })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Total' }), h('span', { class: 'v', 'data-testid': 'review-total', text: total })),
    ),
    notice('info', mode.explanation, mode.receiverMustBeOnline ? ' Keep BEAM Campfire open until it completes. If nobody accepts it, it is cancelled and the money stays yours.' : ''),
    msg,
  );
  return { el };
}

export function plain(e) {
  const m = String((e && e.message) || e || '');
  if (/not enough|insufficient|Missing/i.test(m)) return 'There is not enough in the wallet for the amount and the fee.';
  if (/locked|stopped/i.test(m)) return 'The wallet was locked.';
  if (/timeout|did not answer/i.test(m)) return 'The wallet did not answer in time. Check Activity before trying again.';
  return m.endsWith('.') ? m : m + '.';
}

/** A payment to a BEAM name: the name, its owner key, and how it arrives. */
function nameReview(app, p) {
  const unit = wallet.label(p.assetId).unit;
  const isBeam = Number(p.assetId) === 0;
  const total = isBeam ? `${formatAmount(p.amount + p.fee)} BEAM` : `${formatAmount(p.amount)} ${unit} + ${formatAmount(p.fee)} BEAM fee`;
  const msg = h('div', { 'aria-live': 'polite' });
  const label = `Send ${formatAmount(p.amount)} ${unit} to ${p.name}`;
  const cta = primary(label, confirm, { 'data-testid': 'confirm-send' });

  async function confirm() {
    if (!wallet.state.sync.canSend) {
      put(msg, notice('warn', `${wallet.state.sync.title}. Sending is paused until the wallet is up to date.`));
      return;
    }
    cta.disabled = true;
    cta.textContent = 'Checking the name…';
    put(msg);
    try {
      // The approve sheet that follows shows the wallet's own figures and asks for Face ID / password.
      const r = await bans().pay(p.name, Number(p.assetId), p.amount, { expectedOwnerKey: p.ownerKey });
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
    { title: 'Review payment', back: () => app.back('send'), actions: [cta, textButton('Change', () => app.back('send'))], cls: 'plain' },
    h('p', { class: 'center small', text: 'You send' }),
    h('div', { class: 'big-amount', 'data-testid': 'review-amount', text: `${formatAmount(p.amount)} ${unit}` }),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'To' }), h('span', { class: 'v plain', 'data-testid': 'review-to', text: display(p.name) })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Owner key' }), h('span', { class: 'v mono', 'data-testid': 'review-owner', text: checkCode(p.ownerKey) })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Payment type' }), h('span', { class: 'v', text: 'Name payment' })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'review-fee', text: `${formatAmount(p.fee)} BEAM` })),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Total' }), h('span', { class: 'v', 'data-testid': 'review-total', text: total })),
    ),
    notice('info', `It goes into BEAM's name vault for whoever owns ${display(p.name)}; they claim it from their wallet. The amount is visible on the blockchain, the recipient is not. The name is checked again right before you approve: if its owner changed, nothing is sent.`),
    msg,
  );
  return { el };
}
