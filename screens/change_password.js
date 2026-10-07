/* Change password
 * Spec: ONE job: replace the unlock password.
 *       Primary CTA: "Save new password".
 *       Taps from app open: 2 (Settings -> Change password).
 * Exit-intent reasons and answers:
 *   - "Will this touch my coins?" -> no: only the lock on this device changes.
 *   - "Wrong current password" -> says so, keeps the new one typed.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice, toast } from '../lib/ui.js';
import { changePassword, passwordProblem, isImported } from '../lib/session.js';

export default function changePasswordScreen(app) {
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password', 'data-testid': 'cp-current' });
  const n1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': 'New password', 'data-testid': 'cp-new' });
  const n2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': 'Repeat new password', 'data-testid': 'cp-new2' });
  const msg = h('div', { 'aria-live': 'polite' });
  const cta = primary('Save new password', save, { 'data-testid': 'cp-save' });

  async function save() {
    const p = passwordProblem(n1.value, n2.value);
    if (!cur.value) return put(msg, notice('warn', 'Enter your current password.'));
    if (p) return put(msg, notice('warn', p));
    cta.disabled = true;
    cta.textContent = 'Saving…';
    try {
      await changePassword(app, cur.value, n1.value);
      toast('Password changed');
      app.go('settings');
    } catch (e) {
      cta.disabled = false;
      cta.textContent = 'Save new password';
      put(msg, notice('error', e.code === 'wrong_secret' ? "The current password didn't match. Try again." : e.message));
    }
  }

  const el = screen(
    { title: 'Change password', back: () => app.go('settings'), actions: [cta] },
    h('p', {
      class: 'lead',
      text: isImported(app)
        ? 'This changes how you unlock BEAM Campfire on this device. Your coins stay the same, and the original wallet.db file keeps the password it had.'
        : 'This changes how you unlock BEAM Campfire on this device. Your coins and your 12 words stay the same.',
    }),
    h('label', { class: 'field' }, 'Current password', cur),
    h('label', { class: 'field' }, 'New password (8+ characters)', n1),
    h('label', { class: 'field' }, 'Repeat new password', n2),
    msg,
  );
  return { el };
}
