/* Ethereum privacy (last setup step, before the Ethereum wallet's first connection; also Settings -> Ethereum)
 * Spec: ONE job: say, before anything connects, what Ethereum and its server can see.
 *       Primary CTA: "Connect" (secondary: "How to hide my IP"). From Settings: "Done".
 *       Taps from app open: 6 + 3 word taps when creating (Ethereum, Create, I wrote them down,
 *       3 words, Confirm words, Connect), 4 + paste when importing.
 * Exit-intent reasons and answers:
 *   - "A privacy wallet on a public chain?" -> said first and plainly: everything on Ethereum is public;
 *     the BEAM wallet stays private.
 *   - "Who sees my IP?" -> the one Ethereum server picked (Stack Wallet's by default), and how to hide it.
 *   - "Is there a fallback that leaks to more servers?" -> no: one server, picked by you.
 *   - "Can I see my history without telling Stack Wallet?" -> the history switch, named here.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice } from '../lib/ui.js';
import { ethKeyFromMnemonic, wipe } from '../lib/eth/crypto.js';
import { saveEthKey, VaultError } from '../lib/eth/vault.js';
import { ethPrefs } from '../lib/eth/wallet.js';

export function ethPrivacyLead(app) {
  const { host } = ethPrefs(app);
  return `The Ethereum server this wallet uses (${host.name}'s${host.id === 'stackwallet' ? ', unless you pick another in Settings' : ''}) sees your IP address together with your Ethereum address each time the app checks a balance or sends. It can link the two and see when you are online.`;
}

export default function ethPrivacy(app, params = {}) {
  const setup = Boolean(params.setup) && app.ethSetup && Array.isArray(app.ethSetup.words);
  const msg = h('div', { 'aria-live': 'polite' });
  const details = h(
    'div',
    { class: 'card hidden', 'data-testid': 'eth-ip-details' },
    h('h3', { text: 'How to hide your IP address' }),
    h(
      'ol',
      { class: 'steps-list' },
      h('li', { text: 'iCloud Private Relay (needs iCloud+): Settings → [your name] → iCloud → Private Relay → On. Apple documents it for browsing in Safari; for apps added to the Home Screen it does not say, so do not rely on it alone.' }),
      h('li', { text: 'A VPN you trust covers every app on the phone, including BEAM Campfire. Turn it on before you open the wallet.' }),
    ),
  );
  const toggle = secondary('How to hide my IP', () => {
    details.classList.toggle('hidden');
    toggle.textContent = details.classList.contains('hidden') ? 'How to hide my IP' : 'Hide details';
  }, { 'data-testid': 'eth-ip-how' });

  async function connect() {
    cta.disabled = true;
    cta.textContent = 'Setting up…';
    put(msg);
    const s = app.ethSetup;
    let key = null;
    try {
      key = await ethKeyFromMnemonic(s.words.join(' '), s.mode === 'import' ? s.passphrase || '' : '');
      await saveEthKey(app, { sk: key.sk, address: key.address, words: s.words.length, passphrase: Boolean(s.passphrase) });
      s.words.fill('');
      app.ethSetup = null;
      app.go('ethHome', { created: s.mode });
    } catch (e) {
      cta.disabled = false;
      cta.textContent = 'Connect';
      const text =
        e instanceof VaultError && e.code === 'exists'
          ? 'This device already has an Ethereum wallet. Remove it in Settings → Ethereum wallet first; nothing was changed.'
          : `The Ethereum wallet could not be set up: ${e.message} Nothing was saved; try again.`;
      put(msg, notice('error', text));
    } finally {
      if (key) wipe(key.sk);
    }
  }

  const cta = setup ? primary('Connect', connect, { 'data-testid': 'eth-connect' }) : primary('Done', () => app.go('ethSettings'), { 'data-testid': 'eth-privacy-done' });
  const step = setup ? (app.ethSetup.mode === 'create' ? 'Step 3 of 3' : 'Step 2 of 2') : null;
  const el = screen(
    { title: 'Ethereum privacy', back: () => app.go(setup ? (app.ethSetup.mode === 'create' ? 'ethConfirm' : 'ethImport') : 'ethSettings'), actions: [cta, toggle] },
    step ? h('p', { class: 'step', text: step }) : null,
    h('div', { class: 'status-icon wait' }, icon('globe')),
    h('p', { class: 'lead', 'data-testid': 'eth-privacy-text', text: ethPrivacyLead(app) }),
    notice('warn', h('strong', { text: 'Everything on Ethereum is public: ' }), 'your address, your balance and every payment, for good. Your BEAM wallet stays private.'),
    h(
      'details',
      { class: 'more card flat', 'data-testid': 'eth-privacy-more' },
      h('summary', { text: 'What else is shared' }),
      h(
        'ul',
        { class: 'steps-list small' },
        h('li', { text: "Past payments come from Stack Wallet's history index, which is asked about your address. You can turn it off in Settings → Ethereum wallet." }),
        h('li', { text: "Moving coins between BEAM and Ethereum is public on both chains: your Ethereum address and the amount are written into BEAM's bridge, and moves from Ethereum carry the same bridge key every time, so they can be linked." }),
        h('li', { text: 'Moving coins to Ethereum asks CoinGecko for prices, and CoinGecko sees your IP. You are asked first. Swaps on Uniswap contact no Uniswap server, only your Ethereum server.' }),
      ),
    ),
    h('p', { class: 'small', text: 'To hide your IP address, turn on iCloud Private Relay or use a VPN, as for BEAM.' }),
    details,
    msg,
  );
  return { el };
}
