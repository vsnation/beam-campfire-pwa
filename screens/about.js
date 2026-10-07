/* About
 * Spec: ONE job: show exactly what is running, so it can be checked.
 *       Primary CTA: none (information); "Check for updates" lives in Settings.
 *       Taps from app open: 2 (Settings -> About).
 * Exit-intent reasons and answers:
 *   - "Can I verify this build?" -> version, engine SHA-256s, consensus rules, release status.
 *   - "Who made this?" -> project and licences named, with the public repository.
 *   - "Will my wallet survive?" -> whether the browser keeps this app's storage, and when updates were
 *     last checked. Opening this screen contacts nothing: no web address, no explorer.
 */
import { h, put } from '../lib/dom.js';
import { screen, notice } from '../lib/ui.js';
import { APP_VERSION, BUILT, ENGINE_LOCK } from '../lib/version.js';
import { engineLog, nodeGuard } from '../lib/engine.js';
import { wallet } from '../lib/wallet.js';
import { lastCheckText } from '../lib/update.js';
import { refreshPersistence, persistenceText } from '../lib/storage.js';

export default function about(app) {
  const kv = (k, v, testid, mono = false) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: `v${mono ? ' mono' : ''}`, 'data-testid': testid || null, text: v }));
  const sw = h('div');
  const rules = engineLog.rulesSignature();
  const hf6 = ENGINE_LOCK && rules.includes(ENGINE_LOCK.rules_signature_contains);
  const guardState = nodeGuard.state;

  const storageKv = kv('Storage', persistenceText(app.persisted), 'about-storage');
  refreshPersistence(app, { request: Boolean(app.record) }).then((v) => {
    storageKv.querySelector('.v').textContent = persistenceText(v);
  });

  (async () => {
    try {
      const st = await app.updates.status();
      put(sw,
        kv('Installed release', st.current || '—', 'about-release'),
        kv('Staged update', st.pending || 'none'),
        kv('Loader', st.loader || '—', 'about-loader', true),
        kv('Updates', lastCheckText(app.updates.lastCheck), 'about-last-check'),
        st.lastRefusal ? kv('Last refused update', st.lastRefusal.reason) : null,
      );
    } catch {
      put(sw, kv('Verified copy', BUILT ? 'not active yet' : 'development build (no service worker)'));
    }
  })();

  const el = screen(
    { title: 'About', back: () => app.go('settings') },
    h(
      'div',
      { class: 'card' },
      kv('App', `BEAM Campfire ${APP_VERSION}`, 'about-version'),
      kv('Wallet engine', ENGINE_LOCK ? `BEAM ${ENGINE_LOCK.beam_tag} (WebAssembly)` : 'unknown'),
      kv('Consensus rules', rules ? (hf6 ? 'mainnet, includes HF6 (block 3928666)' : 'mainnet, WITHOUT HF6') : 'shown once the wallet has started', 'about-rules'),
      kv('Node', wallet.state.node || app.prefs.node, null, true),
      kv('Finds coins', wallet.state.scanning ? 'all (reads every new block)' : 'from its own payments (no block scan)', 'about-scan'),
      kv('Node connection', wallet.state.connEvent ? (wallet.state.connEvent.node_connected ? 'connected' : `not connected${wallet.state.connEvent.last_connect_error ? `: ${wallet.state.connEvent.last_connect_error}` : ''}`) : wallet.state.nodeConnected ? 'connected' : 'not connected', 'about-connection'),
      kv('Connections refused by the node guard', String(Object.values(guardState.blocked).reduce((a, b) => a + b, 0))),
      kv('Cross-origin isolated', String(self.crossOriginIsolated)),
      storageKv,
    ),
    h('p', { class: 'section-title', text: 'Release' }),
    h('div', { class: 'card' }, sw),
    h('p', { class: 'section-title', text: 'Engine files (SHA-256)' }),
    h('div', { class: 'card' }, ...(ENGINE_LOCK ? Object.entries(ENGINE_LOCK.files).map(([f, s]) => h('div', { class: 'kv' }, h('span', { class: 'k', text: f }), h('span', { class: 'v mono', text: s }))) : [h('p', { text: 'Not a release build.' })])),
    rules ? h('details', { class: 'more' }, h('summary', { text: 'Full rules signature' }), h('p', { class: 'mono', 'data-testid': 'about-rules-full', text: rules })) : null,
    hf6 === false && rules ? notice('error', 'This engine does not follow the current BEAM consensus rules (HF6). Do not use it.') : null,
    h('p', { class: 'small', text: 'BEAM Campfire is part of Campfire for BEAM (GPL-3.0), a fork of Campfire / Stack Wallet. The wallet engine is BEAM\'s own (Apache-2.0). Inter font: SIL Open Font License 1.1.' }),
  );
  return { el };
}
