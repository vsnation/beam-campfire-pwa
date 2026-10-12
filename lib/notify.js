// Notifications, on this device only (the rules: lib/notify_rules.js).
//
//   - While BEAM Campfire runs: every change in the open wallet's payment list worth telling is a
//     banner inside the app when the app is on screen, and a system notification when it is not
//     in front (in the background until the app locks itself; on a computer, another window in
//     front).
//   - When the person leaves the app: a payment still under way is said at once (a regular BEAM
//     payment finishes only while both wallets are online); reminders for later are stored on the
//     device ('w:<id>:notify-reminders' in the app's own store, in the clear for the service worker,
//     so they name nothing: "A payment is still waiting"), with the payment list's statuses
//     ('w:<id>:notify-snapshot', sealed under the wallet's secret: which payments are this wallet's
//     is its private history) for the summary on return. Both go when the wallet is deleted.
//   - Later, with the app closed, only when the person turned "Reminders when BEAM Campfire is
//     closed" on (prefs.notify.wakeUps): the service worker (sw.js) shows the reminders that are due
//     when the browser wakes it (Periodic Background Sync: Chrome / Edge, an installed app). Off by
//     default, because each wake-up is also a moment the browser checks the loader for new bytes
//     while no BEAM Campfire page is open to notice a change it did not sign (lib/loader.js). While the
//     page itself still runs in the background, it shows them on time. iPhone runs no web app in
//     the background: there notifications come while the app is open, and Home says what happened
//     while it was not.
//   - Back in the app: the app badge is cleared and Home says what happened while away.
//   - A tap on a notification opens the app at the payment or screen it names (#open=…; sw.js).
//
// Nothing is sent anywhere: no server, no push service. The browser shows what the app tells it.

import { wallet, contractLabel, ADDRESS_COMMENT } from './wallet.js';
import { rawStore } from './store.js';
import { walletKey } from './wallet_scope.js';
import { listWallets, nameOf } from './wallets.js';
import { catchUp, notificationPermission } from './payment_notice.js';
import { isSplitTx, readAllCoins, parseCoin, privateReady, PRIVATE_LIMIT_HOURS } from './coins.js';
import { listOwn, expiresAtMs, cleanLabel } from './addresses.js';
import { txWatcher, wordsFor, settingsOf, leavingEvents, remindersFor, plainReminders, dueReminders, awaySummary, snapshotOf, awayLine, underway } from './notify_rules.js';
import { randomBytes, b64, unb64, dbPassKey, dbPassKdf, KDF_PBKDF2, PBKDF2_MIN_ITERATIONS, PBKDF2_MAX_ITERATIONS } from './envelope.js';
import { oneTab } from './one_tab.js';

export const SYNC_TAG = 'campfire-reminders';
const ICON = 'icons/icon-192.png';
const remindersKey = (app) => walletKey(app, 'notify-reminders');
const snapshotKey = (app) => walletKey(app, 'notify-snapshot');

// What was told in this page's life (counts only, for the tests).
const stats = { banners: 0, system: 0, failed: 0, reminders: 0, badge: 0 };
export const notifyStats = () => ({ ...stats });

let bannerFn = null; // screens/payment_notices.js showBanner (the banner over any screen)
// The open wallet's names and unpaid NEAR swaps, once a screen has read them in this run; null:
// not read, so the reminders stored for them earlier are kept as they are.
let names = null;
let near = null;
let timers = new Map(); // reminder id -> timeout, while the page runs in the background
let toldLeaving = new Set(); // payments already said "under way" in this run
let waitingTx = new Set(); // the payments the stored "still waiting" reminder is about (its id names none)
let unseen = 0;
let appRef = null;

/** The banner inside the app (screens/payment_notices.js draws it). */
export function setBanner(fn) {
  bannerFn = fn;
}

/** screens/names.js: the open wallet's names and when each expires (ms), for reminders before. */
export function rememberNames(list) {
  names = (list || []).filter((n) => n && n.name && Number.isFinite(n.expiresAt));
}

