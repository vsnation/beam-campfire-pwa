/* Owner key (Settings -> Backup -> Show owner key)
 * Spec: ONE job: hand the owner key to a node the person runs, after proving it is them.
 *       Primary CTA: "Show owner key" (password, then Face ID when it is set up), then
 *       "Copy owner key".
 *       Taps from app open: 3 to the password (Settings -> Backup -> Show owner key), 5 to a
 *       copied key (Show owner key, Copy owner key), plus Face ID when it is on.
 *       The key is encrypted with the password typed here, so a node started with that same
 *       password reads it. It is never logged or stored, and it leaves the page when the screen
 *       is left or the wallet locks.
 * Exit-intent reasons and answers:
 *   - "What is this for?" -> first line: your own node finds every payment, offline and
 *     max-privacy ones too.
 *   - "Can someone take my money with it?" -> no: it can see balance and history, not spend.
 *   - "Which password?" -> the BEAM Campfire one; the node needs the same.
 *   - "Wrong password" / "Face ID failed" -> says so, keeps the field, says the way forward.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, textButton, notice, copyText } from '../lib/ui.js';
import { hasPasskey, openWithPasswordFor, openWithPasskeyFor } from '../lib/session.js';
import { wallet } from '../lib/wallet.js';
import { OWNER_KEY_TEXT as T, looksLikeOwnerKey } from '../lib/owner_key.js';

export default function ownerKey(app, params = {}) {
  // Opened from Backup, or from the BEAM node screens, and goes back there (the fallback when Back has no history).
  const backTo = ['ownNode', 'nodeSettings'].includes(params.from) ? params.from : 'backup';
  if (!app.dbPass) {
    queueMicrotask(() => app.go('unlock'));
    return { el: h('div') };
  }
  const passkey = hasPasskey(app);
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': T.passwordLabel, placeholder: 'Password', 'data-testid': 'okey-pw' });
  const msg = h('div', { class: 'okey-msg', 'aria-live': 'polite', 'data-testid': 'okey-msg' });
  const keyText = h('p', { class: 'mono owner-key', 'data-testid': 'owner-key' });
  const cta = primary(T.cta, () => show(), { 'data-testid': 'okey-show' });
  let busy = false;
  let key = null;
  let gone = false;

  const askBody = () => [
    h('p', { class: 'lead', text: T.lead }),
    h(
      'div',
      { class: 'card', 'data-testid': 'okey-what' },
      h('h3', { text: T.whatTitle }),
      h('ul', { class: 'steps-list' }, h('li', { text: T.can }), h('li', { text: T.cannot }), h('li', { text: T.copies })),
    ),
    notice('warn', T.share),
    h('label', { class: 'field' }, T.passwordLabel, pw),
    h('p', { class: 'small', text: passkey ? `${T.passwordHint} ${T.faceIdHint}` : T.passwordHint }),
    msg,
  ];

  // Sticky actions: the button stays on screen at 375 x 667 whatever message shows above it.
  const el = screen({ title: T.title, back: () => app.back(backTo), actions: [cta], cls: 'sticky-actions' }, ...askBody());
  const content = el.querySelector('.content');
  const actions = el.querySelector('.actions');
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && show());
  setTimeout(() => pw.isConnected && pw.focus(), 50);

  // Every message is scrolled into view, above the pinned button.
  const say = (n) => {
    put(msg, n);
    msg.scrollIntoView({ block: 'nearest' });
  };

  const ready = () => {
    busy = false;
    cta.disabled = false;
    cta.textContent = T.cta;
  };

  async function show() {
    if (busy) return;
    if (!pw.value) return say(notice('warn', 'Enter your password.'));
    busy = true;
    cta.disabled = true;
    cta.textContent = 'Checking…';
    const password = pw.value;
    try {
      await openWithPasswordFor(app, password);
    } catch (e) {
      ready();
      say(notice('error', e.code === 'wrong_secret' ? "That password didn't match. Try again." : e.message));
      pw.select();
      return;
    }
    if (passkey) {
      say(notice('info', 'Confirm with Face ID…'));
      try {
        await openWithPasskeyFor(app);
      } catch (e) {
        ready();
        say(e.code === 'cancelled' ? notice('info', `Face ID was cancelled. Tap ${T.cta} to try again.`) : notice('warn', "Face ID didn't work. Try again, or turn Face ID off in Settings and use your password alone."));
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
    if (!looksLikeOwnerKey(k)) {
      ready();
      say(notice('error', 'The owner key could not be read. Try again.'));
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
      h('p', { class: 'lead', text: T.shownLead }),
      h('div', { class: 'address-box' }, keyText),
      notice('warn', T.shownWarn),
    );
    const copyBtn = primary(h('span', { text: T.copyCta }), () => key && copyText(key, T.copied), { 'data-testid': 'okey-copy' });
    copyBtn.prepend(icon('copy'));
    put(actions, copyBtn, textButton(T.done, () => app.back(backTo), { 'data-testid': 'okey-done' }));
  }

  // Leaving the screen and locking (app.go runs destroy; lock also runs the hooks) take the key off the page.
  const forget = () => {
    key = null;
    keyText.textContent = '';
    pw.value = '';
    put(content);
  };
  app.lockHooks.add(forget);
  return {
    el,
    destroy() {
      gone = true;
      forget();
      app.lockHooks.delete(forget);
    },
  };
}
