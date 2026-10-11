// Which incoming payments are news, and when a run's payments start being news. A port of BEAM
// Campfire's lib/wallets/beam/wallet/beam_payment_notice.dart and BeamWallet._announceIncoming for
// the web wallet. Pure. What is told and how: lib/notify_rules.js and lib/notify.js.
//
// Rules (the app's):
//   - only a payment that came IN and completed while this wallet was open: income, status 3,
//     a value above 0, a plain payment (tx_type 0) or an offline / max-privacy one (7). Never
//     the wallet's own sends, its change, a split, or a contract call;
//   - the first read of the payment list in a session is history, not news: it is recorded and
//     nothing is announced;
//   - what turns up before the wallet has caught up once in this run is history too: a restore or
//     a Rescan finds past payments as it reads the blocks after BEAM's snapshot (measured: the
//     restored max-privacy throwaway "received" its 0.01 BEAM a second after the restore, while
//     the wallet already said Synced: is_in_sync follows the block headers, the coins come from the
//     block bodies read after them), and a payment made while the app was closed is found the same
//     way after an unlock. So news starts once the wallet is Synced with no block requests left,
//     and 20 s after that (catchUp below); from then on it stays on for the run. The app
//     announces from its first read on; the web wallet does not, so a restore says nothing;
//   - each payment once.
//
// There is no server: nothing watches the wallet while BEAM Campfire is closed (lib/notify.js
// says what is done instead).

/** A completed incoming payment worth announcing. */
export function isNews(tx) {
  if (!tx || tx.income !== true || Number(tx.status) !== 3) return false;
  const type = Number(tx.tx_type);
  if (type !== 0 && type !== 7) return false;
  try {
    return BigInt(tx.value || 0) > 0n;
  } catch {
    return false;
  }
}

export const CATCH_UP_GRACE_MS = 20000;

/** The wallet is up to date and has no sync requests (block bodies included) outstanding. */
export function settled(s) {
  if (!s || !s.running || s.importing || !s.sync || s.sync.state !== 'synced') return false;
  const p = s.progress;
  return !p || !(Number(p.total) > 0) || Number(p.done) >= Number(p.total);
}

/**
 * When a run has caught up: live(s, now) is false until the wallet has first been settled for
 * CATCH_UP_GRACE_MS, then true for the rest of the run (a new block's requests or a node hop do
 * not turn it off again, so a payment completing then is still news). reset() for a new run.
 */
export function catchUp(graceMs = CATCH_UP_GRACE_MS) {
  let since = null;
  return {
    reset() {
      since = null;
    },
    live(s, now = Date.now()) {
      if (since === null && settled(s)) since = now;
      return since !== null && now - since >= graceMs;
    },
  };
}

// ---------------------------------------------------------------- the browser's notifications

/** 'granted' | 'denied' | 'default' | 'unsupported' (no Notification API here: an iPhone's Safari tab, an old browser). */
export function notificationPermission(win = globalThis) {
  const N = win && win.Notification;
  if (typeof N !== 'function' || typeof N.requestPermission !== 'function') return 'unsupported';
  return ['granted', 'denied', 'default'].includes(N.permission) ? N.permission : 'default';
}

export function isIos(nav = globalThis.navigator) {
  if (!nav) return false;
  const ua = String(nav.userAgent || '');
  // iPadOS reports a Mac; it has touch.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1);
}

export function isStandalone(win = globalThis) {
  try {
    return Boolean((win.navigator && win.navigator.standalone) || (win.matchMedia && win.matchMedia('(display-mode: standalone)').matches));
  } catch {
    return false;
  }
}
