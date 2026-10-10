// In-page self-test for devices the e2e harness cannot drive (iOS Safari in
// the Simulator). It only runs when the page is on localhost AND the dev
// server (tools/serve.mjs --selftest) answers /__dev/flags; production hosts
// answer 404 there, so this file is inert in a real deployment.
//
// It creates a THROWAWAY wallet (any existing wallet in this browser profile
// is deleted first - never point it at a profile with a real wallet), unlocks
// it with a password, starts it the way a new wallet starts (no snapshot, no
// block scan), waits for Synced, makes a receive address, checks which address
// types a scan-less wallet refuses, reloads, unlocks again, checks the address
// survived, then imports the recovery snapshot (the restore / "find coins"
// path) and waits for Synced again. The result is POSTed to /__dev/result,
// which the dev server prints; the throwaway wallet is deleted at the end.
//
// ?selftest=import (dev server started with --import-test <dir>): the
// wallet.db import path, for Safari where no file picker can be driven. It
// fetches a THROWAWAY wallet.db made by BEAM's native 7.5.14493 CLI from the
// dev server, stages it in the engine, checks a wrong password (refused,
// nothing saved) and the right one, adds it, starts it without the block
// scan, waits for Synced, checks the CLI's address is in the wallet, reloads,
// unlocks with the file's password and checks again, then deletes it.

import { h, put } from './dom.js';
import { generatePhrase, deleteWalletDb, engineLog, loadEngine, nodeGuard, stageImport, checkImportPassword, walletFiles } from './engine.js';
import { createWallet, openWithPasswordFor, markSetupDone, setScan, prepareImport, importWallet } from './session.js';
import { checkWalletFile } from './wallet_file.js';
import { store, getPrefs, getWalletRecord } from './store.js';
import { downloadRecovery, recoverySize } from './recovery.js';
import { wallet } from './wallet.js';
import { toHex, randomBytes } from './envelope.js';
import { passkeyAvailable } from './passkey.js';

const KEY = 'campfire-selftest';

function save(st) {
  sessionStorage.setItem(KEY, JSON.stringify(st));
}
function load() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v;
      try {
        v = pred();
      } catch (e) {
        return reject(e);
      }
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 1000);
    };
    tick();
  });
}

