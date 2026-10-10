// BEAM Campfire - app controller: boot, screen routing, lock and auto-lock.
import { h, clear } from './lib/dom.js';
import { engineSupport, loadEngine, nodeGuard, walletFiles } from './lib/engine.js';
import { getPrefs, setPrefs, getWalletRecord } from './lib/store.js';
import { wallet } from './lib/wallet.js';
import { updates, takeJustUpdated } from './lib/update.js';
import { installBack } from './lib/back.js';
import { navHistory } from './lib/nav.js';
import { swSupported, isControlled, clearReloadFlag, installedButBypassed, watchLoader, loaderBehind } from './lib/loader.js';
import { refreshPersistence } from './lib/storage.js';
import { reconcileOwnNode } from './lib/own_node.js';
import { BUILT, APP_VERSION } from './lib/version.js';
import { toast } from './lib/ui.js';

import welcome from './screens/welcome.js';
import backup from './screens/backup.js';
import confirmWords from './screens/confirm_words.js';
import restore from './screens/restore.js';
import importWallet from './screens/import_wallet.js';
import setPassword from './screens/set_password.js';
import passkeySetup from './screens/passkey_setup.js';
import ipNotice from './screens/ip_notice.js';
import fastStart from './screens/fast_start.js';
import unlock from './screens/unlock.js';
import home from './screens/home.js';
import send from './screens/send.js';
import review from './screens/review.js';
import txStatus from './screens/tx_status.js';
import receive from './screens/receive.js';
import activity from './screens/activity.js';
import settings from './screens/settings.js';
import nodeSettings from './screens/node.js';
import ownNode from './screens/own_node.js';
import changePassword from './screens/change_password.js';
import about from './screens/about.js';
import deleteWallet from './screens/delete_wallet.js';
import ownerKey from './screens/owner_key.js';
import problem from './screens/problem.js';
import install from './screens/install.js';
import swap from './screens/swap.js';
import dapps, { runnerStats } from './screens/dapps.js';
import names from './screens/names.js';
import airdrop from './screens/airdrop.js';
import airdropCreate from './screens/airdrop_create.js';
import airdropBatches from './screens/airdrop_batches.js';
import airdropCodes from './screens/airdrop_codes.js';
import { installConsent } from './screens/consent.js';
import { ETH_SCREENS } from './screens/eth_screens.js';
import { BUY_SCREENS } from './screens/buy_screens.js';
import { consentLog, contractsState } from './lib/contracts.js';

const SCREENS = {
  welcome, backup, confirmWords, restore, importWallet, setPassword, passkeySetup, ipNotice, fastStart, unlock,
  home, send, review, txStatus, receive, activity, settings, nodeSettings, ownNode, changePassword, about, deleteWallet, ownerKey, problem, install, swap, dapps,
  names, airdrop, airdropCreate, airdropBatches, airdropCodes,
  ...ETH_SCREENS,
  ...BUY_SCREENS,
};
// Screens that need an unlocked, running wallet.
const NEEDS_WALLET = new Set(['home', 'send', 'review', 'txStatus', 'receive', 'activity', 'settings', 'nodeSettings', 'ownNode', 'changePassword', 'about', 'ownerKey', 'swap', 'dapps', 'names', 'airdrop', 'airdropCreate', 'airdropBatches', 'airdropCodes', ...Object.keys(ETH_SCREENS), ...Object.keys(BUY_SCREENS)]);

const root = document.getElementById('app');

