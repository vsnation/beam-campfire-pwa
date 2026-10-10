/* Delete wallet from this device (also: "Forgot your password?")
 * Spec: ONE job: remove this wallet from this device, knowingly.
 *       Primary CTA: "Delete from this device" (enabled only after typing DELETE).
 *       Taps from app open: 3 (Settings -> Delete) / 2 from the unlock screen.
 * Exit-intent reasons and answers:
 *   - "Will I lose my money?" -> only if the 12 words are lost too; said in one sentence.
 *   - "I forgot my password" -> this is the way back: delete here, restore with the words.
 *   - Imported from a wallet.db: the same, with the original file and its password instead of words.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice } from '../lib/ui.js';
import { wipeWallet, isImported } from '../lib/session.js';
import { wallet } from '../lib/wallet.js';
import { getPrefs } from '../lib/store.js';
import { hasEthWallet, ethWalletKind } from '../lib/eth/record.js';

export default function deleteWallet(app, params = {}) {
  const forgot = Boolean(params.forgot);
  const imported = isImported(app);
  const input = h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Type DELETE', 'data-testid': 'delete-confirm', placeholder: 'DELETE' });
  const msg = h('div');
  // With an Ethereum wallet beside it, its own words (or private key) are needed too: it goes with it.
  const ethBox = h('div');
  Promise.all([hasEthWallet(), ethWalletKind()]).then(([has, known]) => {
    const kind = has ? known || 'words' : null;
    const text =
      kind === 'key'
        ? 'Its private key brings it back; your BEAM words do not. Save the key (Settings → Ethereum wallet → Backup) and keep your BEAM words before you delete.'
        : 'Its own words bring it back; your BEAM words do not. Keep both sets of words before you delete.';
    if (kind) put(ethBox, h('div', { 'data-testid': 'delete-eth-words', 'data-kind': kind }, notice('warn', h('strong', { text: 'Your Ethereum wallet is removed too. ' }), text)));
  }, () => {});
  const cta = primary('Delete from this device', run, { disabled: true, 'data-testid': 'delete-submit' });
  cta.classList.replace('btn-primary', 'btn-danger');
  input.addEventListener('input', () => (cta.disabled = input.value.trim().toUpperCase() !== 'DELETE'));

  async function run() {
    cta.disabled = true;
    cta.textContent = 'Deleting…';
    try {
      await wallet.stop();
      await wipeWallet(app);
      app.prefs = await getPrefs();
      app.go('welcome');
    } catch (e) {
      cta.disabled = false;
      cta.textContent = 'Delete from this device';
      put(msg, notice('error', `It could not be deleted: ${e.message}`));
    }
  }

  const el = screen(
    { title: forgot ? 'Forgot your password?' : 'Delete wallet', back: () => app.go(forgot ? 'unlock' : 'settings'), actions: [cta] },
    forgot
      ? h('p', {
          class: 'lead',
          text: imported
            ? 'Nobody can reset the password. With the original wallet.db file and the password it had, you can delete the wallet from this device and import the file again; your coins come back.'
            : 'Nobody can reset the password. With your 12 words you can delete the wallet from this device and restore it; your coins come back.',
        })
      : null,
    imported
      ? notice('warn', h('strong', { text: 'Only the original wallet.db file and its password can bring this wallet back. ' }), 'It has no 12 words. If you do not have both, stop here: deleting without them loses the money for good.')
      : notice('warn', h('strong', { text: 'Only your 12 words can bring this wallet back. ' }), 'If you do not have them written down, stop here: deleting without them loses the money for good.'),
    ethBox,
    h('p', { class: 'lead', text: 'This removes the wallet, its history and its settings from this device. Nothing is changed on the blockchain.' }),
    h('label', { class: 'field' }, 'Type DELETE to confirm', input),
    msg,
  );
  return { el };
}
