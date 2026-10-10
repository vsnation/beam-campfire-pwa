/* Ethereum wallet: start (Home's switcher -> Ethereum, or Settings -> Ethereum wallet, Move coins or Buy, when there is none)
 * Spec: ONE job: start an Ethereum wallet next to the BEAM one - a new one, or one from its words or key.
 *       Primary CTA: "Create an Ethereum wallet" (secondary: "Import words or private key").
 *       Taps from app open: 1 (Home -> Ethereum); each choice is 1 more.
 * Exit-intent reasons and answers:
 *   - "Why another set of words?" -> said first: the Ethereum wallet has its own words, as in the
 *     desktop app; the BEAM words do not open it.
 *   - "Is this a scam?" -> no account, no sign-up; the key stays on this device, locked with this
 *     wallet's password.
 *   - "Ethereum isn't private" -> said before anything connects (step 3 is the privacy screen).
 *   - "I already have an Ethereum wallet" -> its own button: its words (12 to 24) or its private key.
 */
import { h } from '../lib/dom.js';
import { screen, primary, secondary } from '../lib/ui.js';
import { chainSwitch } from './eth_screens.js';

// Opened for a task, it is a step of that task with a Back to it; otherwise it is the Ethereum side itself.
const OPENED_FROM = { settings: 'settings', bridge: 'bridgeMove', buy: 'home' };

export default function ethStart(app, params = {}) {
  const step = Object.hasOwn(OPENED_FROM, params.from);
  const back = () => app.back(OPENED_FROM[params.from]);
  const el = screen(
    {
      title: step ? 'Ethereum wallet' : null,
      brand: !step,
      back: step ? back : null,
      tabs: step ? null : 'home',
      app,
      actions: [
        primary('Create an Ethereum wallet', () => {
          app.ethSetup = { mode: 'create', from: params.from || 'home' };
          app.go('ethWords');
        }, { 'data-testid': 'eth-create' }),
        secondary('Import words or private key', () => {
          app.ethSetup = { mode: 'import', from: params.from || 'home' };
          app.go('ethImport');
        }, { 'data-testid': 'eth-import' }),
        h('p', { class: 'small center', text: 'No sign-up. The key stays on this device, locked with your BEAM Campfire password.' }),
      ],
    },
    step ? null : chainSwitch(app, 'eth'),
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
