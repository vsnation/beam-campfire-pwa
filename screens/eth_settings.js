/* Settings -> Ethereum wallet
 * Spec: ONE job: choose how the Ethereum wallet connects, and know what its backup is.
 *       Primary CTA: none (a list, like Settings); "Remove Ethereum wallet" is last and asks for the password.
 *       Taps from app open: 2 (Settings -> Ethereum wallet), 3 for any item; the private key is
 *       3 + the password (or Face ID).
 * Exit-intent reasons and answers:
 *   - "Which server should I pick?" -> Stack Wallet's is preselected (as on desktop); each one sees the
 *     IP with the address, so only the one picked is ever used - no silent fallback.
 *   - "Can I use my own node?" -> no, and why: the app's security policy names every server it may
 *     contact, so a typed-in one cannot be reached.
 *   - "Who knows my history?" -> the history switch says who is asked, and what is shown when it's off.
 *   - "Where are my Ethereum words?" -> not on this device: the person's paper is the backup.
 *   - "Imported from a private key: what is my backup?" -> that key, shown here after the password,
 *     with a copy button and the warning that nothing else brings the wallet back.
 *   - "How do I move this account to another wallet?" -> "Show private key", for words wallets too.
 *   - "Someone could see my screen" -> blurred until tapped, hidden again when the app is left.
 *   - "Will removing it lose my coins?" -> only without the words (or the key); said before the
 *     password is asked.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, toast, notice, openSheet, copyText } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { ETH_RPC_HOSTS, DEFAULT_ETH_RPC } from '../lib/eth/hosts.js';
import { getEthRecord, ethRecordKind, withEthKey } from '../lib/eth/vault.js';
import { bytesToHex } from '../lib/eth/hex.js';
import { ethPrefs, removeEthWallet } from '../lib/eth/wallet.js';

const MASK = '•'.repeat(64);
const KEY_WARNING = 'The private key is the only way back to it: keep it somewhere safe and never share it.';

/**
 * The private key, blurred until the person confirms it is them; then shown
 * with Copy and Hide. Nothing is decrypted before that: the blur covers dots,
 * not the key. A JS string cannot be zeroed, so the shown key lives only in
 * this element and is dropped on Hide, on leaving the app and with the screen.
 */
function keyReveal(app, { onHide = null } = {}) {
  let hex = null;
  const text = h('p', { class: 'mono', 'data-testid': 'eth-key-text', 'aria-label': 'Private key, hidden', text: MASK });
  const showBtn = h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'eth-key-reveal' }, icon('eye'), 'Tap to show the private key');
  const cover = h('div', { class: 'cover' }, showBtn);
  const copyBtn = h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'eth-key-copy', onclick: () => hex && copyText(hex, 'Private key copied') }, icon('copy'), 'Copy');
  const hideBtn = h('button', { class: 'btn btn-text btn-small', 'data-testid': 'eth-key-hide', onclick: () => hide() }, 'Hide');
  const tools = h('div', { class: 'btn-row key-actions hidden' }, copyBtn, hideBtn);
  const box = h('div', { class: 'key-box masked', 'data-testid': 'eth-key-box', 'data-state': 'masked' }, text);
  const el = h('div', {}, h('div', { class: 'reveal' }, box, cover), tools);

  function hide() {
    if (!hex && box.dataset.state === 'masked') return;
    hex = null;
    text.textContent = MASK;
    text.setAttribute('aria-label', 'Private key, hidden');
    box.classList.add('masked');
    box.dataset.state = 'masked';
    tools.classList.add('hidden');
    if (!cover.isConnected) box.after(cover);
    if (onHide) onHide();
  }

  /** Asks for the password (or Face ID), then opens the sealed key. true once shown. */
  async function show() {
    const ok = await confirmIdentity(app, { title: 'Show the private key', detail: 'Anyone who sees it can take your Ethereum coins. Make sure no one is looking.', cta: 'Show private key' });
    if (!ok) return false;
    try {
      hex = await withEthKey(app, async ({ sk }) => bytesToHex(sk, false));
    } catch (e) {
      toast(`The key could not be opened: ${e.message}`);
      return false;
    }
    text.textContent = hex;
    text.removeAttribute('aria-label');
    box.classList.remove('masked');
    box.dataset.state = 'shown';
    cover.remove();
    tools.classList.remove('hidden');
    return true;
  }

  showBtn.addEventListener('click', show);
  return { el, show, hide };
}

