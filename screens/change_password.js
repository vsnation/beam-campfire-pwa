/* Change password
 * Spec: ONE job: replace the unlock password.
 *       Primary CTA: "Save new password".
 *       Taps from app open: 2 (Settings -> Change password).
 * Exit-intent reasons and answers:
 *   - "Will this touch my coins?" -> no: only the lock on this device changes.
 *   - "Wrong current password" -> says so, keeps the new one typed.
 *   - "Can the browser keep it?" -> one line: better not, it would sit next to the wallet it opens.
 *   - "Is my old password gone?" (imported wallet) -> said plainly: the original wallet.db and the copy
 *     inside this browser still open with the file's own password (BEAM Campfire does not re-key them).
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice, toast } from '../lib/ui.js';
import { changePassword, passwordProblem, isImported, MIN_PASSWORD } from '../lib/session.js';
import { notSavedNote } from '../lib/auth_ui.js';
import { t, tk } from '../lib/i18n.js';

// The screen shows them with t(). newLabel is read when it is shown (a getter), in the language of that
// moment, with the minimum length put in.
export const CHANGE_TEXT = Object.freeze({
  lead: tk('This changes how you unlock BEAM Campfire on this device. Your coins and your 12 words stay the same.'),
  leadImported: tk('This changes how you unlock BEAM Campfire on this device. Your coins stay the same. The original wallet.db file, and the copy inside this browser, still open with the password the file had.'),
  get newLabel() {
    return t('New password ({min}+ characters, not a common one)', { min: MIN_PASSWORD });
  },
});

export default function changePasswordScreen(app) {
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': t('Current password'), 'data-testid': 'cp-current' });
  const n1 = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': t('New password'), 'data-testid': 'cp-new' });
  const n2 = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': t('Repeat new password'), 'data-testid': 'cp-new2' });
  const msg = h('div', { 'aria-live': 'polite' });
  const cta = primary(t('Save new password'), save, { 'data-testid': 'cp-save' });

  async function save() {
    const p = passwordProblem(n1.value, n2.value);
    if (!cur.value) return put(msg, notice('warn', t('Enter your current password.')));
    if (p) return put(msg, notice('warn', p));
    cta.disabled = true;
    cta.textContent = t('Saving…');
    try {
      await changePassword(app, cur.value, n1.value);
      toast(t('Password changed'));
      app.go('settings');
    } catch (e) {
      cta.disabled = false;
      cta.textContent = t('Save new password');
      put(msg, notice('error', e.code === 'wrong_secret' ? t("The current password didn't match. Try again.") : e.message));
    }
  }

  const el = screen(
    { title: t('Change password'), back: () => app.back('settings'), actions: [cta] },
    h('p', { class: 'lead', 'data-testid': 'cp-lead', text: isImported(app) ? t(CHANGE_TEXT.leadImported) : t(CHANGE_TEXT.lead) }),
    h('label', { class: 'field' }, t('Current password'), cur),
    h('label', { class: 'field' }, CHANGE_TEXT.newLabel, n1),
    h('label', { class: 'field' }, t('Repeat new password'), n2),
    msg,
    notSavedNote(app),
  );
  return { el };
}
