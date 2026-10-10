/* Settings -> Ethereum wallet
 * Spec: ONE job: choose how the Ethereum wallet connects, and know what its backup is.
 *       Primary CTA: none (a list, like Settings); "Remove Ethereum wallet" is last and asks for the password.
 *       Taps from app open: 2 (Settings -> Ethereum wallet), 3 for any item.
 * Exit-intent reasons and answers:
 *   - "Which server should I pick?" -> Stack Wallet's is preselected (as on desktop); each one sees the
 *     IP with the address, so only the one picked is ever used - no silent fallback.
 *   - "Can I use my own node?" -> no, and why: the app's security policy names every server it may
 *     contact, so a typed-in one cannot be reached.
 *   - "Who knows my history?" -> the history switch says who is asked, and what is shown when it's off.
 *   - "Where are my Ethereum words?" -> not on this device: the person's paper is the backup.
 *   - "Will removing it lose my coins?" -> only without the words; said before the password is asked.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, toast, notice, openSheet } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { ETH_RPC_HOSTS, DEFAULT_ETH_RPC } from '../lib/eth/hosts.js';
import { getEthRecord } from '../lib/eth/vault.js';
import { ethPrefs, removeEthWallet } from '../lib/eth/wallet.js';

export default function ethSettings(app) {
  const body = h('div', { class: 'stack' });
  const row = (ico, title, sub, onclick, extra = {}) =>
    h('button', { class: 'row', onclick, ...extra }, h('span', { class: 'ico' }, icon(ico)), h('span', { class: 'main' }, h('div', { class: 't', text: title }), sub ? h('div', { class: 's', text: sub }) : null), h('span', { class: 'chev' }, icon('chevron')));

  function render(record) {
    const pref = ethPrefs(app);
    const sel = h('select', { class: 'inline', 'aria-label': 'Ethereum server', 'data-testid': 'eth-server-select' }, ...ETH_RPC_HOSTS.map((x) => h('option', { value: x.id, text: x.id === DEFAULT_ETH_RPC ? `${x.name} (default)` : x.name })));
    sel.value = pref.rpcId;
    sel.addEventListener('change', async () => {
      await app.setPrefs({ ethRpc: sel.value });
      toast(`Ethereum through ${ETH_RPC_HOSTS.find((x) => x.id === sel.value).name}`);
      render(record);
    });
    const hist = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': 'History from Stack Wallet', 'data-testid': 'eth-history-switch', checked: pref.history });
    hist.addEventListener('change', async () => {
      await app.setPrefs({ ethHistory: hist.checked });
      toast(hist.checked ? "History from Stack Wallet's index is on" : 'Only what this device sent is shown');
    });
    put(
      body,
      h('p', { class: 'section-title', text: 'Connection' }),
      h(
        'div',
        { class: 'card list' },
        h('div', { class: 'row field-row' }, h('span', { class: 'ico' }, icon('globe')), h('span', { class: 'main' }, h('div', { class: 't', text: 'Ethereum server' }), h('div', { class: 's wrap', text: 'Sees your IP with your address. Only this one is used.' })), sel),
        h(
          'label',
          { class: 'row' },
          h('span', { class: 'ico' }, icon('activity')),
          h('span', { class: 'main' }, h('div', { class: 't', text: 'History from Stack Wallet' }), h('div', { class: 's wrap', text: "Asks Stack Wallet's index for this address's past payments. Off: only what this device sent." })),
          hist,
        ),
        row('shield', 'Ethereum privacy', 'What Ethereum and its server can see', () => app.go('ethPrivacy'), { 'data-testid': 'eth-privacy-row' }),
      ),
      h('p', { class: 'small', text: 'A server of your own cannot be added: the app may contact only the servers listed here, which protects you from a page that tries to send your data elsewhere.' }),
      h('p', { class: 'section-title', text: 'Backup' }),
      h(
        'div',
        { class: 'card', 'data-testid': 'eth-backup' },
        h('h3', { text: 'Your Ethereum words are your backup' }),
        h('p', { text: `This device doesn't keep them, so it cannot show them again. Keep your paper with the ${record.words} words${record.passphrase ? ' and the passphrase' : ''} safe; they are not your BEAM words.` }),
      ),
      h('p', { class: 'section-title', text: 'Remove' }),
      h('div', { class: 'card list' }, row('trash', 'Remove Ethereum wallet', 'From this device only. Coins stay on Ethereum.', () => removeSheet(record), { 'data-testid': 'eth-remove' })),
    );
  }

  function removeSheet(record) {
    let message = null;
    openSheet((close, rerender) => [
      h('h2', { text: 'Remove the Ethereum wallet?' }),
      notice('warn', h('strong', { text: `Only your ${record.words} Ethereum words${record.passphrase ? ' and passphrase' : ''} can bring it back. ` }), 'If you do not have them written down, stop here: removing it without them loses its coins for good.'),
      h('p', { class: 'lead', text: 'This removes the Ethereum key and what this device sent from this device. Nothing changes on Ethereum, and your BEAM wallet stays as it is.' }),
      message,
      h('button', {
        class: 'btn btn-danger',
        'data-testid': 'eth-remove-confirm',
        onclick: async () => {
          const ok = await confirmIdentity(app, { title: 'Remove the Ethereum wallet', detail: 'Confirm it is you to remove it from this device.', cta: 'Remove' });
          if (!ok) return;
          try {
            await removeEthWallet();
            close();
            toast('Ethereum wallet removed from this device');
            app.go('settings');
          } catch (e) {
            message = notice('error', `It could not be removed: ${e.message}`);
            rerender();
          }
        },
      }, 'Remove Ethereum wallet'),
      h('button', { class: 'btn btn-text', onclick: () => close() }, 'Keep it'),
    ], { label: 'Remove the Ethereum wallet' });
  }

  (async () => {
    const record = await getEthRecord();
    if (!record) return app.go('ethStart', { from: 'settings' });
    render(record);
  })();

  const el = screen({ title: 'Ethereum wallet', back: () => app.go('settings'), cls: 'settings' }, body);
  return { el };
}
