/* Ethereum review (a sheet over Send)
 * Spec: ONE job: show exactly what leaves this wallet before anything is signed.
 *       Primary CTA: "Send <amount> <symbol>" (then Face ID / password).
 *       Taps from app open: 4 (Home -> Ethereum -> Send -> Send <amount>), then this button.
 * Exit-intent reasons and answers:
 *   - "What exactly am I signing?" -> the amount to every decimal, the full address in groups of
 *     four, the network fee as "about" and "at most", and the total.
 *   - "Will the fee surprise me?" -> "at most" is the very limit signed into the transaction; it
 *     cannot be exceeded. If it rose since this sheet opened, the new numbers are shown instead of sending.
 *   - "Can I undo it?" -> no, said before the button.
 */
import { h, shorten } from '../lib/dom.js';
import { openSheet, notice } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { prepareSend, signAndSend, costRose, SendError } from '../lib/eth/send.js';
import { ETH } from '../lib/eth/tokens.js';
import { amountText, exactText, ethText, ethMaxText, groupedAddress } from './eth_ui.js';

/** Re-checked before signing when the review is older than this. */
const FRESH_MS = 60000;

export function openEthReview(app, w, first) {
  let prepared = first;
  let message = null;
  let busy = false;
  const sheet = openSheet((close, rerender) => {
    const p = prepared;
    const isEth = p.asset === ETH;
    const label = `Send ${amountText(p.amount, p.asset, { approx: false })}`;
    const total = isEth
      ? [h('span', { 'data-testid': 'eth-review-total', text: `about ${ethText(p.amount + p.fees.likely)}` }), h('div', { class: 'small', text: `at most ${ethMaxText(p.amount + p.fees.upTo)}` })]
      : [h('span', { 'data-testid': 'eth-review-total', text: `${amountText(p.amount, p.asset, { approx: false })} + about ${ethText(p.fees.likely)}` }), h('div', { class: 'small', text: `fee at most ${ethMaxText(p.fees.upTo)}` })];

    const confirm = async () => {
      if (busy) return;
      busy = true;
      message = null;
      try {
        if (Date.now() - prepared.preparedAt > FRESH_MS) {
          const fresh = await prepareSend(w.rpc, { from: w.state.address, asset: p.asset, recipient: p.recipient, amount: p.amount, balances: w.balances() });
          if (costRose(prepared, fresh)) {
            prepared = fresh;
            busy = false;
            message = notice('warn', 'The network fee went up since you opened this. Check the new amounts, then send.');
            return rerender();
          }
          prepared = { ...prepared, preparedAt: fresh.preparedAt };
        }
        const ok = await confirmIdentity(app, { title: 'Confirm the payment', detail: `${amountText(p.amount, p.asset, { approx: false })} to ${shorten(p.recipient, 8, 6)}`, cta: 'Confirm' });
        if (!ok) {
          busy = false;
          return;
        }
        message = h('p', { class: 'small center', 'data-testid': 'eth-sending', text: 'Signing and sending…' });
        rerender();
        const r = await signAndSend(app, w.rpc, prepared, { ethId: w.ethId });
        await w.reloadOutbox().catch(() => {});
        app.ethSendDraft = null;
        close(true);
        app.go('ethTx', { hash: r.entry.hash, justSent: true }, { replace: true });
      } catch (e) {
        busy = false;
        const why = e instanceof SendError ? e.message : `${e.message}${/\.$/.test(e.message) ? '' : '.'}`;
        message = notice('error', `Nothing was sent. ${why}`);
        rerender();
      }
    };

    return [
      h('h2', { text: 'Check before sending' }),
      h('div', { class: 'big-amount', 'data-testid': 'eth-review-amount', text: exactText(p.amount, p.asset) }),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: 'To' }), h('span', { class: 'v mono addr-groups', 'data-testid': 'eth-review-to', 'data-address': p.recipient, text: groupedAddress(p.recipient) })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network' }), h('span', { class: 'v', text: 'Ethereum' })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v' }, h('span', { 'data-testid': 'eth-review-fee', text: `about ${ethText(p.fees.likely)}` }), h('div', { class: 'small', 'data-testid': 'eth-review-fee-max', text: `at most ${ethMaxText(p.fees.upTo)}` }))),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Total' }), h('span', { class: 'v' }, ...total)),
      ),
      notice('info', 'Ethereum payments cannot be cancelled or undone once sent, and anyone can see them.'),
      message,
      h('button', { class: 'btn btn-primary', onclick: confirm, disabled: busy, 'data-testid': 'eth-review-send' }, busy ? 'Sending…' : label),
      h('button', { class: 'btn btn-text', onclick: () => close(false), disabled: busy, 'data-testid': 'eth-review-change' }, 'Change'),
    ];
  }, { label: 'Check before sending' });
  return sheet;
}
