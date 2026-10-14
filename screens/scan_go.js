/* Home's Scan: point the camera at a QR code and land where it belongs (loaded on the first tap)
 * Spec: ONE job: act on a code without knowing first what kind it is.
 *       Primary CTA: none while the camera looks; the code decides the next screen, which is always a
 *       screen to review and confirm, never a payment by itself.
 *       Taps from app open: 1 (Home -> Scan), then the screen the code opens.
 * Exit-intent reasons and answers:
 *   - "What did it read?" -> a code with no use here is shown as text, with why nothing was opened.
 *   - "It opened a link!" -> never: a web link, another chain or another coin is named, not followed.
 *   - "An Ethereum address, but I have no Ethereum wallet" -> said, with the way to add one.
 * Where each kind goes (lib/scan_recognize.js): a BEAM address or link and a BEAM name -> Send
 * (address and amount filled); an Ethereum address or link -> Ethereum Send (recipient, amount, the
 * token when this wallet knows it); an airdrop code -> Airdrop codes (code filled, then Check code).
 */
import { h } from '../lib/dom.js';
import { openSheet, notice, primary, textButton, copyText, toast } from '../lib/ui.js';
import { recognize } from '../lib/scan_recognize.js';
import { scanAnything } from './scan_sheet.js';
import { t, tk } from '../lib/i18n.js';

const UNSUPPORTED = Object.freeze({
  chain: tk('It is a payment on another network than Ethereum. BEAM Campfire uses Ethereum mainnet only, so nothing was opened.'),
  coin: tk('It is an address of another coin, which this wallet does not hold, so nothing was opened.'),
  link: tk('It is a web link. BEAM Campfire does not open links from codes, so nothing was opened.'),
  token: tk('It is a payment in an Ethereum token this wallet does not know, so nothing was opened.'),
});

function showText(text, why) {
  openSheet((close) => [
    h('h2', { text: t('What the code says') }),
    h('div', { 'data-testid': 'scan-said' }, notice('info', why)),
    h('p', { class: 'mono scan-text', 'data-testid': 'scan-text', text: text.length > 400 ? `${text.slice(0, 400)}…` : text }),
    h('div', { class: 'btn-row' }, primary(t('Copy the text'), () => (copyText(text, t('Copied')), close()), { 'data-testid': 'scan-copy' }), textButton(t('Close'), () => close())),
  ], { label: t('What the code says') });
}

/** Where a recognized code goes. Exported for the tests: {to, params} or {sheet: reason}. */
export async function destination(r, { hasEth = async () => false, tokens = [] } = {}) {
  switch (r.kind) {
    case 'beam':
      return { to: 'send', draft: { address: r.address, amount: r.amount || '' } };
    case 'name':
      return { to: 'send', draft: { address: `${r.name}.beam`, amount: '' } };
    case 'eth': {
      if (!(await hasEth())) return { sheet: 'noEth' };
      if (r.token) {
        const token = tokens.find((x) => x.address && x.address.toLowerCase() === r.token.toLowerCase());
        if (!token) return { sheet: 'token' };
        return { to: 'ethSend', draft: { to: r.to, amount: '', symbol: token.symbol } };
      }
      return { to: 'ethSend', draft: { to: r.to, amountWei: r.valueWei || null, symbol: 'ETH' } };
    }
    case 'code':
      return { to: 'airdrop', draft: { code: r.code } };
    case 'unsupported':
      return { sheet: r.reason };
    default:
      return { sheet: 'unknown' };
  }
}

/** The whole Scan: camera (or a paste), what it is, then the screen for it. */
export async function scanAndGo(app) {
  let r = await scanAnything({ title: t('Scan a QR code') });
  if (!r) return;
  if (r.paste) {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return toast(t("BEAM Campfire couldn't read the clipboard. Copy the text again and tap Scan."), 4000);
    }
    r = { ...recognize(text), text: String(text).trim().slice(0, 2000) };
    if (r.kind === 'empty') return toast(t('The clipboard is empty.'), 3000);
  }
  const [{ hasEthWallet }, { TOKENS }, { toInputString }] = await Promise.all([import('../lib/eth/record.js'), import('../lib/eth/tokens.js'), import('../lib/eth/units.js')]);
  const d = await destination(r, { hasEth: () => hasEthWallet().catch(() => false), tokens: TOKENS });
  if (d.to === 'send') {
    app.sendDraft = { address: d.draft.address, amount: d.draft.amount, assetId: 0, note: '' };
    return app.go('send');
  }
  if (d.to === 'ethSend') {
    app.ethSendDraft = { to: d.draft.to, amount: d.draft.amountWei ? toInputString(BigInt(d.draft.amountWei), 18) : d.draft.amount || '', symbol: d.draft.symbol };
    return app.go('ethSend');
  }
  if (d.to === 'airdrop') {
    // Grouped as the field shows a code: ABCD-EFGH-JKLM-NPQR.
    app.dropDraft = { code: d.draft.code.match(/.{1,4}/g).join('-') };
    return app.go('airdrop');
  }
  if (d.sheet === 'noEth') {
    return openSheet((close) => [
      h('h2', { text: t('An Ethereum address') }),
      h('div', { 'data-testid': 'scan-no-eth' }, notice('info', t('To send to it, add an Ethereum wallet first: it sits next to your BEAM wallet, with its own recovery words.'))),
      primary(t('Add an Ethereum wallet'), () => (close(), app.go('ethStart')), { 'data-testid': 'scan-add-eth' }),
      textButton(t('Not now'), () => close()),
    ], { label: t('An Ethereum address') });
  }
  return showText(r.text || '', UNSUPPORTED[d.sheet] ? t(UNSUPPORTED[d.sheet]) : t('BEAM Campfire does not know what this is, so nothing was opened.'));
}