export const app = {
  prefs: null,
  record: null,
  dbPass: null,
  setup: null,
  current: null,
  currentName: null,
  params: null,
  lastActivity: Date.now(),
  hiddenAt: null,
  wallet,
  updates,
  persisted: null,
  // Run on lock and on the tripwire, to forget what a feature kept in memory (the Ethereum screens add one).
  lockHooks: new Set(),
  // Where Back goes (lib/nav.js); cleared on lock.
  nav: navHistory(),

  runLockHooks() {
    for (const f of this.lockHooks) {
      try {
        f();
      } catch (e) {
        console.error(e);
      }
    }
  },

  /**
   * Opens a screen. The one being left becomes Back's target, unless
   * opts.replace (move on without it) or opts.reset (forget all before).
   */
  go(name, params = {}, opts = {}) {
    if (!SCREENS[name]) throw new Error(`no screen ${name}`);
    // After the tripwire nothing else opens in this page: no unlock, no password field.
    if (this.intrusion) {
      name = 'problem';
      params = { kind: 'tripwire', detail: this.intrusion };
    }
    if (NEEDS_WALLET.has(name) && !this.dbPass) name = this.record ? 'unlock' : 'welcome';
    this.nav.move(this.currentName ? { name: this.currentName, params: this.params } : null, { name, params }, opts);
    if (this.current && this.current.destroy) {
      try {
        this.current.destroy();
      } catch (e) {
        console.error(e);
      }
    }
    document.querySelectorAll('.overlay').forEach((o) => {
      o.dispatchEvent(new Event('campfire:dismiss'));
      o.remove();
    });
    clear(root);
    this.currentName = name;
    this.params = params;
    const r = SCREENS[name](this, params) || {};
    this.current = r;
    root.appendChild(r.el || r);
    root.dataset.screen = name;
    window.scrollTo(0, 0);
    const focus = root.querySelector('[data-autofocus]');
    if (focus) focus.focus();
  },

  /** Back to the screen the person came from, or to `fallback` when there is none (after a reload or an unlock). */
  back(fallback = 'home', fallbackParams = {}) {
    const t = this.nav.backTarget(fallback, fallbackParams);
    return this.go(t.name, t.params, t.opts);
  },

  async setPrefs(patch) {
    this.prefs = await setPrefs(patch);
    return this.prefs;
  },

  /** Stops the engine and forgets the database password. */
  async lock(reason) {
    const wasOpen = Boolean(this.dbPass);
    this.dbPass = null;
    if (this.setup) this.setup = null;
    this.nav.clear();
    this.runLockHooks();
    await wallet.stop();
    if (wasOpen || this.currentName !== 'unlock') this.go('unlock', { reason });
  },

  /**
   * The tripwire (lib/loader.js): the web address now serves code BEAM Campfire did not
   * sign. Stop the engine, forget the database password, and say so. Never reload: a
   * reload would run the new code.
   */
  async intruded(reason) {
    if (this.intrusion) return;
    this.intrusion = reason || 'unsigned code';
    console.warn('[campfire] tripwire:', this.intrusion);
    this.dbPass = null;
    this.setup = null;
    this.nav.clear();
    this.runLockHooks();
    this.go('problem', { kind: 'tripwire', detail: this.intrusion });
    await wallet.stop().catch(() => {});
  },

  touch() {
    this.lastActivity = Date.now();
  },

  autoLockMs() {
    return (Number(this.prefs && this.prefs.autoLockMin) || 5) * 60000;
  },

  lockAllowedNow() {
    // Never in the middle of the first download/import: locking would throw it away.
    return Boolean(this.dbPass) && this.currentName !== 'fastStart' && !wallet.state.importing;
  },
};

// Every contract request that spends is shown on the approve sheet; without it, all are refused.
installConsent(app);

window.addEventListener('pointerdown', () => app.touch(), { passive: true });
window.addEventListener('keydown', () => app.touch(), { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    app.hiddenAt = Date.now();
  } else {
    if (app.hiddenAt && Date.now() - app.hiddenAt >= app.autoLockMs() && app.lockAllowedNow()) app.lock('timeout');
    app.hiddenAt = null;
    app.touch();
  }
});
setInterval(() => {
  if (document.visibilityState === 'visible' && Date.now() - app.lastActivity >= app.autoLockMs() && app.lockAllowedNow()) app.lock('timeout');
}, 15000);

async function boot() {
  if (BUILT && swSupported()) {
    if (isControlled()) {
      clearReloadFlag();
      // Watches for code BEAM Campfire did not sign. Nothing here contacts the web address.
      // After an Update that brought a new loader, the page reloads under it as soon
      // as it has taken over, when nothing is unlocked; otherwise Home offers it.
      watchLoader({ onIntrusion: (why) => app.intruded(why), onMoved: () => (app.dbPass ? app.updates.emit() : location.reload()) }).catch((e) => console.warn('[campfire] loader watch', e.message));
    } else if (!(await installedButBypassed())) {
      // First open on this device (or the browser cleared it): set up the verified copy, with
      // progress. This comes BEFORE the engine check: on a static host that sends no headers
      // (GitHub Pages) the page only becomes cross-origin isolated - which the engine needs for
      // SharedArrayBuffer - once the verified copy serves it with COOP/COEP.
      return app.go('install');
    }
  }
  return app.continueBoot();
}