/** screens/near_intents*.js: unpaid swaps and when their deposit addresses stop taking coins. */
export function rememberNearSwaps(list) {
  near = (list || [])
    .filter((s) => s && s.quote && s.quote.sendBefore && (s.lastState == null || s.lastState === 'PENDING_DEPOSIT'))
    .map((s) => ({ id: String(s.quote.depositAddress || s.createdAt), symbol: s.origin.symbol, sendBefore: s.quote.sendBefore }));
}

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
/** In front: on screen, and (on a computer) its window has the focus. */
const inFront = () => visible() && (typeof document.hasFocus !== 'function' || document.hasFocus());

async function walletName(app) {
  try {
    return (await listWallets()).length > 1 ? nameOf(app.record) : null;
  } catch {
    return null;
  }
}

/** The system notification: through the service worker (sw.js opens the app at `url` on a tap); a page Notification otherwise. */
export async function showSystem({ title, body, tag, url }) {
  const opts = { body, tag: `campfire-${tag}`, icon: ICON, lang: 'en', data: { url: url || '#open=home' } };
  try {
    const reg = typeof navigator !== 'undefined' && navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && typeof reg.showNotification === 'function') {
      await reg.showNotification(title, opts);
      stats.system++;
      return true;
    }
  } catch {
    /* the page's own, below */
  }
  try {
    const n = new Notification(title, opts);
    n.addEventListener('click', () => {
      try {
        window.focus();
      } catch {
        /* nothing to focus */
      }
      openTarget(opts.data.url);
      n.close();
    });
    stats.system++;
    return true;
  } catch {
    stats.failed++;
    return false;
  }
}

function badge(n) {
  stats.badge = n;
  try {
    if (n > 0 && typeof navigator.setAppBadge === 'function') navigator.setAppBadge(n).catch(() => {});
    else if (n === 0 && typeof navigator.clearAppBadge === 'function') navigator.clearAppBadge().catch(() => {});
  } catch {
    /* no badge here */
  }
}

/** Whether a system notification of this kind may be shown. */
export function allowed(app, kind) {
  const s = settingsOf(app.prefs);
  return s.on && s.kinds[kind] !== false && notificationPermission() === 'granted';
}

/** A private payment says when it can be spent. */
function bannerBody(ev, w) {
  const tx = ev.tx;
  if (ev.type === 'received' && tx && Number(tx.tx_type) === 7 && tx.address_type === 'max_privacy') return `It arrived privately: you can spend it within ${PRIVATE_LIMIT_HOURS} hours.`;
  return w.body;
}

/**
 * One event: the banner while the app is on screen (with the amount: the open wallet shows it
 * anyway); a system notification while it is not in front, with the amount only if the person
 * turned that on (it shows on the lock screen).
 */
export async function tell(app, ev, { banner = true } = {}) {
  const s = settingsOf(app.prefs);
  const opts = { label: (id) => wallet.label(id), contractTitle: (tx) => contractLabel(tx), walletName: await walletName(app) };
  if (visible() && banner && bannerFn) {
    const b = wordsFor(ev, { ...opts, amounts: true });
    bannerFn(app, b.title, bannerBody(ev, b), b.url);
    stats.banners++;
  }
  if (inFront() || !allowed(app, ev.kind)) return false;
  const ok = await showSystem(wordsFor(ev, { ...opts, amounts: s.amounts }));
  if (ok) badge(++unseen);
  return ok;
}

/**
 * What the app's other parts tell (not a BEAM payment): a bridge crossing ready to collect or
 * arrived, money paid to a BEAM name. kind: one of KINDS; plainBody: body without amounts;
 * banner: also the banner when on screen.
 */
export function tellOther(app, { kind, title, body, plainBody = null, tag, url = '#open=home', banner = false }) {
  return tell(app, { kind, type: 'free', title, body, plainBody, tag, url }, { banner });
}

// ---------------------------------------------------------------- where a tap opens

const OPENABLE = new Set(['home', 'activity', 'coins', 'addresses', 'names', 'nearIntents', 'bridgeList', 'settings', 'notifications']);

/** "#open=activity&tx=…" -> { screen, params }. Only the app's own screens; anything else is ignored. */
export function parseOpen(url) {
  const m = /^#open=([a-zA-Z]+)(?:&tx=([0-9a-f]{1,128}))?$/.exec(String(url || ''));
  if (!m || !OPENABLE.has(m[1])) return null;
  return { screen: m[1], params: m[2] ? { txId: m[2] } : {} };
}

