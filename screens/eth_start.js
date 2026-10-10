/* Ethereum wallet: start (Home's switcher -> Ethereum, or Settings -> Ethereum wallet, when there is none)
 * Spec: ONE job: start an Ethereum wallet next to the BEAM one - a new one, or one from its words.
 *       Primary CTA: "Create an Ethereum wallet" (secondary: "Import Ethereum words").
 *       Taps from app open: 1 (Home -> Ethereum); each choice is 1 more.
 * Exit-intent reasons and answers:
 *   - "Why another set of words?" -> said first: the Ethereum wallet has its own words, as in the
 *     desktop app; the BEAM words do not open it.
 *   - "Is this a scam?" -> no account, no sign-up; the key stays on this device, locked with this
 *     wallet's password.
 *   - "Ethereum isn't private" -> said before anything connects (step 3 is the privacy screen).
 *   - "I already have Ethereum words" -> its own button, 12 or 24 words.
 */
import { h } from '../lib/dom.js';
import { screen, primary, secondary } from '../lib/ui.js';
import { chainSwitch } from './eth_screens.js';

export default function ethStart(app, params = {}) {
  const fromSettings = params.from === 'settings';
  const back = () => app.go(fromSettings ? 'settings' : 'home');
  const el = screen(
    {
      title: fromSettings ? 'Ethereum wallet' : null,
      brand: !fromSettings,
      back: fromSettings ? back : null,
      tabs: fromSettings ? null : 'home',
      app,
      actions: [
        primary('Create an Ethereum wallet', () => {
          app.ethSetup = { mode: 'create', from: params.from || 'home' };
          app.go('ethWords');
        }, { 'data-testid': 'eth-create' }),
        secondary('Import Ethereum words', () => {
          app.ethSetup = { mode: 'import', from: params.from || 'home' };
          app.go('ethImport');
        }, { 'data-testid': 'eth-import' }),
        h('p', { class: 'small center', text: 'No sign-up. The key stays on this device, locked with your BEAM Campfire password.' }),
      ],
    },
    fromSettings ? null : chainSwitch(app, 'eth'),
    h(
      'div',
      { class: 'hero eth-hero' },
      h('img', { src: 'img/eth.svg', alt: '' }),
      h('h1', { text: 'Add an Ethereum wallet' }),
      h('p', { text: 'Hold ETH, WBEAM and other Ethereum tokens next to your BEAM.' }),
    ),
    h('div', { class: 'card flat' }, h('p', { class: 'small', text: 'It has its own recovery words, separate from your BEAM words, as in BEAM Campfire on desktop. Your BEAM wallet is not changed.' })),
  );
  return { el };
}
