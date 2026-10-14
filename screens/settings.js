/* Settings
 * Spec: ONE job: adjust how this wallet connects and stays locked.
 *       Primary CTA: none (a list); the most used item, "Lock now", is first in its group.
 *       Taps from app open: 1 (tab), 2 for any item.
 * Exit-intent reasons and answers:
 *   - "Which node should I pick?" -> none: random BEAM nodes by default, and the app moves to another
 *     by itself; "BEAM node" says which is in use and offers your own node.
 *   - "Who can see my IP?" -> IP privacy row, same words as before the first connection.
 *   - "How do I remove it?" -> Delete is here, with what it means before anything happens.
 *   - "What is my backup?" -> Backup row: the 12 words, or for an imported wallet its wallet.db
 *     file and password (it has no words here, and nothing offers to rebuild it from words).
 *   - "What if this app's address dies?" -> Check for updates also asks public copies of the
 *     release, and "Update from another address" takes any copy; both say the app keeps working.
 *   - "Why are there no dollar values?" / "Where is the token I hid?" -> Tokens and prices: the CoinGecko
 *     switch (it sees the IP address), the currency, and Hidden tokens.
 *   - "Where are the people I pay / my addresses / a proof someone sent?" -> the Payments group.
 *   - "Can several payments go at once? Will I hear when money arrives?" -> Coins (Split coins) and Payment
 *     notifications, in the Payments group; under it, that notices come only while the app is open.
 *   - "Can it look like BEAM?" -> Appearance: Theme (light or dark) and Colours (Campfire red, the
 *     default, or BEAM's own colours; issue #80). BEAM comes dark unless Light was picked on purpose.
 *   - "It is not in my language" / "I want it in English" -> Appearance: Language, like this device by
 *     default (never asked), or English, Русский, 简体中文, 日本語, each named in its own script.
 *   - "My balance is wrong / coins are missing" -> Rescan, for every wallet (restored, new or
 *     imported): it rebuilds the coins from BEAM's snapshot and keeps history and addresses.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, toast } from '../lib/ui.js';
import { isOwnNode } from '../lib/own_node.js';
import { isPoolNode, nodeName } from '../lib/nodes.js';
import { hasPasskey, removePasskey, isImported } from '../lib/session.js';
import { passkeyAvailable } from '../lib/passkey.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { lastCheckText } from '../lib/update.js';
import { runUpdateCheck, openOtherAddress } from '../lib/update_ui.js';
import { tokenSettings } from './token_ui.js';
import { listWallets, nameOf } from '../lib/wallets.js';
import { notificationsRow } from './notifications.js';
import { THEMES, THEME_WORDS, SKINS, SKIN_WORDS, readTheme, setTheme, readSkin, pickSkin } from '../lib/theme.js';
import { t, LANGUAGES, LANGUAGE_NAMES, readLanguageChoice, setLanguage, deviceLanguage, navigatorLanguages } from '../lib/i18n.js';

export default function settings(app) {
  const row = (ico, title, sub, onclick, extra = {}) =>
    h('button', { class: 'row', onclick, ...extra }, h('span', { class: 'ico' }, icon(ico)), h('span', { class: 'main' }, h('div', { class: 't', text: title }), sub ? h('div', { class: 's', text: sub }) : null), h('span', { class: 'chev' }, icon('chevron')));

  const lockSel = h('select', { class: 'inline', 'aria-label': t('Auto-lock'), 'data-testid': 'autolock-select' }, ...[1, 5, 15].map((m) => h('option', { value: String(m), text: t('{min} min', { min: m }) })));
  lockSel.value = String(app.prefs.autoLockMin);
  lockSel.addEventListener('change', async () => {
    await app.setPrefs({ autoLockMin: Number(lockSel.value) });
    toast(t('Locks after {min} min without use', { min: lockSel.value }));
  });

  // Light or dark: like this device, or always one (lib/theme.js). It changes at once.
  const themeSel = h('select', { class: 'inline', 'aria-label': t('Theme'), 'data-testid': 'theme-select' }, ...THEMES.map((k) => h('option', { value: k, text: t(THEME_WORDS[k]) })));
  themeSel.value = readTheme();
  themeSel.addEventListener('change', () => setTheme(themeSel.value));
  // Campfire red (the default) or BEAM's colours (issue #80). It changes at once; the logo stays.
  // BEAM comes dark unless a theme was picked on purpose (lib/theme.js pickSkin): the Theme row follows.
  const skinSel = h('select', { class: 'inline', 'aria-label': t('Colours'), 'data-testid': 'skin-select' }, ...SKINS.map((k) => h('option', { value: k, text: t(SKIN_WORDS[k]) })));
  skinSel.value = readSkin();
  skinSel.addEventListener('change', () => {
    themeSel.value = pickSkin(skinSel.value).theme;
  });
  // The language: like this device (the default, never asked on the first open), or one of them, each
  // named in its own script so a person who cannot read the current one still finds theirs. It changes
  // at once: lib/i18n.js reads that catalog and app.js draws this screen again. The 12 words stay
  // English whatever is chosen (BEAM's word list is English only).
  // The closed select shows only the start of its choice on a phone, so "Like this device" stays
  // short (as Theme's) and the row's second line names the device's language while it is followed.
  const device = deviceLanguage(navigatorLanguages());
  const langChoice = readLanguageChoice();
  const langSel = h(
    'select',
    { class: 'inline', 'aria-label': t('Language'), 'data-testid': 'lang-select' },
    h('option', { value: 'system', text: t('Like this device') }),
    ...LANGUAGES.map((l) => h('option', { value: l, lang: l, text: LANGUAGE_NAMES[l] })),
  );
  langSel.value = langChoice;
  const langSub = langChoice === 'system' ? h('div', { class: 's', lang: device, 'data-testid': 'lang-device', text: LANGUAGE_NAMES[device] }) : null;
  // Not disabled while the catalog is read: a disabled select loses the focus, and app.js puts the
  // redrawn screen back where it was by the focused control.
  langSel.addEventListener('change', () => {
    setLanguage(langSel.value);
  });

  const faceRowBox = h('div');
  (async () => {
    const on = hasPasskey(app);
    const avail = on || (await passkeyAvailable());
    put(faceRowBox, 
      on
        ? row('face', 'Face ID / Touch ID', t('On. Tap to turn off.'), async () => {
            if (!(await confirmIdentity(app, { title: t('Turn off Face ID?'), cta: t('Turn off') }))) return;
            await removePasskey(app);
            toast(t('Face ID is off. Use your password to unlock.'));
            app.go('settings');
          }, { 'data-testid': 'passkey-row' })
        : avail
          ? row('face', 'Face ID / Touch ID', t('Off. Tap to turn on.'), () => app.go('passkeySetup'), { 'data-testid': 'passkey-row' })
          : row('face', 'Face ID / Touch ID', t('Not available in this browser.'), () => toast(t('This browser cannot keep a key behind Face ID. Use your password.'))),
    );
  })();

  // The only way this app contacts an update source (its web address, then copies of the
  // release, then an address added below): when this row is tapped.
  const updRow = row('download', t('Check for updates'), lastCheckText(app.updates.lastCheck), () => runUpdateCheck(app, { onDone: setUpdSub }), { 'data-testid': 'check-updates' });
  const otherSub = () => {
    const added = app.updates.addedSource();
    return added ? t('Also asks {host}', { host: new URL(added).host }) : t("If this app's address is gone");
  };
  const otherRow = row('globe', t('Update from another address'), otherSub(), () => openOtherAddress(app, { onDone: setUpdSub }), { 'data-testid': 'update-other-row' });
  function setUpdSub() {
    const sub = updRow.querySelector('.s');
    if (sub) sub.textContent = lastCheckText(app.updates.lastCheck);
    const sub2 = otherRow.querySelector('.s');
    if (sub2) sub2.textContent = otherSub();
  }
  const offU = app.updates.onChange(setUpdSub);

  // Several wallets (screens/wallets.js): which one is open, and the way to the others.
  const walletsRow = row('wallet', t('Wallets'), t('{name} is open', { name: nameOf(app.record) }), () => app.go('wallets'), { 'data-testid': 'wallets-row' });
  listWallets().then((l) => {
    const sub = walletsRow.querySelector('.s');
    if (sub && l.length > 1) sub.textContent = t('{name} is open · {count} on this device', { name: nameOf(app.record), count: l.length });
    else if (sub) sub.textContent = t('{name} is open · add another', { name: nameOf(app.record) });
  }, () => {});

  const el = screen(
    { title: t('Settings'), tabs: 'settings', app, cls: 'settings' },
    h('div', { class: 'card list' }, walletsRow),
    h('p', { class: 'section-title', text: t('Security') }),
    h(
      'div',
      { class: 'card list' },
      row('lock', t('Lock now'), null, () => app.lock('manual'), { 'data-testid': 'lock-now' }),
      h('div', { class: 'row' }, h('span', { class: 'ico' }, icon('clock')), h('span', { class: 'main' }, h('div', { class: 't', text: t('Auto-lock') }), h('div', { class: 's', text: t('Also in the background') })), lockSel),
      faceRowBox,
      row('key', t('Change password'), null, () => app.go('changePassword'), { 'data-testid': 'change-password' }),
      row('file', t('Backup'), isImported(app) ? t('The wallet.db file and its password') : t('Your 12 words'), () => app.go('backup'), { 'data-testid': 'backup-row' }),
    ),
    h('p', { class: 'section-title', text: t('Payments') }),
    h(
      'div',
      { class: 'card list' },
      row('person', t('Contacts'), t('People you pay, with their address'), () => app.go('contacts'), { 'data-testid': 'contacts-row' }),
      row('receive', t('Your addresses'), t('Labels, and which one Receive shows'), () => app.go('addresses'), { 'data-testid': 'addresses-row' }),
      row('proof', t('Check a payment proof'), t('Someone says they paid you'), () => app.go('checkProof'), { 'data-testid': 'check-proof-row' }),
      row('coins', t('Coins'), t('For several payments at once'), () => app.go('coins'), { 'data-testid': 'coins-row' }),
      notificationsRow(app),
    ),
    h('p', { class: 'section-title', text: t('Network') }),
    h(
      'div',
      { class: 'card list' },
      row('globe', t('BEAM node'), isOwnNode(app.prefs.node) ? t('Your own node: {node}', { node: app.prefs.node }) : isPoolNode(app.prefs.poolNode) ? t("BEAM's public nodes, {node} first", { node: nodeName(app.prefs.poolNode) }) : t("BEAM's public nodes"), () => app.go('nodeSettings'), { 'data-testid': 'node-row' }),
      row('shield', t('IP privacy'), t('Who can see your IP address'), () => app.go('ipNotice'), { 'data-testid': 'ip-privacy' }),
      row('eth', t('Ethereum wallet'), t('Server, privacy, backup'), () => app.go('ethSettings'), { 'data-testid': 'eth-settings-row' }),
    ),
    // Values in the person's currency (CoinGecko, only once allowed) and the tokens hidden from Wallet.
    tokenSettings(app),
    h('p', { class: 'section-title', text: t('Appearance') }),
    h(
      'div',
      { class: 'card list' },
      h('div', { class: 'row', 'data-testid': 'theme-row' }, h('span', { class: 'ico' }, icon('moon')), h('span', { class: 'main' }, h('div', { class: 't', text: t('Theme') }), h('div', { class: 's', text: t('Light or dark') })), themeSel),
      h('div', { class: 'row', 'data-testid': 'skin-row' }, h('span', { class: 'ico' }, icon('palette')), h('span', { class: 'main' }, h('div', { class: 't', text: t('Colours') }), h('div', { class: 's', text: t('Campfire or BEAM') })), skinSel),
      h('div', { class: 'row', 'data-testid': 'lang-row' }, h('span', { class: 'ico' }, icon('language')), h('span', { class: 'main' }, h('div', { class: 't', text: t('Language') }), langSub), langSel),
    ),
    h('p', { class: 'section-title', text: t('App') }),
    h(
      'div',
      { class: 'card list' },
      // Rescan keeps wallet.db and rebuilds only its coins (engine patch 0107), so it suits every
      // wallet, an imported one too: nothing is made from words.
      row('refresh', t('Rescan'), t('If your balance looks wrong'), () => app.go('fastStart', { rescan: true }), { 'data-testid': 'rescan-row' }),
      updRow,
      otherRow,
      row('info', t('About'), null, () => app.go('about'), { 'data-testid': 'about' }),
      row('trash', t('Delete wallet from this device'), null, () => app.go('deleteWallet'), { 'data-testid': 'delete-wallet' }),
    ),
  );
  return { el, destroy: offU };
}