/** Opens what a tap asked for: now when a wallet is open, else right after the unlock (screens/unlock.js). */
function openTarget(url) {
  const t = parseOpen(url);
  if (!t || !appRef) return;
  if (appRef.dbPass) return appRef.go(t.screen, t.params);
  appRef.afterUnlock = { name: t.screen, params: t.params, lead: 'Unlock to see what the notification was about. ', note: 'BEAM Campfire opens it once the wallet is open.' };
  if (appRef.currentName === 'unlock') appRef.go('unlock'); // shows the line saying so
}

// ---------------------------------------------------------------- reminders for later

/** Private coins BEAM still holds back, and when each can be spent at the latest (lib/coins.js privateReady). */
async function privateCoins() {
  try {
    const tip = Number(wallet.state.status && wallet.state.status.current_height) || 0;
    if (!tip || !wallet.session) return [];
    const all = await readAllCoins(
      async (skip, count) => {
        const r = await wallet.session.call('get_utxo', { skip, count }, { timeoutMs: 5000 });
        return (Array.isArray(r) ? r : []).map(parseCoin);
      },
      { maxPages: 10 },
    );
    const now = Date.now();
    return all
      .filter((c) => c.shielded && c.status === 'maturing')
      .map((c) => ({ id: c.id, ready: privateReady(c, tip) }))
      .filter((c) => c.ready.known && c.ready.block > tip)
      .map((c) => ({ id: c.id, spendableAt: now + (c.ready.block - tip) * 60000 }));
  } catch {
    return [];
  }
}

/** This wallet's addresses that expire, with when (ms) and their label. */
async function expiringAddresses() {
  try {
    if (!wallet.session) return [];
    return (await listOwn(wallet.session)).filter((a) => !a.expired && expiresAtMs(a) !== null).map((a) => ({ address: a.address, expiresAt: expiresAtMs(a), label: cleanLabel(a.comment) === ADDRESS_COMMENT ? '' : cleanLabel(a.comment) }));
  } catch {
    return [];
  }
}

async function readReminders(app) {
  try {
    return (await rawStore.get(remindersKey(app))) || [];
  } catch {
    return [];
  }
}

/** Replace this wallet's reminders, keeping those for names / swaps no screen read in this run. */
async function leaveReminders(app) {
  if (!app.record) return [];
  const before = await readReminders(app);
  const now = Date.now();
  waitingTx = new Set(underway(wallet.state.txs).map((t) => t.txId));
  const fresh = remindersFor({ txs: wallet.state.txs, privateCoins: await privateCoins(), names: names || [], nearSwaps: near || [], addresses: await expiringAddresses(), now });
  const carried = before.filter((r) => r && r.at > now && ((names === null && r.id.startsWith('rem-name-')) || (near === null && r.id.startsWith('rem-near-'))));
  const mine = [...fresh, ...carried].filter((r) => allowed(app, r.kind));
  try {
    await rawStore.set(remindersKey(app), mine);
  } catch {
    /* kept in this page only */
  }
  if (mine.length) await askForWakeUps(app);
  return mine;
}

/** Whether the person turned on reminders while BEAM Campfire is closed (Settings -> Notifications). Off by default. */
export const wakeUpsOn = (prefs) => Boolean(prefs && prefs.notify && prefs.notify.wakeUps === true);
/** Wake-ups are asked for only with that switch and notifications both on. */
const wakeUpsWanted = (prefs) => wakeUpsOn(prefs) && settingsOf(prefs).on;

/** Whether this browser can wake an installed app for them (Periodic Background Sync: Chrome / Edge). */
export function wakeUpsSupported() {
  return typeof window !== 'undefined' && 'PeriodicSyncManager' in window && typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker);
}

/** Periodic Background Sync, only when turned on: sw.js shows due reminders when woken. */
async function askForWakeUps(app) {
  if (!wakeUpsWanted(app && app.prefs)) return dropWakeUps();
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.periodicSync) return false;
    if (navigator.permissions) {
      const st = await navigator.permissions.query({ name: 'periodic-background-sync' }).catch(() => null);
      if (st && st.state === 'denied') return false;
    }
    await reg.periodicSync.register(SYNC_TAG, { minInterval: 15 * 60 * 1000 });
    return true;
  } catch {
    return false;
  }
}

