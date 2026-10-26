/* Welcome
 * Spec: ONE job: start a wallet on this device - a new one, one from its 12 words, or one from
 *       its wallet.db file.
 *       Primary CTA: "Create a new wallet" (secondary: "Restore with 12 words",
 *       "Import a wallet.db file").
 *       Taps from app open: 0 (first screen for a new device); each choice is 1 tap.
 * Exit-intent reasons and answers:
 *   - "Is this a scam / who holds my money?" -> the line under the buttons: no account, your keys
 *     stay on this device.
 *   - "Three buttons, which one is me?" -> the new wallet is the obvious (primary) one; the other two
 *     are named after what you bring: your 12 words, or your wallet.db file.
 *   - "I have a wallet.db but no words" -> its own button.
 *   - "Will I lose it if Safari clears data?" -> the Home Screen card says when Safari deletes it, and
 *     "Show me how" gives the steps (screens/home_screen_guide.js).
 *   - "What does it cost?" -> nothing to install or sign up; network fees are shown before paying.
 *   - "Which version is this copy?" (another address, a mirror) -> "Version 0.2.x" in small print at
 *     the bottom, before any wallet is made (issue #82).
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, versionLine } from '../lib/ui.js';
import { t } from '../lib/i18n.js';
import { languagePicker } from '../lib/lang_ui.js';
import { HOME_SCREEN_TEXT, openHomeScreenGuide } from './home_screen_guide.js';
import { logoMark } from '../lib/logo.js';

export function isIosSafariTab() {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches; // i18n-ignore: a CSS media query
  return ios && !standalone;
}

export default function welcome(app) {
  const restore = () => {
    app.setup = { mode: 'restore' };
    app.go('restore');
  };
  const importDb = () => {
    app.setup = null;
    app.go('importWallet');
  };
  const guide = isIosSafariTab() && !app.prefs.a2hsDismissed ? a2hsGuide(app) : null;
  const el = screen(
    {
      topbar: false,
      cls: 'welcome',
      actions: [
        primary(t('Create a new wallet'), () => {
          app.setup = { mode: 'create' };
          app.go('backup');
        }, { 'data-testid': 'create' }),
        secondary(t('Restore with 12 words'), restore, { 'data-testid': 'restore' }),
        secondary(t('Import a wallet.db file'), importDb, { 'data-testid': 'import' }),
        h('p', { class: 'small center', text: t('No sign-up. Your keys stay on this device.') }),
      ],
    },
    // The language, named in itself, for a person whose device language is not the one they want.
    h('div', { class: 'lang-bar' }, languagePicker()),
    h(
      'div',
      // Compact when the Home Screen guide must fit above the fold too (375x667 without scrolling).
      { class: `hero${guide ? ' compact' : ''}` },
      logoMark(),
      h('h1', { text: 'Beam PWA' }), // i18n-ignore: the brand
      h('p', { text: t('Your privacy. Your wallet. Your BEAM.') }),
    ),
    guide,
  );
  const version = versionLine();
  if (version) el.appendChild(version);
  return { el };
}

function a2hsGuide(app) {
  const card = h(
    'div',
    { class: 'card a2hs', 'data-testid': 'a2hs' },
    h(
      'div',
      { class: 'banner' },
      h('h3', { class: 'grow', text: t('First, add Beam PWA to your Home Screen') }),
      h('button', {
        class: 'icon-btn',
        'aria-label': t('Hide this tip'),
        onclick: async () => {
          await app.setPrefs({ a2hsDismissed: true });
          card.remove();
        },
      }, icon('close')),
    ),
    h('p', { text: `${t(HOME_SCREEN_TEXT.why)} ${t(HOME_SCREEN_TEXT.notMoved)}` }),
    h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'a2hs-how', onclick: () => openHomeScreenGuide('start') }, t(HOME_SCREEN_TEXT.showMe)),
  );
  return card;
}
