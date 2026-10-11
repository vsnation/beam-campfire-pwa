/* Delete wallet from this device (also: "Forgot your password?")
 * Spec: ONE job: remove this wallet from this device, knowingly.
 *       Primary CTA: "Delete from this device" (enabled only after typing DELETE).
 *       Taps from app open: 3 (Settings -> Delete) / 2 from the unlock screen / 4 for another
 *       wallet (Settings -> Wallets -> its row -> Delete).
 * Exit-intent reasons and answers:
 *   - "Will I lose my money?" -> only if the 12 words are lost too; said in one sentence.
 *   - "I forgot my password" -> this is the way back: delete here, restore with the words.
 *   - Imported from a wallet.db: the same, with the original file and its password instead of words.
 *   - "Does this delete my other wallets?" -> with several, it names the one that goes and says the
 *     others stay as they are; only its own file and data are removed (lib/wallets.js).
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice, toast } from '../lib/ui.js';
import { wipeWallet, isImported } from '../lib/session.js';
import { hasEthWallet, ethWalletKind } from '../lib/eth/record.js';
import { listWallets, nameOf, walletStore } from '../lib/wallets.js';

export default function deleteWallet(app, params = {}) {
  const forgot = Boolean(params.forgot);
  // Several wallets: Settings -> Wallets names the one to delete; otherwise it is the selected one.
  const other = Boolean(params.id && !(app.record && app.record.id === params.id));
  if (!app.record && !other) {
    queueMicrotask(() => app.go('welcome'));
    return { el: h('div') };
  }
  const target = other ? { id: params.id, name: params.name, imported: Boolean(params.imported), slot0: false } : app.record;
  const name = other ? params.name : nameOf(app.record);
  const imported = other ? Boolean(params.imported) : isImported(app);
  const othersBox = h('div');
  const input = h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Type DELETE', 'data-testid': 'delete-confirm', placeholder: 'DELETE' });
  const msg = h('div');
  // With an Ethereum wallet beside it, its own words (or private key) are needed too: it goes with it.
  const ethBox = h('div');
  const kvP = other ? listWallets().then((l) => {
    const r = l.find((x) => x.id === params.id);
    if (!r) throw new Error('gone');
    return walletStore(r);
  }) : Promise.resolve(undefined);
  kvP.then((kv) => Promise.all([hasEthWallet(kv), ethWalletKind(kv)])).then(([has, known]) => {
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

  listWallets().then((l) => {
    if (l.length > 1) put(othersBox, h('p', { class: 'lead', 'data-testid': 'delete-others', text: `Only ${name} is deleted. ${l.length === 2 ? 'Your other wallet stays as it is.' : `Your other ${l.length - 1} wallets stay as they are.`}` }));
  }, () => {});

  async function run() {
    cta.disabled = true;
    cta.textContent = 'Deleting…';
    try {
      const list = await listWallets();
      const rec = list.find((r) => r.id === target.id);
      if (!rec) throw new Error('it is not on this device any more');
      const { others } = await wipeWallet(app, rec);
      if (other) {
        toast(`${name} was deleted from this device`);
        app.go('wallets', {}, { replace: true });
      } else if (others.length) app.go('unlock', { reason: 'deleted', deleted: name }, { reset: true });
      else app.go('welcome', {}, { reset: true });
    } catch (e) {
      cta.disabled = false;
      cta.textContent = 'Delete from this device';
      put(msg, notice('error', `It could not be deleted: ${e.message}`));
    }
  }

  const el = screen(
    { title: forgot ? 'Forgot your password?' : 'Delete wallet', back: () => app.back(forgot ? 'unlock' : other ? 'wallets' : 'settings'), actions: [cta] },
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
    h('p', { class: 'lead', 'data-testid': 'delete-what', text: `This removes ${name}, its history and its settings from this device. Nothing is changed on the blockchain.` }),
    othersBox,
    h('label', { class: 'field' }, 'Type DELETE to confirm', input),
    msg,
  );
  return { el };
}