/** No more wake-ups (turned off, or never turned on: an earlier release asked for them by itself). */
async function dropWakeUps() {
  try {
    const reg = typeof navigator !== 'undefined' && navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && reg.periodicSync) await reg.periodicSync.unregister(SYNC_TAG);
  } catch {
    /* none asked for */
  }
  return false;
}

/** Settings -> Notifications: after "Reminders when BEAM Campfire is closed" or the main switch changed (and was saved). */
export function applyWakeUps(app) {
  return askForWakeUps(app);
}

function clearTimers() {
  for (const t of timers.values()) clearTimeout(t);
  timers = new Map();
}

/** A payment that ended: once none of those the "still waiting" reminder was about is left, it goes, here and on disk. */
async function dropPaymentReminder(app, txId) {
  if (!waitingTx.delete(txId) || waitingTx.size) return;
  for (const [id, t] of timers) {
    if (!id.startsWith('rem-arr-')) continue;
    clearTimeout(t);
    timers.delete(id);
  }
  try {
    const list = await readReminders(app);
    if (list.some((r) => r && r.id.startsWith('rem-arr-'))) await rawStore.set(remindersKey(app), list.filter((r) => r && !r.id.startsWith('rem-arr-')));
  } catch {
    /* sw.js shows nothing for it once the page says so on return */
  }
}

/** While the page still runs in the background: each reminder on time, then forgotten. */
function armTimers(app, list) {
  clearTimers();
  for (const r of list) {
    const ms = r.at - Date.now();
    if (ms < 0 || ms > 2 ** 31 - 1) continue;
    timers.set(
      r.id,
      setTimeout(async () => {
        timers.delete(r.id);
        if (inFront() || !allowed(app, r.kind)) return;
        if (!(await showSystem({ title: r.title, body: r.body, tag: r.id, url: r.url }))) return;
        stats.reminders++;
        badge(++unseen);
        try {
          await rawStore.set(remindersKey(app), (await readReminders(app)).filter((x) => x && x.id !== r.id));
        } catch {
          /* sw.js drops it once due */
        }
      }, ms),
    );
  }
}

/** Back in the app: due reminders, and those about payments under way, go (the app tells those itself now). */
async function dropOnReturn(app) {
  if (!app.record) return;
  try {
    const { keep } = dueReminders(await readReminders(app));
    await rawStore.set(remindersKey(app), keep.filter((r) => !r.id.startsWith('rem-arr-')));
  } catch {
    /* nothing kept */
  }
}

/** Turned off: nothing stored for later is shown. */
export async function forgetReminders(app) {
  clearTimers();
  try {
    if (app.record) await rawStore.set(remindersKey(app), []);
  } catch {
    /* none kept */
  }
}

// ---------------------------------------------------------------- what happened while away

let away = null;
/** Home's line: what happened while the person was away, for the open wallet; null when nothing did. */
export const awayNow = () => away;
export function dismissAway() {
  away = null;
}

// The snapshot, sealed: AES-256-GCM under a key made from the wallet's secret (app.dbPass) as every
// other sealed record is (lib/envelope.js dbPassKey: HKDF for a random secret, PBKDF2 for an imported
// wallet's password), its own info string, a random salt and IV; the header with the wallet id is
// additional data, so a copy moved to another wallet or edited does not open. It is written and read
// only while the wallet is open. The key is made once per unlock (PBKDF2 is slow on a phone).
export const NOTIFY_INFO = 'beam-campfire-notify-v1';
const SNAP_KIND = 'notify-snapshot';
const enc = new TextEncoder();
const dec = new TextDecoder();
const snapAad = (h) => enc.encode(JSON.stringify([h.v, h.kind, h.walletId, h.kdf, h.iterations || 0, h.salt]));
// The keys made under one secret (header -> CryptoKey), this unlock only; another secret starts over.
let snapKeys = { dbPass: null, keys: new Map() };

function snapKey(dbPass, h) {
  if (snapKeys.dbPass !== dbPass) snapKeys = { dbPass, keys: new Map() };
  const { keys } = snapKeys;
  const id = JSON.stringify([h.walletId, h.kdf, h.iterations || 0, h.salt]);
  if (!keys.has(id)) {
    const p = dbPassKey(h, dbPass, NOTIFY_INFO);
    p.catch(() => keys.get(id) === p && keys.delete(id));
    keys.set(id, p);
  }
  return keys.get(id);
}

