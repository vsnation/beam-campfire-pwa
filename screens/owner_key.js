/* Owner key (Settings -> Backup -> Show owner key)
 * Spec: ONE job: hand the owner key to a node the person runs, after proving it is them.
 *       Primary CTA: "Show owner key" (password, then Face ID when it is set up), then
 *       "Copy owner key".
 *       Taps from app open: 3 to the password (Settings -> Backup -> Show owner key), 5 to a
 *       copied key (Show owner key, Copy owner key), plus Face ID when it is on.
 *       The key is encrypted with the password typed here, so a node started with that same
 *       password reads it. It is never logged or stored, and it leaves the page when the screen
 *       is left, the wallet locks or the app goes out of sight (the app switcher keeps a picture
 *       of the screen); showing it again asks for the password again.
 * Exit-intent reasons and answers:
 *   - "What is this for?" -> first line: your own node finds every payment, offline and
 *     max-privacy ones too.
 *   - "Can someone take my money with it?" -> no: it can see balance and history, not spend.
 *   - "Which password?" -> the BEAM Campfire one; the node needs the same.
 *   - "Wrong password" / "Face ID failed" -> says so, keeps the field, says the way forward.
 *   - "Is it safe on the clipboard?" -> Copy says the clipboard is emptied after a minute (and at
 *     the lock), and that clipboard history apps may keep it.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, textButton, notice, copySecret, focusSoon, onHidden } from '../lib/ui.js';
import { hasPasskey, openWithPasswordFor, openWithPasskeyFor } from '../lib/session.js';
import { wallet } from '../lib/wallet.js';
import { OWNER_KEY_TEXT as T, looksLikeOwnerKey } from '../lib/owner_key.js';
import { t, tk } from '../lib/i18n.js';

// Said when the key left the screen because the app went out of sight.
export const HIDDEN_AWAY = tk('The key was hidden when you left BEAM Campfire. Enter your password to show it again.');

export default function ownerKey(app, params = {}) {
  // Opened from Backup, or from the BEAM node screens, and goes back there (the fallback when Back has no history).
  const backTo = ['ownNode', 'nodeSettings'].includes(params.from) ? params.from : 'backup';
  if (!app.dbPass) {
    queueMicrotask(() => app.go('unlock'));
    return { el: h('div') };
  }
  const passkey = hasPasskey(app);
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': t(T.passwordLabel), placeholder: t('Password'), 'data-testid': 'okey-pw' });
  const msg = h('div', { class: 'okey-msg', 'aria-live': 'polite', 'data-testid': 'okey-msg' });
  const keyText = h('p', { class: 'mono owner-key', 'data-testid': 'owner-key' });
  const cta = primary(t(T.cta), () => show(), { 'data-testid': 'okey-show' });
  let busy = false;
  let key = null;
  let gone = false;

  const askBody = () => [
    h('p', { class: 'lead', text: t(T.lead) }),
    h(
      'div',
      { class: 'card', 'data-testid': 'okey-what' },
      h('h3', { text: t(T.whatTitle) }),
      h('ul', { class: 'steps-list' }, h('li', { text: t(T.can) }), h('li', { text: t(T.cannot) }), h('li', { text: t(T.copies) })),
    ),
    notice('warn', t(T.share)),
    h('label', { class: 'field' }, t(T.passwordLabel), pw),
    h('p', { class: 'small', text: passkey ? `${t(T.passwordHint)} ${t(T.faceIdHint)}` : t(T.passwordHint) }),
    msg,
  ];

  // Sticky actions: the button stays on screen at 375 x 667 whatever message shows above it.
  const el = screen({ title: t(T.title), back: () => app.back(backTo), actions: [cta], cls: 'sticky-actions' }, ...askBody());
  const content = el.querySelector('.content');
  const actions = el.querySelector('.actions');
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && show());
  focusSoon(pw);

  // Every message is scrolled into view, above the pinned button.
  const say = (n) => {
    put(msg, n);
    msg.scrollIntoView({ block: 'nearest' });
  };

  const ready = () => {
    busy = false;
    cta.disabled = false;
    cta.textContent = t(T.cta);
  };

  async function show() {
    if (busy) return;
    if (!pw.value) return say(notice('warn', t('Enter your password.')));
    busy = true;
    cta.disabled = true;
    cta.textContent = t('Checking…');
    const password = pw.value;
    try {
      await openWithPasswordFor(app, password);
    } catch (e) {
      ready();
      say(notice('error', e.code === 'wrong_secret' ? t("That password didn't match. Try again.") : e.message));
      pw.select();
      return;
    }
    if (passkey) {
      say(notice('info', t('Confirm with Face ID…')));
      try {
        await openWithPasskeyFor(app);
      } catch (e) {
        ready();
        say(e.code === 'cancelled' ? notice('info', t('Face ID was cancelled. Tap {cta} to try again.', { cta: t(T.cta) })) : notice('warn', t("Face ID didn't work. Try again, or turn Face ID off in Settings and use your password alone.")));
        return;
      }
    }
    let k;
    try {
      k = await wallet.ownerKey(password);
    } catch (e) {
      ready();
      say(notice('error', e.message));
      return;
    }
    if (gone || !app.dbPass) return; // left or locked meanwhile
    if (document.visibilityState === 'hidden') {
      // Out of sight meanwhile: not put on a screen the app switcher may be picturing.
      ready();
      pw.value = '';
      say(notice('info', t(HIDDEN_AWAY)));
      return;
    }
    if (!looksLikeOwnerKey(k)) {
      ready();
      say(notice('error', t('The owner key could not be read. Try again.')));
      return;
    }
    key = k;
    pw.value = '';
    shown();
  }

  function shown() {
    keyText.textContent = key;
    put(
      content,
      h('p', { class: 'lead', text: t(T.shownLead) }),
      h('div', { class: 'address-box' }, keyText),
      notice('warn', t(T.shownWarn)),
    );
    const copied = t(T.copied);
    const copyBtn = primary(h('span', { text: t(T.copyCta) }), () => key && copySecret(key, copied, { app }), { 'data-testid': 'okey-copy' });
    copyBtn.prepend(icon('copy'));
    put(actions, copyBtn, textButton(t(T.done), () => app.back(backTo), { 'data-testid': 'okey-done' }));
  }

  // Leaving the screen and locking (app.go runs destroy; lock also runs the hooks) take the key off the page.
  const forget = () => {
    key = null;
    keyText.textContent = '';
    pw.value = '';
    put(content);
  };
  app.lockHooks.add(forget);
  // Out of sight: the key leaves the page and the screen asks again, as before it was shown.
  const offHidden = onHidden(() => {
    if (!key || gone) return;
    key = null;
    keyText.textContent = '';
    put(content, ...askBody());
    put(actions, cta);
    ready();
    say(notice('info', t(HIDDEN_AWAY)));
  });
  return {
    el,
    destroy() {
      gone = true;
      offHidden();
      forget();
      app.lockHooks.delete(forget);
    },
  };
}
