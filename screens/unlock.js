/* Unlock
 * Spec: ONE job: open the wallet.
 *       Primary CTA: "Unlock with Face ID" when a passkey is set up, else "Unlock" (password).
 *       Taps from app open: 1.
 * Exit-intent reasons and answers:
 *   - "Face ID failed" -> says it was cancelled; the password is one tap away.
 *   - "Wrong password?" -> says so without blaming, and keeps the field.
 *   - "I forgot my password" -> the way back with the 12 words (or, for an imported wallet, its
 *     wallet.db file and password), stated plainly.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, textButton, notice } from '../lib/ui.js';
import { hasPasskey, openWithPasswordFor, openWithPasskeyFor, scanEnabled } from '../lib/session.js';
import { wallet } from '../lib/wallet.js';
import { resumeBridgeIfAny } from './eth_screens.js';

export default function unlock(app, params = {}) {
  if (!app.record) {
    queueMicrotask(() => app.go('welcome'));
    return { el: h('div') };
  }
  const passkey = hasPasskey(app);
  const msg = h('div', { 'aria-live': 'polite' });
  if (params.reason === 'timeout') put(msg, notice('info', `Locked after ${app.prefs.autoLockMin} minute${app.prefs.autoLockMin === 1 ? '' : 's'} without use.`));
  else if (params.reason === 'manual') put(msg, notice('info', 'Locked.'));
  // A bridge screen was open when it locked: say where its move was, and go back to it after unlock.
  const follow = app.afterUnlock ? h('div', { 'data-testid': 'unlock-follow' }, notice('info', h('strong', { text: 'Unlock to follow your move. ' }), app.afterUnlock.note || 'BEAM Campfire goes back to it once the wallet is open.')) : null;

  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Password', 'data-testid': 'unlock-pw', placeholder: 'Password' });
  const pwBtn = primary('Unlock', () => withPassword(), { 'data-testid': 'unlock-submit' });
  const pwBlock = h('div', { class: passkey ? 'hidden' : '' }, h('label', { class: 'field' }, 'Password', pw));
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && withPassword());

  let busy = false;
  async function opened(dbPass) {
    app.dbPass = dbPass;
    pw.value = '';
    if (!app.record.setupDone) return app.go(app.prefs.ipAck ? 'fastStart' : 'ipNotice', { first: true });
    put(msg, notice('info', 'Opening your wallet…'));
    try {
      if (wallet.session) await wallet.stop();
      await wallet.start({ dbPass, node: app.prefs.node, bodyRequests: scanEnabled(app) });
      // Moves through the bridge are followed again from where they were (only when there are any).
      resumeBridgeIfAny(app);
      const next = app.afterUnlock;
      app.afterUnlock = null;
      app.go(next ? next.name : 'home', next ? next.params : {});
    } catch (e) {
      app.dbPass = null;
      await wallet.stop().catch(() => {});
      busy = false;
      put(msg, notice('error', `The wallet did not open: ${e.message}`));
    }
  }

  async function withPassword() {
    if (busy) return;
    if (!pw.value) return put(msg, notice('warn', 'Enter your password.'));
    busy = true;
    pwBtn.disabled = true;
    pwBtn.textContent = 'Checking…';
    try {
      const dbPass = await openWithPasswordFor(app, pw.value);
      await opened(dbPass);
    } catch (e) {
      busy = false;
      pwBtn.disabled = false;
      pwBtn.textContent = 'Unlock';
      if (e.code === 'wrong_secret') {
        put(msg, notice('error', "That password didn't open the wallet. Try again."));
        pw.select();
      } else put(msg, notice('error', e.message));
    }
  }

  async function withPasskey() {
    if (busy) return;
    busy = true;
    try {
      const dbPass = await openWithPasskeyFor(app);
      await opened(dbPass);
    } catch (e) {
      busy = false;
      const text = e.code === 'cancelled' ? 'Face ID was cancelled. Try again, or use your password.' : `Face ID didn't unlock the wallet (${e.message}). Use your password.`;
      put(msg, notice(e.code === 'cancelled' ? 'info' : 'warn', text));
    }
  }

  const usePw = textButton('Use password instead', () => {
    pwBlock.classList.remove('hidden');
    usePw.classList.add('hidden');
    faceBtn.classList.replace('btn-primary', 'btn-secondary');
    put(actions, pwBtn, faceBtn, forgot);
    pw.focus();
  }, { 'data-testid': 'use-password' });
  const faceBtn = passkey ? primary('Unlock with Face ID', withPasskey, { 'data-testid': 'unlock-passkey' }) : null;
  if (faceBtn) faceBtn.prepend(icon('face'));
  const forgot = textButton('Forgot your password?', () => app.go('deleteWallet', { forgot: true }));

  const actions = h('div', { class: 'actions' });
  put(actions, ...(passkey ? [faceBtn, usePw, forgot] : [pwBtn, forgot]));

  const el = screen(
    { topbar: false },
    h('div', { class: 'hero' }, h('img', { src: 'img/logo.svg', alt: '' }), h('h1', { text: 'BEAM Campfire' }), h('p', { text: 'Unlock your wallet' })),
    follow,
    pwBlock,
    msg,
  );
  el.appendChild(actions);
  if (!passkey) setTimeout(() => pw.focus(), 50);
  return { el };
}
