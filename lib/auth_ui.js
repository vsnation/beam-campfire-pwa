// "Is it really you?" before money moves or settings that guard the wallet
// change. Face ID / Touch ID when a passkey is set up, the password otherwise.
import { h } from './dom.js';
import { icon } from './icons.js';
import { openSheet, notice } from './ui.js';
import { hasPasskey, openWithPasswordFor, openWithPasskeyFor } from './session.js';

/** @returns {Promise<boolean>} true once the person proved it is them. */
export function confirmIdentity(app, { title = 'Confirm it is you', detail = '', cta = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    let usePassword = !hasPasskey(app);
    let message = null;
    let busy = false;
    const sheet = openSheet((close, rerender) => {
      const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Password', placeholder: 'Password', 'data-testid': 'auth-pw' });
      const finish = (ok) => {
        close(ok);
      };
      const tryPassword = async () => {
        if (busy) return;
        if (!pw.value) {
          message = notice('warn', 'Enter your password.');
          return rerender();
        }
        busy = true;
        try {
          await openWithPasswordFor(app, pw.value);
          finish(true);
        } catch (e) {
          busy = false;
          message = notice('error', e.code === 'wrong_secret' ? "That password didn't match. Try again." : e.message);
          rerender();
        }
      };
      const tryPasskey = async () => {
        if (busy) return;
        busy = true;
        try {
          await openWithPasskeyFor(app);
          finish(true);
        } catch (e) {
          busy = false;
          message = notice(e.code === 'cancelled' ? 'info' : 'warn', e.code === 'cancelled' ? 'Face ID was cancelled. Try again, or use your password.' : "Face ID didn't work. Use your password.");
          rerender();
        }
      };
      pw.addEventListener('keydown', (e) => e.key === 'Enter' && tryPassword());
      if (usePassword) setTimeout(() => pw.focus(), 50);
      const faceBtn = h('button', { class: 'btn btn-primary', onclick: tryPasskey, 'data-testid': 'auth-passkey' }, icon('face'), cta.includes('Face ID') ? cta : `${cta} with Face ID`);
      return [
        h('h2', { text: title }),
        detail ? h('p', { class: 'lead', text: detail }) : null,
        usePassword ? h('label', { class: 'field' }, 'Password', pw) : null,
        message,
        usePassword ? h('button', { class: 'btn btn-primary', onclick: tryPassword, 'data-testid': 'auth-submit' }, cta) : faceBtn,
        !usePassword
          ? h('button', { class: 'btn btn-text', 'data-testid': 'auth-use-password', onclick: () => { usePassword = true; message = null; rerender(); } }, 'Use password instead')
          : null,
        h('button', { class: 'btn btn-text', onclick: () => finish(false), 'data-testid': 'auth-cancel' }, 'Cancel'),
      ];
    }, { label: title });
    sheet.then((v) => resolve(v === true));
  });
}
