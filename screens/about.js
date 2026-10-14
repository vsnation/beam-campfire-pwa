/* About
 * Spec: ONE job: show exactly what is running, so it can be checked.
 *       Primary CTA: none (information); "Check for updates" lives in Settings.
 *       Taps from app open: 2 (Settings -> About).
 * Exit-intent reasons and answers:
 *   - "Can I verify this build?" -> version, engine SHA-256s, consensus rules, release status.
 *   - "Who made this?" -> project and licences named, with the public repository.
 *   - "Will my wallet survive?" -> whether the browser keeps this app's storage, and when updates were
 *     last checked. Opening this screen contacts nothing: no web address, no explorer.
 *   - "What does the signature not cover?" -> said under Release: the loader comes from the web
 *     address as it is; the app watches it only while open (lib/loader.js, loader-watch.js).
 *   - "I downloaded an update I don't want (yet)" -> "Delete this download" beside Staged update
 *     (issue #78); a later check downloads it again.
 */
import { h, put } from '../lib/dom.js';
import { screen, notice } from '../lib/ui.js';
import { APP_VERSION, BUILT, ENGINE_LOCK } from '../lib/version.js';
import { engineLog, nodeGuard } from '../lib/engine.js';
import { wallet } from '../lib/wallet.js';
import { lastCheckText, copyHost, releaseDate } from '../lib/update.js';
import { discardDownload } from '../lib/update_ui.js';
import { refreshPersistence, persistenceText } from '../lib/storage.js';
import { t, tk } from '../lib/i18n.js';
import { loaderText } from '../lib/loader_words.js';

// What the release signature does not cover, said plainly.
export const ABOUT_TRIPWIRE = tk(
  "Updates are checked against BEAM Campfire's signature before they are installed. The part of BEAM Campfire that does that check (the loader) comes straight from this app's web address. While BEAM Campfire is open it watches the loader and stops if the address starts serving a different one; it cannot see a change made while it is closed, and the next time it opens, that code runs.",
);

/** The installed release: its version, when it was released, and the copy it came from (not this app's address). */
function installedText(st) {
  if (!st.current) return '—';
  const version = st.current;
  const date = releaseDate(st.currentCreated);
  const host = copyHost(st.currentFrom);
  if (date && host) return t('{version}, released {date} (from a copy at {host})', { version, date, host });
  if (date) return t('{version}, released {date}', { version, date });
  if (host) return t('{version} (from a copy at {host})', { version, host });
  return version;
}

/** Whether the wallet reaches its node; the engine's own error, when it gave one, as it came. */
function connectionText(state) {
  const ev = state.connEvent;
  if (!ev) return state.nodeConnected ? t('connected') : t('not connected');
  if (ev.node_connected) return t('connected');
  return ev.last_connect_error ? t('not connected: {error}', { error: ev.last_connect_error }) : t('not connected');
}

