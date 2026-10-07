/* Protect this wallet: password (last setup step)
 * Spec: ONE job: choose the password that unlocks this wallet on this device.
 *       Primary CTA: "Protect my wallet".
 *       Taps from app open: 3 (create) / 2 (restore), plus typing.
 * Exit-intent reasons and answers:
 *   - "Another password to remember?" -> Face ID comes next; the password is the fallback.
 *   - "What if I forget it?" -> said plainly: we can't reset it, the 12 words always can.
 *   - "Rules are annoying" -> one rule only: 8 characters.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { createWallet, passwordProblem } from '../lib/session.js';
import { passkeyAvailable } from '../lib/passkey.js';

export default function setPassword(app) {
  if (!app.setup || !app.setup.words) {
    queueMicrotask(() => app.go(app.record ? 'unlock' : 'welcome'));
    return { el: h('div') };
  }
  const restoring = app.setup.mode === 'restore';
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'data-testid': 'pw1', 'data-autofocus': true, 'aria-label': 'Password' });
  const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'data-testid': 'pw2', 'aria-label': 'Repeat password' });
  const showBtn = h('button', { class: 'btn btn-text btn-small inside', type: 'button', 'aria-label': 'Show password' }, icon('eye'));
  showBtn.addEventListener('click', () => {
    const t = pw.type === 'password' ? 'text' : 'password';
    pw.type = t;
    pw2.type = t;
  });
  const hint = h('p', { class: 'hint', text: 'At least 8 characters.' });
  const err = h('div', { 'aria-live': 'polite' });
  const cta = primary('Protect my wallet', save, { disabled: true, 'data-testid': 'save-password' });

  const update = () => {
    const p = passwordProblem(pw.value, pw2.value);
    cta.disabled = Boolean(p);
    hint.textContent = pw.value.length >= 8 ? (pw2.value && pw.value !== pw2.value ? "The two passwords don't match yet." : 'Good.') : 'At least 8 characters.';
    hint.className = 'hint' + (pw.value.length >= 8 && !(pw2.value && pw.value !== pw2.value) ? ' good' : '');
  };
  pw.addEventListener('input', update);
  pw2.addEventListener('input', update);
  pw2.addEventListener('keydown', (e) => e.key === 'Enter' && !cta.disabled && save());

  async function save() {
    const p = passwordProblem(pw.value, pw2.value);
    if (p) return put(err, notice('warn', p));
    cta.disabled = true;
    cta.textContent = 'Securing your wallet…';
    try {
      await createWallet(app, pw.value);
      pw.value = '';
      pw2.value = '';
      app.setup = null;
      if (await passkeyAvailable()) app.go('passkeySetup', { first: true });
      else app.go(app.prefs.ipAck ? 'fastStart' : 'ipNotice', { first: true });
    } catch (e) {
      cta.disabled = false;
      cta.textContent = 'Protect my wallet';
      put(err, notice('error', `The wallet could not be saved on this device: ${e.message}`));
    }
  }

  const el = screen(
    { title: 'Protect this wallet', back: () => app.go(restoring ? 'restore' : 'confirmWords'), actions: [cta] },
    h('p', { class: 'step', text: restoring ? 'Step 2 of 2' : 'Step 3 of 3' }),
    h('p', { class: 'lead', text: 'Choose a password for this device. Next you can turn on Face ID or Touch ID, and use the password when they are not available.' }),
    h('label', { class: 'field' }, 'Password', h('div', { class: 'input-wrap' }, pw, showBtn)),
    h('label', { class: 'field' }, 'Repeat password', pw2),
    hint,
    err,
    h('p', { class: 'small', text: "Nobody can reset this password, not even us. If you forget it, your 12 words bring the wallet back." }),
  );
  return { el };
}