/** Forgets the snapshot keys and the secret they were made under (the lock). */
export function forgetSnapshotKeys() {
  snapKeys = { dbPass: null, keys: new Map() };
}

/** {at, txs} sealed for wallet `walletId` (imported: its secret is a password) under `dbPass`. reuse: an earlier record's header. */
export async function sealSnapshot(dbPass, { walletId, imported }, snap, reuse = null) {
  const kdf = dbPassKdf(imported);
  // The earlier record's salt (and rounds) are kept, so its key, made once per unlock, serves again;
  // a record that is not this wallet's, or asks for rounds out of bounds, is replaced by a fresh one.
  const fits = reuse && reuse.walletId === walletId && reuse.kdf === kdf && typeof reuse.salt === 'string' && (kdf !== KDF_PBKDF2 || (Number.isSafeInteger(reuse.iterations) && reuse.iterations >= PBKDF2_MIN_ITERATIONS && reuse.iterations <= PBKDF2_MAX_ITERATIONS));
  const h = fits ? { v: 1, kind: SNAP_KIND, walletId, kdf, ...(kdf === KDF_PBKDF2 ? { iterations: reuse.iterations } : {}), salt: reuse.salt } : { v: 1, kind: SNAP_KIND, walletId, kdf, ...(kdf === KDF_PBKDF2 ? { iterations: PBKDF2_MIN_ITERATIONS } : {}), salt: b64(randomBytes(16)) };
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: snapAad(h) }, await snapKey(dbPass, h), enc.encode(JSON.stringify(snap)));
  return { ...h, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

/** The snapshot back, or null: none, locked, another wallet's, the wrong key derivation, edited. */
export async function openSnapshot(dbPass, { walletId, imported }, env) {
  if (!env || typeof env !== 'object' || env.v !== 1 || env.kind !== SNAP_KIND || env.walletId !== walletId || env.kdf !== dbPassKdf(imported)) return null;
  if (typeof dbPass !== 'string' || !dbPass || typeof env.salt !== 'string' || typeof env.iv !== 'string' || typeof env.ct !== 'string') return null;
  const h = { v: 1, kind: SNAP_KIND, walletId, kdf: env.kdf, ...(env.kdf === KDF_PBKDF2 ? { iterations: env.iterations } : {}), salt: env.salt };
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: snapAad(h) }, await snapKey(dbPass, h), unb64(env.ct));
    const v = JSON.parse(dec.decode(pt));
    return v && v.txs && typeof v.txs === 'object' ? v : null;
  } catch {
    return null;
  }
}

const sealedFor = (app) => ({ walletId: app.record.id, imported: Boolean(app.record.imported) });

async function saveSnapshot(app) {
  try {
    if (!app.dbPass || !app.record) return;
    const key = snapshotKey(app);
    const dbPass = app.dbPass;
    const who = sealedFor(app);
    const snap = { at: Date.now(), txs: snapshotOf(wallet.state.txs) };
    const before = await rawStore.get(key);
    const sealed = await sealSnapshot(dbPass, who, snap, before && before.kind === SNAP_KIND ? before : null);
    // Locked or switched while the key was made: nothing is written for a wallet no longer open.
    if (app.dbPass !== dbPass || !app.record || app.record.id !== who.walletId) return;
    await rawStore.set(key, sealed);
  } catch {
    /* no summary next time */
  }
}

async function readSnapshot(app) {
  try {
    if (!app.dbPass || !app.record) return null;
    return await openSnapshot(app.dbPass, sealedFor(app), await rawStore.get(snapshotKey(app)));
  } catch {
    return null;
  }
}

/**
 * At start: what an earlier version left in the clear goes. Snapshots that list payment ids and
 * statuses (they are sealed now), and reminders that named the payment, coin, name, address,
 * deposit address or wallet (rewritten in words that name nothing, at the same times).
 */
