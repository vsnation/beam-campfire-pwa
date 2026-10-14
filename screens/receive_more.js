/* More ways to receive (on Receive, under the regular address)
 * Spec: ONE job: an address that works while my wallet is closed, or a more private one.
 *       Primary CTA: none on Receive (it stays "Share address"); each type is a row; the address it makes
 *       opens in a sheet whose primary is "Copy address".
 *       Taps from app open: 3 (Home -> Receive -> More ways to receive -> a type).
 * Exit-intent reasons and answers (BEAM Campfire's beam_more_ways.dart):
 *   - "Which one do I need?" -> folded away: most people only need the regular address above. Each type
 *     says what it does for the person paid, when the money can be spent, and the fee the sender pays.
 *   - "Why are they grey?" -> they are never hidden and never offered when this wallet would not see the
 *     payment: the reason is right above them, with the one thing that turns them on (Rescan, or your own
 *     node with the owner key), one tap away.
 *   - "Where did that address go?" -> it is in Your addresses, like every other.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { primary, secondary, textButton, notice, openSheet, copyText } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { PRIVATE_TYPES, MORE_WAYS as T, typeTitle, typeExplainer, privateReceiveGate, blockedReason, receiveErrorText, makePrivateAddress } from '../lib/receive_types.js';
import { qrElement } from './receive.js';
import { t, asSentence } from '../lib/i18n.js';

export function moreWays(app) {
  let open = false;
  let making = null;
  let lastGate = null;
  const msg = h('div', { 'aria-live': 'polite' });
  const box = h('div', { class: 'more-ways', 'data-testid': 'more-ways' });

  const go = (action) => {
    if (action === 'rescan') app.go('fastStart', { rescan: true });
    else if (action === 'ownNode') app.go('ownNode');
    else if (action === 'ownerKey') app.go('ownerKey');
  };
  const actionLabel = { rescan: T.rescan, ownNode: T.ownNode, ownerKey: T.ownerKey };

  function render() {
    const gate = privateReceiveGate(wallet.state);
    lastGate = gate;
    const why = blockedReason(gate);
    put(
      box,
      h(
        'button',
        { class: 'card row more-ways-head', type: 'button', 'aria-expanded': String(open), 'data-testid': 'more-ways-toggle', onclick: () => ((open = !open), render()) },
        h('span', { class: 'main' }, h('div', { class: 't', text: t(T.title) }), h('div', { class: 's wrap', text: t(T.hint) })),
        h('span', { class: 'chev' }, icon(open ? 'down' : 'chevron')),
      ),
      open && !gate.available
        ? h(
            'div',
            { 'data-testid': 'more-ways-blocked', 'data-block': gate.block },
            notice(
              'warn',
              h('strong', { text: asSentence(t(T.blockedTitle)) }),
              why.reason,
              why.actions.length ? h('div', { class: 'btn-row prompt-actions' }, ...why.actions.map((a, i) => h('button', { class: `btn ${i === 0 ? 'btn-primary' : 'btn-text'} btn-small`, type: 'button', 'data-testid': `more-ways-${a}`, onclick: () => go(a) }, t(actionLabel[a])))) : null,
            ),
          )
        : null,
      open ? h('div', { class: 'card list more-ways-list' }, ...PRIVATE_TYPES.map((type) => tile(type, gate))) : null,
      open ? msg : null,
    );
  }

  function tile(type, gate) {
    const enabled = gate.available && !making;
    const busy = making === type;
    return h(
      'button',
      { class: `row type-row${enabled || busy ? '' : ' off'}`, type: 'button', disabled: !enabled, 'aria-disabled': String(!enabled), 'data-testid': `receive-type-${type}`, onclick: () => make(type) },
      h('span', { class: 'main' }, h('div', { class: 't', text: typeTitle(type) }), h('div', { class: 's wrap', text: busy ? t(T.making) : typeExplainer(type) })),
      h('span', { class: 'chev' }, busy ? h('span', { class: 'spinner small' }) : icon(gate.available ? 'chevron' : 'lock')),
    );
  }

  async function make(type) {
    if (making || !wallet.session) return;
    making = type;
    put(msg);
    render();
    try {
      const { address } = await makePrivateAddress(wallet.session, type);
      await wallet.persistNow();
      making = null;
      render();
      showAddress(type, address);
    } catch (e) {
      making = null;
      render();
      put(msg, h('div', { 'data-testid': 'more-ways-error' }, notice('error', receiveErrorText(e))));
    }
  }

  function showAddress(type, address) {
    const canShare = typeof navigator.share === 'function';
    openSheet(
      (close) => [
        h('h2', { 'data-testid': 'private-address-title', text: typeTitle(type) }),
        h('p', { class: 'small', text: typeExplainer(type) }),
        h('div', { class: 'qr sheet-qr' }, qrElement(address)),
        h('p', { class: 'mono addr-groups center', 'data-testid': 'private-address', text: `${address.slice(0, 18)}…${address.slice(-18)}` }),
        primary(h('span', {}, t('Copy address')), () => copyText(address, t('Address copied')), { 'data-testid': 'private-copy' }),
        canShare ? secondary(t('Share'), () => navigator.share({ text: address }).catch(() => {}), { 'data-testid': 'private-share' }) : null,
        h('p', { class: 'small', text: t('It is kept in Your addresses.') }),
        textButton(t('Done'), () => close(), { 'data-testid': 'private-done' }),
      ],
      { label: typeTitle(type) },
    );
  }

  // The gate follows the wallet: a node answering, a rescan finishing.
  const off = wallet.onChange((s) => {
    const g = privateReceiveGate(s);
    if (open && (!lastGate || g.available !== lastGate.available || g.block !== lastGate.block)) render();
  });
  render();
  return { el: box, destroy: off };
}
