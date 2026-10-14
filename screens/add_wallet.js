/* Add a wallet
 * Spec: ONE job: add another BEAM wallet to this device, under a name: a new one, one from its
 *       12 words, or one from its wallet.db file (the same steps as the first wallet's).
 *       Primary CTA: "Create a new wallet" (secondary: "Restore with 12 words", "Import a
 *       wallet.db file").
 *       Taps from app open: Home's wallet name (1) → Add a wallet (2) → a choice (3).
 * Exit-intent reasons and answers:
 *   - "Will this touch the wallet I have?" -> said first: your wallets stay as they are; each has
 *     its own password.
 *   - "What do I call it?" -> a name is filled in ("Wallet 2"); change it or keep it. A name in use
 *     is said, with what to do.
 *   - "What happens to the open wallet?" -> it locks once the new one is ready; Home's wallet name
 *     opens it again.
 * On an address other websites share (lib/shared_origin.js): no Create; primary CTA "Go to
 * pwa.buybeam.my"; Restore and Import here each behind a warning sheet (screens/welcome.js).
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, secondary, notice } from '../lib/ui.js';
import { listWallets, nextName, nameProblem, nameOf, cleanName, MAX_NAME } from '../lib/wallets.js';
import { onSharedOrigin } from '../lib/shared_origin.js';
import { sharedOriginParts } from './welcome.js';
import { t } from '../lib/i18n.js';

export default function addWallet(app) {
  // A fresh start: words or a choice from an add flow left midway do not linger (Settings -> Backup
  // must never take a leftover "adding" for a new wallet).
  if (app.setup && Array.isArray(app.setup.words)) app.setup.words.fill('');
  app.setup = null;
  const back = () => (app.dbPass ? app.back('home') : app.go('unlock'));
  let list = null;
  const msg = h('div', { 'aria-live': 'polite', 'data-testid': 'add-msg' });
  const input = h('input', { class: 'input', type: 'text', maxlength: String(MAX_NAME), autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', 'aria-label': t('Wallet name'), 'data-testid': 'add-name' });
  const openNote = h('p', { class: 'small' });
  listWallets().then((l) => {
    list = l;
    if (!input.value) input.value = nextName(l);
    const open = app.dbPass && app.record ? nameOf(app.record) : null;
    openNote.textContent = open ? t('{name} locks once the new wallet is ready. Tap the wallet name on Home to open it again.', { name: open }) : t('Each wallet opens with its own password or Face ID.');
  });
  input.addEventListener('input', () => put(msg));

  function go(mode, to) {
    if (!list) return;
    const problem = nameProblem(input.value, list);
    if (problem) {
      put(msg, notice('warn', problem));
      input.focus();
      return;
    }
    app.setup = { mode, adding: true, name: cleanName(input.value) };
    app.go(to);
  }

  // An address other websites share keeps the wallets it has and makes no new one; a restore or an
  // import there comes after a warning (lib/shared_origin.js, audit UPD-2).
  const shared = onSharedOrigin()
    ? sharedOriginParts(app, { restore: () => go('restore', 'restore'), importDb: () => go('import', 'importWallet'), testid: 'add-' })
    : null;
  const el = screen(
    {
      title: t('Add a wallet'),
      back,
      actions: shared ? shared.actions : [
        primary(t('Create a new wallet'), () => go('create', 'backup'), { 'data-testid': 'add-create' }),
        secondary(t('Restore with 12 words'), () => go('restore', 'restore'), { 'data-testid': 'add-restore' }),
        secondary(t('Import a wallet.db file'), () => go('import', 'importWallet'), { 'data-testid': 'add-import' }),
      ],
    },
    h('p', { class: 'lead', text: shared ? t('Your wallets here stay as they are and keep working.') : t('Your wallets stay as they are. The new one gets its own password, and its own Face ID if you turn it on.') }),
    shared ? shared.body : null,
    h('label', { class: 'field' }, t('Name'), input),
    msg,
    openNote,
  );
  return { el };
}
