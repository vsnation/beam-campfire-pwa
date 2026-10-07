// BEAM Campfire - app controller: boot, screen routing, lock and auto-lock.
import { h, clear } from './lib/dom.js';
import { engineSupport, loadEngine, nodeGuard, walletFiles } from './lib/engine.js';
import { getPrefs, setPrefs, getWalletRecord } from './lib/store.js';
import { wallet } from './lib/wallet.js';
import { ensureVerifiedCopy, updates } from './lib/update.js';
import { BUILT } from './lib/version.js';

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
import changePassword from './screens/change_password.js';
import about from './screens/about.js';
import deleteWallet from './screens/delete_wallet.js';
import problem from './screens/problem.js';

const SCREENS = {
  welcome, backup, confirmWords, restore, importWallet, setPassword, passkeySetup, ipNotice, fastStart, unlock,
  home, send, review, txStatus, receive, activity, settings, changePassword, about, deleteWallet, problem,
};
// Screens that need an unlocked, running wallet.
const NEEDS_WALLET = new Set(['home', 'send', 'review', 'txStatus', 'receive', 'activity', 'settings', 'changePassword', 'about']);

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

  go(name, params = {}) {
    if (!SCREENS[name]) throw new Error(`no screen ${name}`);
    if (NEEDS_WALLET.has(name) && !this.dbPass) name = this.record ? 'unlock' : 'welcome';
    if (this.current && this.current.destroy) {
      try {
        this.current.destroy();
      } catch (e) {
        console.error(e);
      }
    }
    document.querySelectorAll('.overlay').forEach((o) => o.remove());
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

  async setPrefs(patch) {
    this.prefs = await setPrefs(patch);
    return this.prefs;
  },

  /** Stops the engine and forgets the database password. */
  async lock(reason) {
    const wasOpen = Boolean(this.dbPass);
    this.dbPass = null;
    if (this.setup) this.setup = null;
    await wallet.stop();
    if (wasOpen || this.currentName !== 'unlock') this.go('unlock', { reason });
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
  // Cross-origin isolation (and with it SharedArrayBuffer) can come from our
  // own service worker: on a host that sends no COOP/COEP headers (a plain
  // static host such as GitHub Pages) the first load, before the verified
  // copy serves the page, is never isolated. So install the verified copy
  // first and judge the browser once the page is served by it.
  const pre = engineSupport();
  const isolationOnly = pre.problems.every((p) => p === 'cross-origin isolation' || p === 'SharedArrayBuffer');
  const canInstallFirst = isolationOnly && 'serviceWorker' in navigator && !navigator.serviceWorker.controller;
  if (!pre.ok && !canInstallFirst) return app.go('problem', { kind: 'unsupported', detail: pre.problems });

  const copy = await ensureVerifiedCopy();
  if (copy === 'reloading') return;
  if (copy && copy.failed) return app.go('problem', { kind: 'integrity', detail: copy.failed });
  const sup = engineSupport();
  if (!sup.ok) return app.go('problem', { kind: 'unsupported', detail: sup.problems });
  app.copyState = copy;

  app.prefs = await getPrefs();
  app.record = (await getWalletRecord()) || null;
  loadEngine().catch((e) => console.warn('[campfire] engine', e.message)); // warm up

  if (BUILT && navigator.serviceWorker && navigator.serviceWorker.controller) {
    // Look for a signed update once per start; applying it is always the user's choice.
    setTimeout(() => updates.check().catch(() => {}), 4000);
  }

  const qs = new URLSearchParams(location.search);
  const selftestMode = qs.get('selftest');
  if ((selftestMode === '1' || selftestMode === 'import') && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    try {
      const r = await fetch('__dev/flags', { cache: 'no-store' });
      const flags = r.ok ? await r.json() : null;
      if (flags && flags.selftest === true) {
        const { runSelfTest, runImportSelfTest } = await import('./lib/selftest.js');
        if (selftestMode === 'import' && flags.importTest === true) return runImportSelfTest(app);
        if (selftestMode === '1') return runSelfTest(app);
      }
    } catch {
      /* not the dev server: no self-test */
    }
  }

  app.go(app.record ? 'unlock' : 'welcome');
}

boot().catch((e) => {
  console.error(e);
  clear(root);
  root.appendChild(h('main', { class: 'screen' }, h('div', { class: 'content' }, h('h2', { class: 'title', text: 'BEAM Campfire could not start' }), h('p', { class: 'lead', text: String(e && e.message) }), h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Reload'))));
});

// Read-only view for the e2e harness and the in-page self-test. No secrets on it.
window.__campfire = Object.freeze({
  screen: () => app.currentName,
  sync: () => wallet.state.sync,
  height: () => (wallet.state.status ? wallet.state.status.current_height : null),
  inSync: () => (wallet.state.status ? wallet.state.status.is_in_sync === true : null),
  totals: () => Object.fromEntries([...wallet.state.totals].map(([k, v]) => [k, { available: String(v.available), receiving: String(v.receiving), sending: String(v.sending) }])),
  txs: () => wallet.state.txs.map((t) => ({ txId: t.txId, status: t.status, income: t.income, value: t.value, fee: t.fee, kernel: t.kernel })),
  node: () => wallet.state.node,
  explorer: () => wallet.state.explorer,
  guard: () => nodeGuard.state,
  scanning: () => wallet.state.scanning,
  connection: () => wallet.state.connEvent,
  createAddress: (type) => wallet.session.call('create_address', { type }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.rpc && e.rpc.code, data: e.rpc && e.rpc.data })),
  version: () => (updates.available ? { available: updates.available.version } : null),
  go: (name, params) => app.go(name, params),
  validate: (address) => wallet.validateAddress(address),
  addresses: async () => ((await wallet.session.call('addr_list', { own: true })) || []).map((a) => a.address).sort(),
  // Names and flags only: which files the engine holds, and what kind of wallet this is.
  walletFiles: () => walletFiles(),
  record: () => (app.record ? { imported: Boolean(app.record.imported), restored: Boolean(app.record.restored), scan: app.record.scan !== false, setupDone: Boolean(app.record.setupDone), passkey: Boolean(app.record.envelopes && app.record.envelopes.passkey) } : null),
});
