/* Ethereum privacy (last setup step, before the Ethereum wallet's first connection; also Settings -> Ethereum)
 * Spec: ONE job: say, before anything connects, what Ethereum and its server can see.
 *       Primary CTA: "Connect" (secondary: "How to hide my IP"). From Settings: "Done".
 *       Taps from app open: 6 + 3 word taps when creating (Ethereum, Create, I wrote them down,
 *       3 words, Confirm words, Connect), 4 + paste when importing words or a private key.
 * Exit-intent reasons and answers:
 *   - "A privacy wallet on a public chain?" -> said first and plainly: everything on Ethereum is public;
 *     the BEAM wallet stays private.
 *   - "Who sees my IP?" -> the one Ethereum server picked (Stack Wallet's by default), and how to hide it.
 *   - "Is there a fallback that leaks to more servers?" -> no: one server, picked by you, is asked
 *     about your address. (A swap's price alone is asked again of a second listed server, said here.)
 *   - "Can I see my history without telling Stack Wallet?" -> the history switch, named here.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice } from '../lib/ui.js';
import { ethKeyFromMnemonic, wipe } from '../lib/eth/crypto.js';
import { saveEthKey, VaultError } from '../lib/eth/vault.js';
import { ethPrefs } from '../lib/eth/wallet.js';
import { t, tNodes } from '../lib/i18n.js';

export function ethPrivacyLead(app) {
  const { host } = ethPrefs(app);
  return host.id === 'stackwallet'
    ? t("The Ethereum server this wallet uses ({server}'s, unless you pick another in Settings) sees your IP address together with your Ethereum address each time the app checks a balance or sends. It can link the two and see when you are online.", { server: host.name })
    : t("The Ethereum server this wallet uses ({server}'s) sees your IP address together with your Ethereum address each time the app checks a balance or sends. It can link the two and see when you are online.", { server: host.name });
}

export default function ethPrivacy(app, params = {}) {
  const setup = Boolean(params.setup) && app.ethSetup && (Array.isArray(app.ethSetup.words) || app.ethSetup.sk instanceof Uint8Array);
  const msg = h('div', { 'aria-live': 'polite' });
  const details = h(
    'div',
    { class: 'card hidden', 'data-testid': 'eth-ip-details' },
    h('h3', { text: t('How to hide your IP address') }),
    h(
      'ol',
      { class: 'steps-list' },
      h('li', { text: t('iCloud Private Relay (needs iCloud+): Settings → [your name] → iCloud → Private Relay → On. Apple documents it for browsing in Safari; for apps added to the Home Screen it does not say, so do not rely on it alone.') }),
      h('li', { text: t('A VPN you trust covers every app on the phone, including BEAM Campfire. Turn it on before you open the wallet.') }),
    ),
  );
  const toggle = secondary(t('How to hide my IP'), () => {
    details.classList.toggle('hidden');
    toggle.textContent = details.classList.contains('hidden') ? t('How to hide my IP') : t('Hide details');
  }, { 'data-testid': 'eth-ip-how' });

  async function connect() {
    cta.disabled = true;
    cta.textContent = t('Setting up…');
    put(msg);
    const s = app.ethSetup;
    let key = null;
    try {
      if (s.kind === 'key') {
        await saveEthKey(app, { sk: s.sk, address: s.address, kind: 'key' });
        wipe(s.sk);
      } else {
        key = await ethKeyFromMnemonic(s.words.join(' '), s.mode === 'import' ? s.passphrase || '' : '');
        await saveEthKey(app, { sk: key.sk, address: key.address, words: s.words.length, passphrase: Boolean(s.passphrase) });
        s.words.fill('');
      }
      app.ethSetup = null;
      // Started from Move coins: back there, the bridge now has both wallets. The setup steps are behind it.
      app.go(s.from === 'bridge' ? 'bridgeMove' : 'ethHome', { created: s.mode }, { replace: true });
    } catch (e) {
      cta.disabled = false;
      cta.textContent = t('Connect');
      const text =
        e instanceof VaultError && e.code === 'exists'
          ? t('This device already has an Ethereum wallet. Remove it in Settings → Ethereum wallet first; nothing was changed.')
          : t('The Ethereum wallet could not be set up: {reason} Nothing was saved; try again.', { reason: e.message });
      put(msg, notice('error', text));
    } finally {
      if (key) wipe(key.sk);
    }
  }

  const cta = setup ? primary(t('Connect'), connect, { 'data-testid': 'eth-connect' }) : primary(t('Done'), () => app.back('ethSettings'), { 'data-testid': 'eth-privacy-done' });
  const step = setup ? (app.ethSetup.mode === 'create' ? t('Step 3 of 3') : t('Step 2 of 2')) : null;
  const el = screen(
    { title: t('Ethereum privacy'), back: () => (setup ? app.go(app.ethSetup.mode === 'create' ? 'ethConfirm' : 'ethImport') : app.back('ethSettings')), actions: [cta, toggle] },
    step ? h('p', { class: 'step', text: step }) : null,
    h('div', { class: 'status-icon wait' }, icon('globe')),
    h('p', { class: 'lead', 'data-testid': 'eth-privacy-text', text: ethPrivacyLead(app) }),
    notice('warn', ...tNodes('{lead} your address, your balance and every payment, for good. Your BEAM wallet stays private.', { lead: h('strong', { text: t('Everything on Ethereum is public:') }) })),
    h(
      'details',
      { class: 'more card flat', 'data-testid': 'eth-privacy-more' },
      h('summary', { text: t('What else is shared') }),
      h(
        'ul',
        { class: 'steps-list small' },
        h('li', { text: t("Past payments come from Stack Wallet's history index, which is asked about your address. You can turn it off in Settings → Ethereum wallet.") }),
        h('li', { text: t("Moving coins between BEAM and Ethereum is public on both chains: your Ethereum address and the amount are written into BEAM's bridge, and moves from Ethereum carry the same bridge key every time, so they can be linked.") }),
        h('li', { text: t("Moving coins to Ethereum asks CoinGecko for prices, and CoinGecko sees your IP. You are asked first. Swaps on Uniswap contact no Uniswap server. Before a swap, its price is checked with a second server from the list, which sees your IP address and the swap's amount, never your address.") }),
      ),
    ),
    h('p', { class: 'small', text: t('To hide your IP address, turn on iCloud Private Relay or use a VPN, as for BEAM.') }),
    details,
    msg,
  );
  return { el };
}
