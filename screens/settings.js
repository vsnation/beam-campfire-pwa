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
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, toast } from '../lib/ui.js';
import { isOwnNode } from '../lib/own_node.js';
import { hasPasskey, removePasskey, scanEnabled, isImported } from '../lib/session.js';
import { passkeyAvailable } from '../lib/passkey.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { lastCheckText } from '../lib/update.js';
import { runUpdateCheck, openOtherAddress } from '../lib/update_ui.js';

export default function settings(app) {
  const row = (ico, title, sub, onclick, extra = {}) =>
    h('button', { class: 'row', onclick, ...extra }, h('span', { class: 'ico' }, icon(ico)), h('span', { class: 'main' }, h('div', { class: 't', text: title }), sub ? h('div', { class: 's', text: sub }) : null), h('span', { class: 'chev' }, icon('chevron')));

  const lockSel = h('select', { class: 'inline', 'aria-label': 'Auto-lock', 'data-testid': 'autolock-select' }, ...[1, 5, 15].map((m) => h('option', { value: String(m), text: `${m} min` })));
  lockSel.value = String(app.prefs.autoLockMin);
  lockSel.addEventListener('change', async () => {
    await app.setPrefs({ autoLockMin: Number(lockSel.value) });
    toast(`Locks after ${lockSel.value} min without use`);
  });

  const faceRowBox = h('div');
  (async () => {
    const on = hasPasskey(app);
    const avail = on || (await passkeyAvailable());
    put(faceRowBox, 
      on
        ? row('face', 'Face ID / Touch ID', 'On. Tap to turn off.', async () => {
            if (!(await confirmIdentity(app, { title: 'Turn off Face ID?', cta: 'Turn off' }))) return;
            await removePasskey(app);
            toast('Face ID is off. Use your password to unlock.');
            app.go('settings');
          }, { 'data-testid': 'passkey-row' })
        : avail
          ? row('face', 'Face ID / Touch ID', 'Off. Tap to turn on.', () => app.go('passkeySetup'), { 'data-testid': 'passkey-row' })
          : row('face', 'Face ID / Touch ID', 'Not available in this browser.', () => toast('This browser cannot keep a key behind Face ID. Use your password.')),
    );
  })();

  // The only way this app contacts an update source (its web address, then copies of the
  // release, then an address added below): when this row is tapped.
  const updRow = row('download', 'Check for updates', lastCheckText(app.updates.lastCheck), () => runUpdateCheck(app, { onDone: setUpdSub }), { 'data-testid': 'check-updates' });
  const otherSub = () => {
    const added = app.updates.addedSource();
    return added ? `Also asks ${new URL(added).host}` : "If this app's address is gone";
  };
  const otherRow = row('globe', 'Update from another address', otherSub(), () => openOtherAddress(app, { onDone: setUpdSub }), { 'data-testid': 'update-other-row' });
  function setUpdSub() {
    const sub = updRow.querySelector('.s');
    if (sub) sub.textContent = lastCheckText(app.updates.lastCheck);
    const sub2 = otherRow.querySelector('.s');
    if (sub2) sub2.textContent = otherSub();
  }
  const offU = app.updates.onChange(setUpdSub);

  const el = screen(
    { title: 'Settings', tabs: 'settings', app, cls: 'settings' },
    h('p', { class: 'section-title', text: 'Security' }),
    h(
      'div',
      { class: 'card list' },
      row('lock', 'Lock now', null, () => app.lock('manual'), { 'data-testid': 'lock-now' }),
      h('div', { class: 'row' }, h('span', { class: 'ico' }, icon('clock')), h('span', { class: 'main' }, h('div', { class: 't', text: 'Auto-lock' }), h('div', { class: 's', text: 'Also in the background' })), lockSel),
      faceRowBox,
      row('key', 'Change password', null, () => app.go('changePassword'), { 'data-testid': 'change-password' }),
      row('file', 'Backup', isImported(app) ? 'The wallet.db file and its password' : 'Your 12 words', () => app.go('backup'), { 'data-testid': 'backup-row' }),
    ),
    h('p', { class: 'section-title', text: 'Network' }),
    h(
      'div',
      { class: 'card list' },
      row('globe', 'BEAM node', isOwnNode(app.prefs.node) ? `Your own node: ${app.prefs.node}` : 'Random BEAM nodes', () => app.go('nodeSettings'), { 'data-testid': 'node-row' }),
      row('shield', 'IP privacy', 'Who can see your IP address', () => app.go('ipNotice'), { 'data-testid': 'ip-privacy' }),
      row('eth', 'Ethereum wallet', 'Server, privacy, backup', () => app.go('ethSettings'), { 'data-testid': 'eth-settings-row' }),
    ),
    h('p', { class: 'section-title', text: 'App' }),
    h(
      'div',
      { class: 'card list' },
      // Imported wallets have no words and nothing here rebuilds or rescans them (as in the desktop app).
      scanEnabled(app) || isImported(app) ? null : row('download', 'Find coins from other wallets', 'If these 12 words were used in another app (one-time 330 MB scan)', () => app.go('fastStart', { rescan: true }), { 'data-testid': 'find-coins' }),
      updRow,
      otherRow,
      row('info', 'About', null, () => app.go('about'), { 'data-testid': 'about' }),
      row('trash', 'Delete wallet from this device', null, () => app.go('deleteWallet'), { 'data-testid': 'delete-wallet' }),
    ),
  );
  return { el, destroy: offU };
}