export default function about(app) {
  const kv = (k, v, testid, mono = false) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: `v${mono ? ' mono' : ''}`, 'data-testid': testid || null, text: v }));
  const sw = h('div');
  const rules = engineLog.rulesSignature();
  const hf6 = ENGINE_LOCK && rules.includes(ENGINE_LOCK.rules_signature_contains);
  const guardState = nodeGuard.state;

  const storageKv = kv(t('Storage'), persistenceText(app.persisted), 'about-storage');
  refreshPersistence(app, { request: Boolean(app.record) }).then((v) => {
    storageKv.querySelector('.v').textContent = persistenceText(v);
  });

  // The downloaded, not installed release, with the way to delete it where the loader can (#78).
  const stagedKv = (st) => {
    const canDelete = Boolean(st.pending && Array.isArray(st.features) && st.features.includes('discard-update'));
    return h(
      'div',
      { class: 'kv' },
      h('span', { class: 'k', text: t('Staged update') }),
      h(
        'span',
        { class: 'v staged' },
        h('span', { 'data-testid': 'about-staged', text: st.pending || t('none') }),
        canDelete ? h('button', { class: 'btn btn-text btn-small', 'data-testid': 'about-discard', onclick: () => discardDownload(app, { onDone: () => fill() }) }, t('Delete this download')) : null,
      ),
    );
  };

  async function fill() {
    try {
      const st = await app.updates.status();
      const added = app.updates.addedSource();
      // A loader from before the copies (no api in its answer) asks only this app's address.
      const copies = st.api >= 2 ? [...(st.sources || []).filter((x) => x.kind !== 'own').map((x) => x.host), ...(added ? [new URL(added).host] : [])] : [];
      put(sw,
        kv(t('Installed release'), installedText(st), 'about-release'),
        stagedKv(st),
        kv(t('Loader'), st.loader || '—', 'about-loader', true),
        kv(t('Updates'), lastCheckText(app.updates.lastCheck), 'about-last-check'),
        // Where a tapped check looks: all of them, the newest signed release wins (on a tie, this app's
        // address). An older loader reports no list: it asks only this address.
        h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: t('Update sources (each check asks them all)') }), h('span', { class: 'v list', 'data-testid': 'about-sources' }, ...[t("This app's address"), ...copies].map((x) => h('span', { text: x })))),
        // The loader's own sentence (sw.js, lib/release.js): in the person's language.
        st.lastRefusal ? kv(t('Last refused update'), loaderText(st.lastRefusal.reason)) : null,
      );
    } catch {
      put(sw, kv(t('Verified copy'), BUILT ? t('not active yet') : t('development build (no service worker)')));
    }
  }
  fill();

  const el = screen(
    { title: t('About'), back: () => app.back('settings') },
    h(
      'div',
      { class: 'card' },
      kv(t('App'), `BEAM Campfire ${APP_VERSION}`, 'about-version'),
      kv(t('Wallet engine'), ENGINE_LOCK ? `BEAM ${ENGINE_LOCK.beam_tag} (WebAssembly)` : t('unknown')), // i18n-ignore: BEAM's release tag and the technology's name
      kv(t('Consensus rules'), rules ? (hf6 ? t('mainnet, includes HF6 (block 3928666)') : t('mainnet, WITHOUT HF6')) : t('shown once the wallet has started'), 'about-rules'),
      kv(t('Node'), wallet.state.node || app.prefs.node, null, true),
      kv(t('Finds coins'), wallet.state.scanning ? t('all (reads every new block)') : t('from its own payments (no block scan)'), 'about-scan'),
      kv(t('Node connection'), connectionText(wallet.state), 'about-connection'),
      kv(t('Connections refused by the node guard'), String(Object.values(guardState.blocked).reduce((a, b) => a + b, 0))),
      kv(t('Cross-origin isolated'), String(self.crossOriginIsolated)),
      storageKv,
    ),
    h('p', { class: 'section-title', text: t('Release') }),
    h('div', { class: 'card' }, sw),
    h('p', { class: 'small', 'data-testid': 'about-tripwire', text: t(ABOUT_TRIPWIRE) }),
    h('p', { class: 'section-title', text: t('Engine files (SHA-256)') }),
    h('div', { class: 'card' }, ...(ENGINE_LOCK ? Object.entries(ENGINE_LOCK.files).map(([f, s]) => h('div', { class: 'kv' }, h('span', { class: 'k', text: f }), h('span', { class: 'v mono', text: s }))) : [h('p', { text: t('Not a release build.') })])),
    rules ? h('details', { class: 'more' }, h('summary', { text: t('Full rules signature') }), h('p', { class: 'mono', 'data-testid': 'about-rules-full', text: rules })) : null,
    hf6 === false && rules ? notice('error', t('This engine does not follow the current BEAM consensus rules (HF6). Do not use it.')) : null,
    h('p', { class: 'small', text: t("BEAM Campfire is part of Campfire for BEAM (GPL-3.0), a fork of Campfire / Stack Wallet. The wallet engine is BEAM's own (Apache-2.0). Inter font: SIL Open Font License 1.1.") }),
  );
  return { el };
}