export async function forgetPlainNotes(kv = rawStore) {
  let changed = 0;
  for (const k of await kv.keys('w:')) {
    if (/^w:[0-9a-f]{16}:notify-snapshot$/.test(k)) {
      const v = await kv.get(k);
      if (v && v.kind !== SNAP_KIND) {
        await kv.del(k);
        changed++;
      }
    } else if (/^w:[0-9a-f]{16}:notify-reminders$/.test(k)) {
      const list = await kv.get(k);
      if (!Array.isArray(list)) continue;
      const plain = plainReminders(list);
      if (JSON.stringify(plain) !== JSON.stringify(list)) {
        await kv.set(k, plain);
        changed++;
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------- wiring

export function installNotify(app) {
  appRef = app;
  if (app.lockHooks) app.lockHooks.add(forgetSnapshotKeys);
  // Start-up tidying that touches the app's store: only in the tab that holds the wallet
  // (lib/one_tab.js), once it does; a second tab opens no storage at all.
  oneTab().whenHeld(() => {
    if (typeof indexedDB !== 'undefined') forgetPlainNotes().catch(() => {});
    // An earlier release asked for wake-ups by itself; now only the switch does.
    rawStore
      .get('prefs')
      .then((p) => (wakeUpsWanted(p) ? null : dropWakeUps()))
      .catch(() => {});
  });
  const watch = txWatcher();
  const run = catchUp();
  let summarised = false;

  wallet.onChange(async (s) => {
    // Stopped (locked, another wallet, a restart): the next run starts over; its names and swaps are its own.
    if (!s.running) {
      watch.reset();
      run.reset();
      summarised = false;
      toldLeaving = new Set();
      waitingTx = new Set();
      names = null;
      near = null;
      away = null;
      return;
    }
    // Locked: nothing is shown on the unlock screen (told once unlocked); out of front, a wallet kept
    // running behind the lock for a payment under way still notifies how it ends.
    const locked = !app.dbPass;
    if (locked && (!wallet.lockedRun || inFront())) return;
    const live = run.live(s);
    // Caught up: what happened while away, against the statuses saved when the person last left.
    if (!locked && live && !summarised && s.txsLoaded === true) {
      summarised = true;
      const snap = await readSnapshot(app);
      // On Home, in the open wallet: with the amounts.
      const line = snap ? awayLine(awaySummary(snap, s.txs), { amounts: true }) : null;
      saveSnapshot(app);
      dropOnReturn(app);
      if (line) {
        away = line;
        wallet.emit();
      }
    }
    const events = watch.update(s.txs, s.txsLoaded === true, live).filter((e) => !(e.type === 'sent' && isSplitTx(e.tx)));
    if (!events.length) return;
    for (const e of events) if (e.tx) dropPaymentReminder(app, e.tx.txId);
    // In the app, the banner tells what the person did not do themselves (money in, a failure); a
    // payment they sent or a swap has its own status screen. Out of it, each is a notification,
    // and many at once are one.
    if (events.length > 3 && !inFront()) {
      tell(app, { kind: 'in', type: 'several', title: `${events.length} changes in your wallet`, count: events.length }, { banner: false });
      return;
    }
    for (const ev of events) tell(app, ev, { banner: !locked && (ev.type === 'received' || ev.type === 'failed' || ev.type === 'contractFailed') });
  });

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', async () => {
      if (visible()) {
        unseen = 0;
        badge(0);
        clearTimers();
        if (app.dbPass && app.record) dropOnReturn(app);
        return;
      }
      if (!app.dbPass || !wallet.session || !wallet.state.running) return;
      // Leaving: what still needs the app, at once; the statuses for the summary; reminders for later.
      for (const ev of leavingEvents(wallet.state.txs)) {
        // Once per payment and run: going back and forth does not say it again.
        if (toldLeaving.has(ev.tx.txId)) continue;
        toldLeaving.add(ev.tx.txId);
        tell(app, ev, { banner: false });
      }
      saveSnapshot(app);
      armTimers(app, await leaveReminders(app));
    });
  }
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'campfire-open') openTarget(e.data.url);
    });
  }
  // Opened by a tap on a notification while the app was closed (sw.js openWindow).
  if (typeof location !== 'undefined' && /^#open=/.test(location.hash)) {
    openTarget(location.hash);
    try {
      history.replaceState(history.state, '', location.pathname + location.search);
    } catch {
      /* the hash stays */
    }
  }
}

/** The app object notifications were installed with (the e2e harness tells through it). */
export const notifyApp = () => appRef;

/** Settings → Notifications: "Send a test notification". */
export function testNotification() {
  return showSystem({ title: 'BEAM Campfire notifications are on', body: 'A payment will be told like this.', tag: 'test', url: '#open=notifications' });
}