export default function ethSettings(app) {
  const body = h('div', { class: 'stack' });
  let reveal = null;
  // An app switcher snapshot must not carry the key.
  const onHidden = () => document.visibilityState === 'hidden' && reveal && reveal.hide();
  document.addEventListener('visibilitychange', onHidden);
  const row = (ico, title, sub, onclick, extra = {}) =>
    h('button', { class: 'row', onclick, ...extra }, h('span', { class: 'ico' }, icon(ico)), h('span', { class: 'main' }, h('div', { class: 't', text: title }), sub ? h('div', { class: 's', text: sub }) : null), h('span', { class: 'chev' }, icon('chevron')));

  function render(record) {
    if (reveal) reveal.hide();
    reveal = null;
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
    const prices = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': 'Bridge prices from CoinGecko', 'data-testid': 'eth-bridge-prices-switch', checked: app.prefs && app.prefs.bridgePrices === true });
    prices.addEventListener('change', async () => {
      await app.setPrefs({ bridgePrices: prices.checked });
      toast(prices.checked ? 'Bridge prices from CoinGecko are on' : 'Bridge prices are off: only WBEAM → BEAM can move');
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
        h(
          'label',
          { class: 'row' },
          h('span', { class: 'ico' }, icon('bridge')),
          h('span', { class: 'main' }, h('div', { class: 't', text: 'Bridge prices from CoinGecko' }), h('div', { class: 's wrap', text: 'The bridge fee follows coin prices. CoinGecko sees your IP. Off: only WBEAM → BEAM can move.' })),
          prices,
        ),
        row('shield', 'Ethereum privacy', 'What Ethereum and its server can see', () => app.go('ethPrivacy'), { 'data-testid': 'eth-privacy-row' }),
      ),
      h('p', { class: 'small', text: 'A server of your own cannot be added: the app may contact only the servers listed here, which protects you from a page that tries to send your data elsewhere.' }),
      h('p', { class: 'section-title', text: 'Backup' }),
      ...backup(record),
      h('p', { class: 'section-title', text: 'Remove' }),
      h('div', { class: 'card list' }, row('trash', 'Remove Ethereum wallet', 'From this device only. Coins stay on Ethereum.', () => removeSheet(record), { 'data-testid': 'eth-remove' })),
    );
  }

  /** What brings it back: the private key (shown here), or the words on paper (and the key on request). */
  function backup(record) {
    if (ethRecordKind(record) === 'key') {
      reveal = keyReveal(app);
      return [
        h(
          'div',
          { class: 'card', 'data-testid': 'eth-backup', 'data-kind': 'key' },
          h('h3', { text: 'Private key' }),
          notice('warn', h('strong', { text: 'This wallet has no recovery words. ' }), KEY_WARNING),
          reveal.el,
        ),
      ];
    }
    const words = h(
      'div',
      { class: 'card', 'data-testid': 'eth-backup', 'data-kind': 'words' },
      h('h3', { text: 'Your Ethereum words are your backup' }),
      h('p', { text: `This device doesn't keep them, so it cannot show them again. Keep your paper with the ${record.words} words${record.passphrase ? ' and the passphrase' : ''} safe; they are not your BEAM words.` }),
    );
    const slot = h('div');
    const collapsed = () =>
      put(slot, h('div', { class: 'card list' }, row('key', 'Show private key', 'To move it to another wallet', open, { 'data-testid': 'eth-show-key' })));
    async function open() {
      reveal = keyReveal(app, { onHide: () => { reveal = null; collapsed(); } });
      if (!(await reveal.show())) {
        reveal = null;
        return;
      }
      put(
        slot,
        h(
          'div',
          { class: 'card', 'data-testid': 'eth-key-card' },
          h('h3', { text: 'Private key' }),
          notice('warn', h('strong', { text: 'The same account as your words, in one line. ' }), 'Anyone who has it can take your Ethereum coins: never share it, and paste it only into a wallet you trust.'),
          reveal.el,
        ),
      );
    }
    collapsed();
    return [words, slot];
  }

  function removeSheet(record) {
    let message = null;
    const byKey = ethRecordKind(record) === 'key';
    const onlyWay = byKey ? 'Only its private key can bring it back. ' : `Only your ${record.words} Ethereum words${record.passphrase ? ' and passphrase' : ''} can bring it back. `;
    const stopIf = byKey ? 'If you have not saved it (Backup, above), stop here: removing it without it loses its coins for good.' : 'If you do not have them written down, stop here: removing it without them loses its coins for good.';
    openSheet((close, rerender) => [
      h('h2', { text: 'Remove the Ethereum wallet?' }),
      notice('warn', h('strong', { text: onlyWay }), stopIf),
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
  return {
    el,
    destroy() {
      document.removeEventListener('visibilitychange', onHidden);
      if (reveal) reveal.hide();
      reveal = null;
    },
  };
}
