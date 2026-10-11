/* Receive
 * Spec: ONE job: give someone my address.
 *       Primary CTA: "Share address" (or "Copy address" where sharing isn't available).
 *       Taps from app open: 1 (Home -> Receive).
 * Exit-intent reasons and answers:
 *   - "Why is the payment not arriving?" -> says up front: BEAM regular payments need both
 *     wallets online; keep BEAM Campfire open until it completes. Paying from another app on
 *     the same phone: that app must be opened once more, since the sender finishes the payment.
 *   - "Is this address safe to share?" -> yes, and a new one is one tap away.
 *   - "The address is huge" -> QR code first; copy and share buttons, no manual selection.
 *   - "Can I be paid while my wallet is closed, or more privately?" -> "More ways to receive", folded under
 *     Your addresses: offline, max-privacy and public addresses (screens/receive_more.js).
 */
import { h, svg, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, textButton, notice, copyText, toast } from '../lib/ui.js';
import { encodeQr, qrSvgPath } from '../lib/qr.js';
import { wallet } from '../lib/wallet.js';
import { preferredReceive, rememberReceive } from './addresses.js';
import { moreWays } from './receive_more.js';

export function qrElement(text) {
  const qr = encodeQr(text, { ecl: 'M' });
  const n = qr.size + 8;
  return svg('svg', { viewBox: `0 0 ${n} ${n}`, 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': 'QR code of the address' }, svg('rect', { width: n, height: n, fill: '#ffffff' }), svg('path', { d: qrSvgPath(qr, 4), fill: '#000000' }));
}

export default function receive(app, params = {}) {
  // From a token's page: the same address, named for that token.
  const token = Number(params.assetId) > 0 ? wallet.label(params.assetId) : null;
  const qrBox = h('div', { class: 'qr' }, h('div', { class: 'spinner' }));
  const addrText = h('p', { class: 'mono', 'data-testid': 'receive-address' });
  const msg = h('div');
  const canShare = typeof navigator.share === 'function';
  const shareBtn = primary(h('span', {}, canShare ? 'Share address' : 'Copy address'), () => (canShare ? share() : copy()), { disabled: true, 'data-testid': 'share' });
  shareBtn.prepend(icon(canShare ? 'share' : 'copy'));
  const copyBtn = canShare ? secondary(h('span', {}, 'Copy'), copy, { disabled: true, 'data-testid': 'copy' }) : null;
  if (copyBtn) copyBtn.prepend(icon('copy'));
  let address = null;

  async function load(fresh) {
    if (wallet.state.importing) {
      put(msg, notice('info', 'Your address appears once the wallet has finished getting ready.'));
      const off = wallet.onChange((s) => {
        if (!s.importing) {
          off();
          load(fresh);
        }
      });
      return;
    }
    try {
      // The address chosen in Your addresses, while it can be paid; a new one becomes the one shown.
      address = await wallet.receiveAddress({ fresh, preferred: fresh ? null : await preferredReceive(app) });
      if (fresh) rememberReceive(app, address);
      put(qrBox, qrElement(address));
      addrText.textContent = address;
      shareBtn.disabled = false;
      if (copyBtn) copyBtn.disabled = false;
      put(msg);
      if (fresh) toast('New address ready');
    } catch (e) {
      put(qrBox, icon('alert'));
      put(msg, notice('error', `The address could not be made: ${e.message}. Try again in a moment.`), secondary('Try again', () => load(fresh)));
    }
  }

  function copy() {
    if (address) copyText(address, 'Address copied');
  }

  async function share() {
    try {
      await navigator.share({ text: address });
    } catch (e) {
      if (e && e.name !== 'AbortError') copy();
    }
  }

  load(false);
  const el = screen(
    { title: token ? `Receive ${token.label}` : 'Receive BEAM', back: () => app.back('home'), actions: [shareBtn, copyBtn, textButton('Make a new address', () => load(true), { 'data-testid': 'new-address' }), textButton('Your addresses', () => app.go('addresses'), { 'data-testid': 'your-addresses' })] },
    qrBox,
    h('div', { class: 'address-box' }, addrText),
    token ? h('p', { class: 'small', 'data-testid': 'receive-token', text: `${token.label} arrives at your BEAM address, the same one you use for BEAM.` }) : null,
    h('div', { 'data-testid': 'receive-online' }, notice('info', 'A BEAM payment finishes only while both wallets are online. Keep BEAM Campfire open until it arrives. Paying from another app on this phone? Send, come back here, then open that app once more.')),
    msg,
  );
  // Under the buttons, so Share stays where it was: offline, max-privacy and public addresses.
  const more = moreWays(app);
  el.appendChild(h('div', { class: 'more-ways-wrap' }, more.el));
  return { el, destroy: more.destroy };
}
