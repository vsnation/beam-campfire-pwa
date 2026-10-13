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
 *   - "Will I lose it if Safari clears data?" -> the Home Screen guide says when that happens.
 *   - "What does it cost?" -> nothing to install or sign up; network fees are shown before paying.
 *   - "Which version is this copy?" (another address, a mirror) -> "Version 0.2.x" in small print at
 *     the bottom, before any wallet is made (issue #82).
 * On an address other websites share (<user>.github.io, .gitlab.io, .codeberg.page;
 * lib/shared_origin.js) the ONE job is to get the wallet to a safe place: primary CTA "Go to
 * pwa.buybeam.my" (1 tap). No Create there. "Restore with 12 words here" and "Import a wallet.db file
 * here" stay, for when pwa.buybeam.my is gone, each behind a warning sheet (2 taps).
 * Exit-intent: "Am I on the wrong site / is this a fake?" -> it says plainly why not here and where,
 * without blame; "pwa.buybeam.my is gone or looks wrong" -> desktop and Android are named, and the
 * line under the button says not to type the words there if it looks unexpected.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, openSheet, versionLine } from '../lib/ui.js';
import { onSharedOrigin, HOME_URL, SHARED_TEXT } from '../lib/shared_origin.js';

/**
 * In place of Create / Restore / Import on an address other websites share: why not here, the way
 * to BEAM Campfire's own address, and Restore / Import here behind a warning (audit UPD-2).
 * restore() and importDb() run only once the person confirmed it. A wallet already kept here still
 * opens (unlock never comes this way).
 */
export function sharedOriginParts(app, { restore, importDb, testid = '' }) {
  const here = typeof location !== 'undefined' ? location.hostname : '';
  app.sharedOriginOk = false; // a warning confirmed earlier covered that attempt only
  const warned = (kind, then) => () =>
    openSheet(
      (close) => [
        h('h2', { 'data-testid': 'shared-warn-title', text: SHARED_TEXT.warnTitle[kind] }),
        notice('warn', SHARED_TEXT.warn(here, kind)),
        h('p', { class: 'lead', text: SHARED_TEXT.warnWhen }),
        h(
          'div',
          { class: 'sheet-actions' },
          h('button', {
            class: 'btn btn-danger',
            'data-testid': 'shared-warn-confirm',
            onclick: () => {
              app.sharedOriginOk = true;
              close();
              then();
            },
          }, SHARED_TEXT.confirm[kind]),
          h('button', { class: 'btn btn-text', 'data-testid': 'shared-warn-cancel', onclick: () => close() }, SHARED_TEXT.cancel),
        ),
      ],
      { label: SHARED_TEXT.warnTitle[kind] },
    );
  return {
    body: h('div', { 'data-testid': 'shared-origin' }, notice('info', SHARED_TEXT.why(here))),
    actions: [
      h('a', { class: 'btn btn-primary', href: HOME_URL, rel: 'noopener noreferrer', 'data-testid': 'shared-origin-go' }, SHARED_TEXT.go),
      h('p', { class: 'small center', 'data-testid': 'shared-origin-unexpected', text: SHARED_TEXT.unexpected }),
      secondary(SHARED_TEXT.restoreHere, warned('restore', restore), { 'data-testid': `${testid}restore` }),
      secondary(SHARED_TEXT.importHere, warned('import', importDb), { 'data-testid': `${testid}import` }),
      h('p', { class: 'small center', 'data-testid': 'shared-origin-elsewhere', text: SHARED_TEXT.elsewhere }),
    ],
  };
}

export function isIosSafariTab() {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
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
  const shared = onSharedOrigin() ? sharedOriginParts(app, { restore, importDb }) : null;
  const guide = !shared && isIosSafariTab() && !app.prefs.a2hsDismissed ? a2hsGuide(app) : null;
  const el = screen(
    {
      topbar: false,
      cls: 'welcome',
      actions: shared ? shared.actions : [
        primary('Create a new wallet', () => {
          app.setup = { mode: 'create' };
          app.go('backup');
        }, { 'data-testid': 'create' }),
        secondary('Restore with 12 words', restore, { 'data-testid': 'restore' }),
        secondary('Import a wallet.db file', importDb, { 'data-testid': 'import' }),
        h('p', { class: 'small center', text: 'No sign-up. Your keys stay on this device.' }),
      ],
    },
    h(
      'div',
      // Compact when more must fit above the fold: the Home Screen guide, or the shared-address
      // notice with the desktop / Android line under the buttons (375x667 without scrolling).
      { class: `hero${guide || shared ? ' compact' : ''}` },
      h('img', { src: 'img/logo.svg', alt: '' }),
      h('h1', { text: 'BEAM Campfire' }),
      h('p', { text: 'Your privacy. Your wallet. Your BEAM.' }),
    ),
    shared ? shared.body : guide,
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
      h('h3', { class: 'grow', text: 'First, add BEAM Campfire to your Home Screen' }),
      h('button', {
        class: 'icon-btn',
        'aria-label': 'Hide this tip',
        onclick: async () => {
          await app.setPrefs({ a2hsDismissed: true });
          card.remove();
        },
      }, icon('close')),
    ),
    h('p', {}, 'Tap Share ', icon('share', 'inline-icon'), ' in Safari, choose "Add to Home Screen", then open BEAM Campfire from there.'),
    h('p', { class: 'small', text: 'Home Screen apps keep their data. Safari tabs may lose it after 7 days without use, and a wallet made in a Safari tab does not move to the Home Screen app.' }),
  );
  return card;
}
