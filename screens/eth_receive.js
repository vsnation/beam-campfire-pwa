/* Receive on Ethereum
 * Spec: ONE job: give someone this wallet's Ethereum address.
 *       Primary CTA: "Share address" (or "Copy address" where sharing isn't available).
 *       Taps from app open: 2 (Home -> Ethereum -> Receive).
 * Exit-intent reasons and answers:
 *   - "Which network?" -> said up front: Ethereum mainnet only; ETH and Ethereum tokens.
 *   - "Will it arrive if I'm offline?" -> yes: unlike BEAM, Ethereum payments need nothing from this app.
 *   - "Is it private?" -> no, and said so: everyone can see what this address receives.
 *   - "The address is long" -> QR code first, then the address in groups of four, copy and share.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, copyText } from '../lib/ui.js';
import { qrElement } from './receive.js';
import { ethWallet } from '../lib/eth/wallet.js';
import { groupedAddress } from './eth_ui.js';

export default function ethReceive(app) {
  const qrBox = h('div', { class: 'qr' }, h('div', { class: 'spinner' }));
  const addrText = h('p', { class: 'mono addr-groups', 'data-testid': 'eth-receive-address' });
  const canShare = typeof navigator.share === 'function';
  const shareBtn = primary(h('span', {}, canShare ? 'Share address' : 'Copy address'), () => (canShare ? share() : copy()), { disabled: true, 'data-testid': 'eth-share' });
  shareBtn.prepend(icon(canShare ? 'share' : 'copy'));
  const copyBtn = canShare ? secondary(h('span', {}, 'Copy'), copy, { disabled: true, 'data-testid': 'eth-copy' }) : null;
  if (copyBtn) copyBtn.prepend(icon('copy'));
  let address = null;

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

  (async () => {
    const w = await ethWallet(app).catch(() => null);
    if (!w) return app.go('ethHome');
    address = w.state.address;
    qrBox.replaceChildren(qrElement(address));
    qrBox.firstChild.setAttribute('aria-label', 'QR code of the Ethereum address');
    addrText.textContent = groupedAddress(address);
    addrText.dataset.address = address;
    shareBtn.disabled = false;
    if (copyBtn) copyBtn.disabled = false;
  })();

  const el = screen(
    { title: 'Receive on Ethereum', back: () => app.back('ethHome'), actions: [shareBtn, copyBtn] },
    qrBox,
    h('div', { class: 'address-box' }, addrText),
    notice('info', h('strong', { text: 'Ethereum mainnet only: ' }), 'ETH and Ethereum tokens such as WBEAM, USDT or USDC. Payments arrive even while this app is closed.'),
    h('p', { class: 'small', text: 'Everything this address receives is public on Ethereum. For private payments, use your BEAM address.' }),
  );
  return { el };
}