export async function runSelfTest(app) {
  const root = document.getElementById('app');
  const lines = h('pre', { class: 'mono selftest-log', 'data-testid': 'selftest-log' });
  put(root, h('main', { class: 'screen' }, h('h1', { text: 'BEAM Campfire self-test' }), lines));
  const log = (m) => {
    lines.textContent += `${new Date().toISOString().slice(11, 19)} ${m}\n`;
    console.log('[selftest]', m);
  };
  let st = load();
  const result = st && st.result ? st.result : { ok: false, steps: {} };
  const finish = async (ok, error) => {
    result.ok = ok;
    if (error) result.error = String(error && error.message ? error.message : error);
    result.finishedAt = new Date().toISOString();
    log(ok ? 'PASS' : `FAIL: ${result.error}`);
    try {
      await fetch('__dev/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
    } catch (e) {
      log(`could not report: ${e.message}`);
    }
    sessionStorage.removeItem(KEY);
    await wallet.stop().catch(() => {});
    // The wallet was a throwaway: remove it so the next visit starts at Welcome.
    await deleteWalletDb().catch(() => {});
    await store.clear().catch(() => {});
    log('throwaway wallet removed');
  };

  try {
    if (!st) {
      result.env = {
        userAgent: navigator.userAgent,
        crossOriginIsolated: self.crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
        hardwareConcurrency: navigator.hardwareConcurrency,
        standalone: navigator.standalone === true || matchMedia('(display-mode: standalone)').matches,
        serviceWorkerControlled: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
        webauthn: typeof PublicKeyCredential !== 'undefined',
      };
      try {
        result.env.platformAuthenticator = await passkeyAvailable();
        if (typeof PublicKeyCredential !== 'undefined' && PublicKeyCredential.getClientCapabilities) result.env.clientCapabilities = await PublicKeyCredential.getClientCapabilities();
      } catch (e) {
        result.env.passkeyProbeError = e.message;
      }
      log(`isolated=${result.env.crossOriginIsolated} SAB=${result.env.sharedArrayBuffer} cores=${result.env.hardwareConcurrency}`);

      const t0 = performance.now();
      await loadEngine();
      result.steps.engineLoadMs = Math.round(performance.now() - t0);
      log(`engine loaded in ${result.steps.engineLoadMs} ms`);

      // Throwaway wallet: wipe whatever this test profile had.
      await wallet.stop().catch(() => {});
      await deleteWalletDb();
      await store.clear();
      app.prefs = await getPrefs();
      app.record = null;
      const password = `selftest-${toHex(randomBytes(6))}`;
      app.setup = { mode: 'create', words: await generatePhrase() };
      await createWallet(app, password);
      await app.setPrefs({ ipAck: true });
      result.steps.created = true;
      log('throwaway wallet created');

      const ti = performance.now();
      await wallet.start({ dbPass: app.dbPass, node: app.prefs.node, bodyRequests: false });
      await markSetupDone(app);
      result.steps.rulesSignature = engineLog.rulesSignature();

      await waitFor(() => wallet.state.sync.state === 'synced', 5 * 60000, 'Synced');
      result.steps.newWalletStartToSyncedMs = Math.round(performance.now() - ti);
      result.steps.synced = { height: wallet.state.status.current_height, explorerHeight: wallet.state.explorer && wallet.state.explorer.height, verified: wallet.state.sync.verified };
      log(`new wallet synced at ${result.steps.synced.height} (explorer ${result.steps.synced.explorerHeight}) ${result.steps.newWalletStartToSyncedMs} ms after start, no download`);
      result.steps.guardRefusals = Object.values(nodeGuard.state.blocked).reduce((a, b) => a + b, 0);
      result.steps.connectionEvent = wallet.state.connEvent;

      const address = await wallet.receiveAddress();
      const v = await wallet.validateAddress(address);
      result.steps.address = { length: address.length, valid: v.is_valid, mine: v.is_mine, type: v.type };
      log(`receive address ok (${address.length} chars, valid=${v.is_valid})`);
      const refused = {};
      for (const type of ['max_privacy', 'offline']) {
        try {
          await wallet.session.call('create_address', { type });
          refused[type] = false;
        } catch (e) {
          refused[type] = (e.rpc && e.rpc.code) || e.message;
        }
      }
      result.steps.scanlessRefusesAddressTypes = refused;
      log(`scan-less wallet refuses: ${JSON.stringify(refused)}`);
      await wallet.persistNow();
      await wallet.stop();
      st = { phase: 'reload', password, address, result };
      save(st);
      log('reloading to check persistence…');
      setTimeout(() => location.reload(), 500);
      return;
    }

    // ---- after the reload
    log('after reload: unlocking with the password');
    app.prefs = await getPrefs();
    app.record = await getWalletRecord();
    if (!app.record) throw new Error('wallet record missing after reload');
    const dbPass = await openWithPasswordFor(app, st.password);
    try {
      await openWithPasswordFor(app, `${st.password}-wrong`);
      result.steps.wrongPasswordRefused = false;
    } catch (e) {
      result.steps.wrongPasswordRefused = e.code === 'wrong_secret';
    }
    app.dbPass = dbPass;
    const tr = performance.now();
    await wallet.start({ dbPass, node: app.prefs.node, bodyRequests: false });
    const list = await wallet.session.call('addr_list', { own: true });
    result.steps.addressPersisted = (list || []).some((a) => a.address === st.address);
    log(`address after reload: ${result.steps.addressPersisted}`);
    await waitFor(() => wallet.state.sync.state === 'synced', 5 * 60000, 'Synced after reload');
    result.steps.resyncAfterReloadMs = Math.round(performance.now() - tr);
    log(`synced again in ${result.steps.resyncAfterReloadMs} ms`);

    // The restore / "find coins" path: snapshot download + import, then scanning on - where this
    // address has the snapshot relay. A plain static host (GitHub Pages) has none: skipped, said so.
    result.env.crossOriginIsolated = self.crossOriginIsolated;
    if (!(await recoverySize())) {
      result.steps.snapshot = 'skipped: no snapshot at this address (static host)';
      log(result.steps.snapshot);
      return finish(Boolean(result.steps.addressPersisted && result.steps.wrongPasswordRefused && result.steps.synced && self.crossOriginIsolated));
    }
    await wallet.stop();
    const td = performance.now();
    let buf = await downloadRecovery((d, t) => {
      if (d === t || d % 50e6 < 2e6) log(`download ${Math.round(d / 1e6)}/${Math.round(t / 1e6)} MB`);
    });
    result.steps.recoveryBytes = buf.length;
    result.steps.downloadMs = Math.round(performance.now() - td);
    const ti = performance.now();
    await wallet.start({ dbPass, node: app.prefs.node, recovery: buf, bodyRequests: true });
    buf = null;
    result.steps.importMs = Math.round(performance.now() - ti);
    await setScan(app, true);
    log(`snapshot: ${result.steps.downloadMs} ms download, ${result.steps.importMs} ms import`);
    const ts2 = performance.now();
    await waitFor(() => wallet.state.sync.state === 'synced', 10 * 60000, 'Synced after import');
    result.steps.syncAfterImportMs = Math.round(performance.now() - ts2);
    result.steps.scanningAfterImport = wallet.state.scanning;
    log(`synced after import in ${result.steps.syncAfterImportMs} ms`);
    await finish(Boolean(result.steps.addressPersisted && result.steps.wrongPasswordRefused && result.steps.synced && result.steps.importMs));
  } catch (e) {
    await finish(false, e);
  }
}

const IMPORT_KEY = 'campfire-selftest-import';

export async function runImportSelfTest(app) {
  const root = document.getElementById('app');
  const lines = h('pre', { class: 'mono selftest-log', 'data-testid': 'selftest-log' });
  put(root, h('main', { class: 'screen' }, h('h1', { text: 'BEAM Campfire self-test: import wallet.db' }), lines));
  const log = (m) => {
    lines.textContent += `${new Date().toISOString().slice(11, 19)} ${m}\n`;
    console.log('[selftest]', m);
  };
  let st = null;
  try {
    st = JSON.parse(sessionStorage.getItem(IMPORT_KEY) || 'null');
  } catch {
    st = null;
  }
  const result = st && st.result ? st.result : { ok: false, mode: 'import', steps: {} };
  const finish = async (ok, error) => {
    result.ok = ok;
    if (error) result.error = String(error && error.message ? error.message : error);
    result.finishedAt = new Date().toISOString();
    log(ok ? 'PASS' : `FAIL: ${result.error}`);
    try {
      await fetch('__dev/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
    } catch (e) {
      log(`could not report: ${e.message}`);
    }
    sessionStorage.removeItem(IMPORT_KEY);
    await wallet.stop().catch(() => {});
    await deleteWalletDb().catch(() => {});
    await store.clear().catch(() => {});
    log('throwaway wallet removed');
  };
  const syncedSnapshot = () => ({ height: wallet.state.status.current_height, inSync: wallet.state.status.is_in_sync === true, explorerHeight: wallet.state.explorer && wallet.state.explorer.height, verified: wallet.state.sync.verified });

  try {
    if (!st) {
      result.env = { userAgent: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated, standalone: navigator.standalone === true || matchMedia('(display-mode: standalone)').matches };
      await loadEngine();
      await wallet.stop().catch(() => {});
      await deleteWalletDb();
      await store.clear();
      app.prefs = await getPrefs();
      app.record = null;
      const info = await (await fetch('__dev/import.json', { cache: 'no-store' })).json();
      const bytes = new Uint8Array(await (await fetch('__dev/import.db', { cache: 'no-store' })).arrayBuffer());
      result.steps.fileBytes = bytes.length;
      result.steps.fileCheck = checkWalletFile({ size: bytes.length, head: bytes.subarray(0, 16) });
      log(`wallet.db: ${bytes.length} bytes, check ${JSON.stringify(result.steps.fileCheck)}`);
      await prepareImport(app);
      await stageImport(bytes);
      let t = performance.now();
      const wrong = await checkImportPassword(`${info.password}-wrong`);
      result.steps.wrongPasswordMs = Math.round(performance.now() - t);
      result.steps.wrongPasswordRefused = wrong === false;
      result.steps.nothingSavedAfterWrong = !(await getWalletRecord()) && !(await walletFiles()).includes('wallet.db');
      log(`wrong password refused: ${result.steps.wrongPasswordRefused} (${result.steps.wrongPasswordMs} ms), nothing saved: ${result.steps.nothingSavedAfterWrong}`);
      t = performance.now();
      result.steps.rightPasswordOpens = (await checkImportPassword(info.password)) === true;
      result.steps.rightPasswordMs = Math.round(performance.now() - t);
      log(`right password opens it: ${result.steps.rightPasswordOpens} (${result.steps.rightPasswordMs} ms)`);
      if (!result.steps.rightPasswordOpens) throw new Error('the right password did not open the file');
      await importWallet(app, info.password);
      await app.setPrefs({ ipAck: true });
      result.steps.filesAfterImport = await walletFiles();
      const ts = performance.now();
      await wallet.start({ dbPass: app.dbPass, node: app.prefs.node, bodyRequests: false });
      await markSetupDone(app);
      await waitFor(() => wallet.state.sync.state === 'synced', 5 * 60000, 'Synced');
      result.steps.startToSyncedMs = Math.round(performance.now() - ts);
      result.steps.synced = syncedSnapshot();
      log(`imported wallet synced: ${JSON.stringify(result.steps.synced)} after ${result.steps.startToSyncedMs} ms`);
      const list = ((await wallet.session.call('addr_list', { own: true })) || []).map((a) => a.address);
      result.steps.sameWallet = info.addresses.length > 0 && info.addresses.every((a) => list.includes(a));
      log(`the CLI's address is in this wallet: ${result.steps.sameWallet}`);
      await wallet.persistNow();
      await wallet.stop();
      sessionStorage.setItem(IMPORT_KEY, JSON.stringify({ phase: 'reload', password: info.password, addresses: info.addresses, result }));
      log('reloading to check persistence…');
      setTimeout(() => location.reload(), 500);
      return;
    }
    log('after reload: unlocking with the file\'s password');
    app.prefs = await getPrefs();
    app.record = await getWalletRecord();
    if (!app.record) throw new Error('wallet record missing after reload');
    result.steps.recordAfterReload = { imported: app.record.imported === true, scan: app.record.scan };
    const dbPass = await openWithPasswordFor(app, st.password);
    app.dbPass = dbPass;
    const tr = performance.now();
    await wallet.start({ dbPass, node: app.prefs.node, bodyRequests: false });
    const list = ((await wallet.session.call('addr_list', { own: true })) || []).map((a) => a.address);
    result.steps.addressAfterReload = st.addresses.every((a) => list.includes(a));
    await waitFor(() => wallet.state.sync.state === 'synced', 5 * 60000, 'Synced after reload');
    result.steps.resyncAfterReloadMs = Math.round(performance.now() - tr);
    result.steps.syncedAfterReload = syncedSnapshot();
    log(`after reload: address ${result.steps.addressAfterReload}, synced ${JSON.stringify(result.steps.syncedAfterReload)}`);
    const s1 = result.steps;
    await finish(Boolean(s1.fileCheck && s1.fileCheck.ok && s1.wrongPasswordRefused && s1.nothingSavedAfterWrong && s1.rightPasswordOpens && s1.synced && s1.synced.inSync && s1.sameWallet && s1.recordAfterReload.imported && s1.addressAfterReload && s1.syncedAfterReload.inSync));
  } catch (e) {
    await finish(false, e);
  }
}

// ?selftest=buy: Buy BEAM against the real buybeam.my, from this browser.
// No wallet is touched. Reports what each request did (status and size, or
// the exact error and any CSP refusal) so a failure on a device says why.
export async function runBuySelfTest() {
  const root = document.getElementById('app');
  const lines = h('pre', { class: 'mono selftest-log', 'data-testid': 'selftest-log' });
  put(root, h('main', { class: 'screen' }, h('h1', { text: 'Buy BEAM self-test' }), lines));
  const log = (m) => {
    lines.textContent += `${m}\n`;
    console.log('[selftest]', m);
  };
  const ctl = navigator.serviceWorker && navigator.serviceWorker.controller;
  const result = { mode: 'buy', ua: navigator.userAgent, isolated: self.crossOriginIsolated, controller: ctl ? ctl.scriptURL.split('/').pop() : null, steps: {}, csp: [] };
  document.addEventListener('securitypolicyviolation', (e) => result.csp.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
  const { buyApiBase } = await import('./buy/hosts.js');
  const { BuyBeamClient } = await import('./buy/buybeam.js');
  const url = `${buyApiBase()}/assets`;
  const probe = async (label, opts) => {
    try {
      const r = await fetch(url, opts);
      const text = await r.text();
      result.steps[label] = { status: r.status, bytes: text.length, acao: r.headers.get('access-control-allow-origin') };
    } catch (e) {
      result.steps[label] = { error: `${e && e.name}: ${e && e.message}` };
    }
    log(`${label}: ${JSON.stringify(result.steps[label])}`);
  };
  await probe('as the app asks', { method: 'GET', headers: { accept: 'application/json' }, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', mode: 'cors' });
  await probe('plain fetch', {});
  await probe('redirect follow', { headers: { accept: 'application/json' }, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', mode: 'cors' });
  const client = new BuyBeamClient();
  for (const [label, f] of [['client assets', () => client.assets().then((a) => `${a.length} coins`)], ['client limits', () => client.limits().then((l) => JSON.stringify(l).slice(0, 120))]]) {
    try {
      result.steps[label] = { ok: await f() };
    } catch (e) {
      result.steps[label] = { error: `${e && e.name}: ${e && (e.code || e.message)}` };
    }
    log(`${label}: ${JSON.stringify(result.steps[label])}`);
  }
  await new Promise((r) => setTimeout(r, 300));
  log(`csp refusals: ${JSON.stringify(result.csp)}`);
  result.ok = Boolean(result.steps['client assets'] && result.steps['client assets'].ok);
  try {
    await fetch('__dev/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
  } catch (e) {
    log(`could not report: ${e.message}`);
  }
}
