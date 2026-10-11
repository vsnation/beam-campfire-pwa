// Notifications, on this device only (the rules: lib/notify_rules.js).
//
//   - While BEAM Campfire runs: every change in the open wallet's payment list worth telling is a
//     banner inside the app when the app is on screen, and a system notification when it is not
//     in front (in the background until the app locks itself; on a computer, another window in
//     front).
//   - When the person leaves the app: a payment still under way is said at once (a regular BEAM
//     payment finishes only while both wallets are online); reminders for later are stored on the
//     device ('w:<id>:notify-reminders' in the app's own store), with the payment list's statuses
//     ('w:<id>:notify-snapshot') for the summary on return. Both go when the wallet is deleted.
//   - Later, with the app closed: the service worker (sw.js) shows the reminders that are due when
//     the browser wakes it (Periodic Background Sync: Chrome / Edge, an installed app). While the
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
import { txWatcher, wordsFor, settingsOf, leavingEvents, remindersFor, dueReminders, awaySummary, snapshotOf, awayLine } from './notify_rules.js';

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

/** One event: the banner while the app is on screen; a system notification while it is not in front. */
export async function tell(app, ev, { banner = true } = {}) {
  const s = settingsOf(app.prefs);
  const w = wordsFor(ev, { label: (id) => wallet.label(id), contractTitle: (tx) => contractLabel(tx), amounts: s.amounts, walletName: await walletName(app) });
  if (visible() && banner && bannerFn) {
    bannerFn(app, w.title, bannerBody(ev, w), w.url);
    stats.banners++;
  }
  if (inFront() || !allowed(app, ev.kind)) return false;
  const ok = await showSystem(w);
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
  const fresh = remindersFor({ txs: wallet.state.txs, privateCoins: await privateCoins(), names: names || [], nearSwaps: near || [], addresses: await expiringAddresses(), labels: settingsOf(app.prefs).amounts, wallet: app.record.id, walletName: await walletName(app), now });
  const carried = before.filter((r) => r && r.at > now && ((names === null && r.id.startsWith('rem-name-')) || (near === null && r.id.startsWith('rem-near-'))));
  const mine = [...fresh, ...carried].filter((r) => allowed(app, r.kind));
  try {
    await rawStore.set(remindersKey(app), mine);
  } catch {
    /* kept in this page only */
  }
  if (mine.length) await askForWakeUps();
  return mine;
}

/** Periodic Background Sync (Chrome / Edge, an installed app): sw.js shows due reminders when woken. */
async function askForWakeUps() {
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

function clearTimers() {
  for (const t of timers.values()) clearTimeout(t);
  timers = new Map();
}

/** A payment that ended: its "still waiting" reminder goes, here and on disk. */
async function dropPaymentReminder(app, txId) {
  const id = `rem-arr-${txId}`;
  if (timers.has(id)) {
    clearTimeout(timers.get(id));
    timers.delete(id);
  }
  try {
    const list = await readReminders(app);
    if (list.some((r) => r && r.id === id)) await rawStore.set(remindersKey(app), list.filter((r) => r && r.id !== id));
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

async function saveSnapshot(app) {
  try {
    await rawStore.set(snapshotKey(app), { at: Date.now(), txs: snapshotOf(wallet.state.txs) });
  } catch {
    /* no summary next time */
  }
}

async function readSnapshot(app) {
  try {
    const v = await rawStore.get(snapshotKey(app));
    return v && v.txs ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- wiring

export function installNotify(app) {
  appRef = app;
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
      const line = snap ? awayLine(awaySummary(snap, s.txs), { amounts: settingsOf(app.prefs).amounts }) : null;
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