/** Everything after the verified copy is in place. No update check, no request to the web address. */
app.continueBoot = async function continueBoot() {
  // Served by the verified copy (or no service worker at all): now the engine must be able to run.
  // Only here is "this browser can't run it" the truth.
  const sup = engineSupport();
  if (!sup.ok) {
    // Installed, but this load went around the installed copy: say so, not "can't run".
    if (BUILT && swSupported() && !isControlled()) {
      const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
      if (reg && reg.active) return app.go('problem', { kind: 'bypassed' });
    }
    return app.go('problem', { kind: 'unsupported', detail: sup.problems });
  }
  app.prefs = await getPrefs();
  // The person's own node must be in this page's policy before the engine can reach it.
  if (BUILT && (await reconcileOwnNode(app))) return;
  app.record = (await getWalletRecord()) || null;
  loadEngine().catch((e) => console.warn('[campfire] engine', e.message)); // warm up
  refreshPersistence(app, { request: Boolean(app.record) });

  const qs = new URLSearchParams(location.search);
  const selftestMode = qs.get('selftest');
  if ((selftestMode === '1' || selftestMode === 'import' || selftestMode === 'buy') && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    try {
      const r = await fetch('__dev/flags', { cache: 'no-store' });
      const flags = r.ok ? await r.json() : null;
      if (flags && flags.selftest === true) {
        const { runSelfTest, runImportSelfTest, runBuySelfTest } = await import('./lib/selftest.js');
        if (selftestMode === 'import' && flags.importTest === true) return runImportSelfTest(app);
        if (selftestMode === 'buy') return runBuySelfTest();
        if (selftestMode === '1') return runSelfTest(app);
      }
    } catch {
      /* not the dev server: no self-test */
    }
  }

  // Once, after an Update: which version, and whether it came from another copy of the app.
  const updated = takeJustUpdated(APP_VERSION);
  app.go(app.record ? 'unlock' : 'welcome', updated ? { updated } : {});
  if (updated && !app.record) toast(updated, 6000);
};

installBack(app);

boot().catch((e) => {
  console.error(e);
  clear(root);
  root.appendChild(h('main', { class: 'screen' }, h('div', { class: 'content' }, h('h2', { class: 'title', text: 'BEAM Campfire could not start' }), h('p', { class: 'lead', text: String(e && e.message) }), h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Reload'))));
});

// Read-only view for the e2e harness and the in-page self-test. No secrets on it.
window.__campfire = Object.freeze({
  screen: () => app.currentName,
  // Back's targets, screen names only, oldest first.
  backStack: () => app.nav.names(),
  sync: () => wallet.state.sync,
  height: () => (wallet.state.status ? wallet.state.status.current_height : null),
  inSync: () => (wallet.state.status ? wallet.state.status.is_in_sync === true : null),
  totals: () => Object.fromEntries([...wallet.state.totals].map(([k, v]) => [k, { available: String(v.available), receiving: String(v.receiving), sending: String(v.sending) }])),
  txs: () => wallet.state.txs.map((t) => ({ txId: t.txId, status: t.status, income: t.income, value: t.value, fee: t.fee, kernel: t.kernel })),
  node: () => wallet.state.node,
  nodeMode: () => wallet.state.nodeMode,
  nodeSwitches: () => wallet.state.switchLog.map((e) => ({ ...e })),
  ownNodeConfirmed: () => (wallet.state.connEvent ? wallet.state.connEvent.own_node === true : null),
  explorer: () => wallet.state.explorer,
  guard: () => nodeGuard.state,
  scanning: () => wallet.state.scanning,
  connection: () => wallet.state.connEvent,
  createAddress: (type) => wallet.session.call('create_address', { type }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.rpc && e.rpc.code, data: e.rpc && e.rpc.data })),
  version: () => (updates.available ? { available: updates.available.version } : null),
  intrusion: () => app.intrusion || null,
  running: () => Boolean(wallet.session),
  persisted: () => app.persisted,
  loaderBehind: () => loaderBehind(),
  go: (name, params) => app.go(name, params),
  validate: (address) => wallet.validateAddress(address),
  addresses: async () => ((await wallet.session.call('addr_list', { own: true })) || []).map((a) => a.address).sort(),
  // Names and flags only: which files the engine holds, and what kind of wallet this is.
  walletFiles: () => walletFiles(),
  // Contract calls: the last consent decisions (amounts as the engine reported them) and counters.
  consents: () => consentLog(),
  contracts: () => contractsState(),
  // Counters of the running dApp frames (requests, refused, dropped messages); nothing a dApp sent.
  dapps: () => runnerStats(),
  record: () => (app.record ? { imported: Boolean(app.record.imported), restored: Boolean(app.record.restored), scan: app.record.scan !== false, setupDone: Boolean(app.record.setupDone), passkey: Boolean(app.record.envelopes && app.record.envelopes.passkey) } : null),
});
