/* Settings
 * Spec: ONE job: adjust how this wallet connects and stays locked.
 *       Primary CTA: none (a list); the most used item, "Lock now", is first in its group.
 *       Taps from app open: 1 (tab), 2 for any item.
 * Exit-intent reasons and answers:
 *   - "Which node should I pick?" -> the default is preselected and works; others say what they are.
 *   - "Who can see my IP?" -> IP privacy row, same words as before the first connection.
 *   - "How do I remove it?" -> Delete is here, with what it means before anything happens.
 *   - "What is my backup?" -> Backup row: the 12 words, or for an imported wallet its wallet.db
 *     file and password (it has no words here, and nothing offers to rebuild it from words).
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, toast, notice, openSheet } from '../lib/ui.js';
import { NODES } from '../lib/nodes.js';
import { hasPasskey, removePasskey, scanEnabled, isImported } from '../lib/session.js';
import { passkeyAvailable } from '../lib/passkey.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { wallet } from '../lib/wallet.js';

export default function settings(app) {
  const row = (ico, title, sub, onclick, extra = {}) =>
    h('button', { class: 'row', onclick, ...extra }, h('span', { class: 'ico' }, icon(ico)), h('span', { class: 'main' }, h('div', { class: 't', text: title }), sub ? h('div', { class: 's', text: sub }) : null), h('span', { class: 'chev' }, icon('chevron')));

  const nodeSel = h('select', { class: 'inline', 'aria-label': 'BEAM node', 'data-testid': 'node-select' }, ...NODES.map((n) => h('option', { value: n.address, text: n.label })));
  nodeSel.value = app.prefs.node;
  nodeSel.addEventListener('change', async () => {
    const node = nodeSel.value;
    await app.setPrefs({ node });
    toast('Switching node…');
    try {
      await wallet.stop();
      await wallet.start({ dbPass: app.dbPass, node, bodyRequests: scanEnabled(app) });
      toast(`Connected through ${NODES.find((n) => n.address === node).label}`);
    } catch (e) {
      toast(`Couldn't switch: ${e.message}`);
    }
  });

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

  const updRow = row('download', 'Check for updates', 'Updates are signed and only install when you tap Update.', checkUpdates, { 'data-testid': 'check-updates' });
  async function checkUpdates() {
    toast('Checking for a signed update…');
    try {
      const r = await app.updates.check();
      if (r.result === 'ready') {
        openSheet((close) => [
          h('h2', { text: `Update to ${r.version}` }),
          h('p', { class: 'lead', text: 'This version was downloaded and checked against the BEAM Campfire release signature. Your wallet and settings stay as they are.' }),
          h('button', { class: 'btn btn-primary', onclick: () => app.updates.apply(), 'data-testid': 'update-apply-sheet' }, `Update to ${r.version}`),
          h('button', { class: 'btn btn-text', onclick: () => close() }, 'Later'),
        ]);
      } else if (r.result === 'refused') {
        openSheet((close) => [h('h2', { text: 'Update refused' }), notice('error', `${r.reason} You are still on the version you had, which is unchanged.`), h('button', { class: 'btn btn-primary', onclick: () => close() }, 'OK')]);
      } else if (r.result === 'unreachable') toast("Couldn't reach the update server. Try again later.");
      else toast('You have the latest version.');
    } catch (e) {
      toast(e.message);
    }
  }

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
      h('div', { class: 'row' }, h('span', { class: 'ico' }, icon('globe')), h('span', { class: 'main' }, h('div', { class: 't', text: 'BEAM node' }), h('div', { class: 's', text: 'Run by BEAM. Europe is the default.' })), nodeSel),
      row('shield', 'IP privacy', 'Who can see your IP address', () => app.go('ipNotice'), { 'data-testid': 'ip-privacy' }),
    ),
    h('p', { class: 'section-title', text: 'App' }),
    h(
      'div',
      { class: 'card list' },
      // Imported wallets have no words and nothing here rebuilds or rescans them (as in the desktop app).
      scanEnabled(app) || isImported(app) ? null : row('download', 'Find coins from other wallets', 'If these 12 words were used in another app (one-time 330 MB scan)', () => app.go('fastStart', { rescan: true }), { 'data-testid': 'find-coins' }),
      updRow,
      row('info', 'About', null, () => app.go('about'), { 'data-testid': 'about' }),
      row('trash', 'Delete wallet from this device', null, () => app.go('deleteWallet'), { 'data-testid': 'delete-wallet' }),
    ),
  );
  return { el };
}
