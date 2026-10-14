// The service worker ("loader") seen from the page: the first install, and the
// tripwire that watches for code BEAM Campfire did not sign.
//
// The loader's file name is content-addressed (sw-<hash>.js, LOADER in
// version.js) and the file carries nothing release-specific, so a legitimate
// deployment never changes the bytes at a loader URL a phone has registered:
// a new loader always comes under a new name, and the page registers it only
// after an Update the person approved. The browser still re-fetches the
// registered URL on its own (about once a day; no web API turns that off).
// Down, 404, 5xx or a parking page there changes nothing: the installed loader
// and its verified copy stay. A different script there installs - nothing can
// stop that - so the page treats any new worker for the URL it already runs
// under as a takeover: it locks the wallet at once and says so.
//
// The watch starts before anything else of the page: index.html's classic
// loader-watch.js records every loader change from the first line (and stops a
// page that is taken over before the app has started), and watchLoader()
// replays that record and follows it.
//
// Best effort, stated plainly in About and docs/beam/PWA.md: a page opened
// after a takeover is served by the new code, and that code can show anything.
// That includes a takeover while no page is open (the browser checks the
// loader then too).
//
// An update that came from another copy while the app's own address was down
// (lib/update_sources.js) runs under the loader the device already has, since
// a service worker comes only from its own address. The page moves to its own
// loader later, when a tapped Check for updates finds that address serving the
// installed release again. Every move first checks that the address serves the
// loader's signed bytes to the page (loaderServed), and checks again once the
// page runs under it (checkMovedLoader). Neither is a guarantee: the browser
// fetches a loader itself to install it and no web API lets a page see or
// choose those bytes, so an address can answer that one request differently,
// and a worker already in control can answer the page's checks itself.

import { LOADER, LOADER_COMPAT, BUILT } from './version.js';
import { t } from './i18n.js';

const META_CACHE = 'campfire-meta';
const PROGRESS_KEY = '__campfire_install';
const RELOAD_KEY = 'campfire-sw-reload';
// A move to this release's loader not yet checked from the page that runs under it: {path, sha256, at}.
const MOVE_CHECK_KEY = 'campfire-loader-check';
const DAY_MS = 86400000;

export const INTEGRITY_CODES = new Set(['bad_signature', 'manifest_mismatch', 'file_mismatch', 'malformed', 'downgrade']);

export function swSupported() {
  return 'serviceWorker' in navigator;
}

// What loader-watch.js recorded from the page's first line (null in a page without it).
const early = typeof window !== 'undefined' && window.__campfireLoaderWatch ? window.__campfireLoaderWatch : null;

// The loader that served this document (as loader-watch.js saw it before any
// module ran). Its headers (the CSP) stay in force for the life of the page,
// even after a newer loader takes over.
const servedBy = early ? early.initial : typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null;

// This release's loader_compat (null in an unbuilt tree), and whether the loader
// that served this document said it has the same one (checkServedLoader()).
const RELEASE_COMPAT = BUILT ? LOADER_COMPAT : null;
let servedCompat = null;

/**
 * Pure: is a page still running under headers older than its release's
 * loader's? Not when it was served by that loader, and not when the loader
 * that served it does the same to pages (equal loader_compat: same headers,
 * so nothing this release needs is refused).
 * @param {{servedBy: string|null, loader: string, servedCompat: string|null, releaseCompat: string|null}} p
 */
export function isLoaderBehind({ servedBy: by, loader, servedCompat: sc, releaseCompat }) {
  if (!by) return false;
  if (String(by).split('?')[0].endsWith(`/${loader}`)) return false;
  return !(sc && releaseCompat && sc === releaseCompat);
}

/**
 * True while this page runs under an older loader's headers: an Update that
 * brought a new loader is not finished until the page is loaded again under it.
 * Hosts this release added (buybeam.my, Ethereum servers, dApps) are refused
 * until then. A loader that serves pages exactly like the release's own is not
 * behind; until the running loader has said so (checkServedLoader) this
 * answers from the names alone.
 */
export function loaderBehind() {
  return isLoaderBehind({ servedBy, loader: LOADER, servedCompat, releaseCompat: RELEASE_COMPAT });
}

/**
 * Asks the loader that served this document for its loader_compat and keeps it
 * when it is the same loader. Returns loaderBehind() afterwards.
 */
export async function checkServedLoader() {
  if (!servedBy || endsWithLoader(servedBy)) return loaderBehind();
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!sw || sw.scriptURL !== servedBy) return loaderBehind();
  try {
    const st = await askLoader({ type: 'status' }, { timeoutMs: 10000 });
    if (st && typeof st.compat === 'string' && st.loader === servedBy.split('?')[0].split('/').pop()) servedCompat = st.compat;
  } catch {
    /* an older loader, or no answer: decided by the names */
  }
  return loaderBehind();
}

export function isControlled() {
  return Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);
}

/**
 * One request to the running loader over a MessageChannel. Messages with a
 * `progress` field go to onProgress, and each of them restarts the timeout.
 */
export function askLoader(msg, { timeoutMs = 120000, onProgress = null, slowMessage = t('The update check took too long.') } = {}) {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!sw) return Promise.reject(new Error(t('The app is not running from its verified copy yet.')));
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reject(new Error(slowMessage)), timeoutMs);
    };
    ch.port1.onmessage = (e) => {
      if (e.data && e.data.progress) {
        arm();
        if (onProgress) onProgress(e.data.progress);
        return;
      }
      clearTimeout(timer);
      resolve(e.data);
    };
    arm();
    sw.postMessage(msg, [ch.port2]);
  });
}

// A loader's file name: sw-<16 hex of its SHA-256>.js.
const LOADER_NAME = /^sw-[0-9a-f]{16}\.js$/;

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The bytes this app's address serves under the loader name `path`, compared
 * with the signed SHA-256 (from the release's manifest; without it, the hash
 * prefix the content-addressed name carries). 'same', 'other', or 'unknown'
 * (no answer, an error status, or - asked asInstall - not a script, which the
 * browser would not install either). asInstall asks the way the browser asks
 * when it installs a loader (Service-Worker: script), as near as a page can:
 * the browser's own request also says Sec-Fetch-Dest: serviceworker, which no
 * page can send.
 */
export async function loaderBytes(path, sha256 = null, { asInstall = false, timeoutMs = 15000 } = {}) {
  if (!LOADER_NAME.test(String(path))) return 'unknown';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let bytes;
  try {
    // No cookies: the app sets none, and one set for the parent domain must not decide the answer.
    const r = await fetch(new URL(path, document.baseURI).href, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers: asInstall ? { 'Service-Worker': 'script' } : {}, signal: ctl.signal });
    if (!r.ok) return 'unknown';
    if (asInstall && !/javascript|ecmascript/i.test(r.headers.get('content-type') || '')) return 'unknown';
    bytes = await r.arrayBuffer();
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
  const got = hex(await crypto.subtle.digest('SHA-256', bytes));
  return (sha256 ? got === sha256 : got.startsWith(path.slice(3, 19))) ? 'same' : 'other';
}

/**
 * Whether this app's address serves the loader file `path` with the signed
 * bytes, asked by the page. A pre-check before a loader replaces another, not
 * a guarantee: the browser fetches the loader again itself to install it, and
 * the address can answer that request differently (checkMovedLoader looks
 * again once the page runs under it).
 */
export async function loaderServed(path, sha256 = null) {
  return (await loaderBytes(path, sha256)) === 'same';
}

function readMoveCheck() {
  try {
    const v = JSON.parse(localStorage.getItem(MOVE_CHECK_KEY) || 'null');
    return v && typeof v.path === 'string' && LOADER_NAME.test(v.path) && typeof v.at === 'number' ? v : null;
  } catch {
    return null;
  }
}

function writeMoveCheck(v) {
  try {
    if (v) localStorage.setItem(MOVE_CHECK_KEY, JSON.stringify(v));
    else localStorage.removeItem(MOVE_CHECK_KEY);
  } catch {
    /* private mode: the check after the move is skipped */
  }
}

/**
 * After a move to this release's loader (or, path given, to the loader another
 * window of this app recorded): what the address serves under its name now,
 * asked the way the browser asked to install it, against the signed hash noted
 * before the move. 'other' means the browser may have installed bytes BEAM
 * Campfire did not sign. Best effort (see loaderBytes; and a worker that
 * controls this page can answer this request itself). Other bytes, or a day,
 * end the record; a good answer keeps it, so a window whose takeover arrives
 * later (a frozen or suspended one) still finds the move expected and checks
 * the same signed hash itself (re-audit RE2-4).
 */
export async function checkMovedLoader(now = Date.now(), path = LOADER) {
  const p = readMoveCheck();
  if (!p || p.path !== path) return 'unknown';
  const v = await loaderBytes(path, typeof p.sha256 === 'string' ? p.sha256 : null, { asInstall: true });
  if (v === 'other' || now - p.at > DAY_MS) writeMoveCheck(null);
  return v;
}

const endsWithName = (url, name) => typeof url === 'string' && url.split('?')[0].endsWith(`/${name}`);
const endsWithLoader = (url) => endsWithName(url, LOADER);

/**
 * The loader another window of this app is moving to: moveToLoader() there
 * recorded it (shared localStorage) before registering it, after the address
 * served its signed bytes. Null when none is recorded, the record is older
 * than a day, or this page already runs under it (then a new worker for it is
 * a takeover).
 */
function movingElsewhere(controllerUrl, now = Date.now()) {
  const p = readMoveCheck();
  if (!p || now - p.at > DAY_MS || endsWithName(controllerUrl, p.path)) return null;
  return p.path;
}

/** First install (or a retry after it stopped). Returns the registration. */
export function registerLoader() {
  return navigator.serviceWorker.register(LOADER, { scope: './', updateViaCache: 'none' });
}

/** The install progress the service worker writes (see sw.js writeProgress). */
export async function readInstallProgress() {
  try {
    const c = await caches.open(META_CACHE);
    const r = await c.match(new URL(PROGRESS_KEY, document.baseURI).href);
    return r ? await r.json() : null;
  } catch {
    return null;
  }
}

/** One reload after the first install, so every file is served from the verified copy. */
export function reloadOnceIntoVerifiedCopy() {
  if (sessionStorage.getItem(RELOAD_KEY) === '1') return false;
  sessionStorage.setItem(RELOAD_KEY, '1');
  location.reload();
  return true;
}

export function clearReloadFlag() {
  sessionStorage.removeItem(RELOAD_KEY);
}

/** A hard reload (Shift+Reload) over an installed copy is not controlled; carry on once rather than loop. */
export async function installedButBypassed() {
  if (sessionStorage.getItem(RELOAD_KEY) !== '1') return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return Boolean(reg && reg.active);
}

/**
 * While this release's loader waits behind an older one, asks it to take over
 * (every 2 s, for a minute). Its own skipWaiting() at install can be dropped
 * by Chrome when the older loader is busy with the reload that follows an
 * Update; without this the move took five minutes, and until then the page
 * ran under the older loader's headers.
 */
function askToTakeOver(reg) {
  if (!reg) return;
  const sw = navigator.serviceWorker;
  let tries = 0;
  const tick = () => {
    if (endsWithLoader(sw.controller && sw.controller.scriptURL) || ++tries > 30) return;
    const w = reg.waiting;
    if (w && endsWithLoader(w.scriptURL)) w.postMessage({ type: 'skip-waiting' });
    setTimeout(tick, 2000);
  };
  tick();
}

/**
 * Starts the tripwire. Call once, on a page served by the verified copy.
 * onIntrusion(reason) runs at most once.
 */
export async function watchLoader({ onIntrusion, onMoved = () => {} }) {
  const sw = navigator.serviceWorker;
  if (!sw || !sw.controller) return;
  let fired = false;
  const fire = (reason) => {
    if (fired) return;
    fired = true;
    onIntrusion(reason);
  };
  // loader-watch.js already stopped this page: say so here too (it never reloads).
  // The reasons below are logged and kept in app.intrusion for the e2e harness; the tripwire screen
  // does not show them (screens/problem.js). i18n-ignore: tripwire reasons for logs and tests
  if (early && early.stopped()) return fire('the loader that served this page was replaced while it started');
  // A worker for LOADER is expected only while the page is moving to it from an
  // older loader (after an approved Update). Anything else is a change of code
  // at a URL whose bytes never change legitimately.
  let controllerUrl = early && early.initial ? early.initial : sw.controller.scriptURL;
  // Also expected: the loader another window of this app recorded before it registered it, after
  // an Update approved there (audit UPD-6: a false alarm here trains people to ignore a real one).
  const elsewhere = (url) => {
    const path = movingElsewhere(controllerUrl);
    return path && endsWithName(url, path) ? path : null;
  };
  const expected = (url) => (endsWithLoader(url) && !endsWithLoader(controllerUrl)) || Boolean(elsewhere(url));
  const check = (url) => {
    if (url && !expected(url)) fire(`a new service worker (${url.split('/').pop()}) is being installed`); // i18n-ignore: a tripwire reason for logs and tests
  };
  const movedOther = "this app's address serves other code under the new loader's name than BEAM Campfire signed"; // i18n-ignore: a tripwire reason for logs and tests
  const changed = (now) => {
    const own = endsWithLoader(now) && !endsWithLoader(controllerUrl);
    const other = own ? null : elsewhere(now);
    controllerUrl = now;
    if (!own && !other) return fire('the service worker controlling this page changed'); // i18n-ignore: a tripwire reason for logs and tests
    // Moved to this release's loader, or to the one another window recorded: look at what was
    // installed before anything reloads into it.
    (own ? checkMovedLoader() : checkMovedLoader(Date.now(), other)).then((v) => (v === 'other' ? fire(movedOther) : onMoved()));
  };
  if (early && early.initial) {
    // Everything since the page's first line, then each new event: nothing between the two is missed.
    early.subscribe((ev) => (ev.type === 'controllerchange' ? changed(ev.url) : check(ev.url)));
  } else {
    // A page without loader-watch.js, or one that was not controlled when it started (the first install).
    sw.addEventListener('controllerchange', () => changed(sw.controller ? sw.controller.scriptURL : null));
  }
  const reg = await sw.getRegistration();
  if (!reg) return;
  if (!(early && early.initial)) {
    check(reg.installing && reg.installing.scriptURL);
    check(reg.waiting && reg.waiting.scriptURL);
    reg.addEventListener('updatefound', () => check(reg.installing && reg.installing.scriptURL));
  }
  if (!endsWithLoader(controllerUrl)) askToTakeOver(reg);
  // A move that happened while no page of this release could look (the app was closed meanwhile).
  else if (readMoveCheck() && (await checkMovedLoader()) === 'other') return fire(movedOther);

  // Moving to this release's loader after an approved Update that brought a new
  // one. Asked again at each start until it has moved: a phone can stop the page
  // before the new loader is installed, and until then this release runs under
  // the older loader's headers (which name only the hosts that release knew).
  if (!endsWithLoader(controllerUrl)) {
    const pending = [reg.installing, reg.waiting].some((w) => endsWithLoader(w && w.scriptURL));
    // A running loader that serves pages exactly like this release's own leaves
    // nothing to finish: no move, no request to the address. A tapped Check for
    // updates still moves the page once the address serves the release (lib/update.js).
    // The address is down, or serves other bytes: the older loader keeps serving this verified copy.
    if (!pending && (await checkServedLoader())) moveToLoader().catch(() => {});
  }
}

/**
 * Installs this release's loader when the page still runs under an older one,
 * after checking the address serves its signed bytes. Returns 'current'
 * (nothing to do), 'moving', or 'not-served' (address down or other bytes).
 */
export async function moveToLoader() {
  const sw = navigator.serviceWorker;
  if (!sw || !sw.controller || endsWithLoader(sw.controller.scriptURL)) return 'current';
  let st = null;
  try {
    st = await askLoader({ type: 'status' }, { timeoutMs: 10000 });
  } catch {
    st = null;
  }
  const signed = st && st.releaseLoader && st.releaseLoader.path === LOADER ? st.releaseLoader.sha256 : null;
  if (!(await loaderServed(LOADER, signed))) return 'not-served';
  // Checked again from the page that runs under it (checkMovedLoader), against this signed hash.
  writeMoveCheck({ path: LOADER, sha256: signed, at: Date.now() });
  const reg = await sw.register(LOADER, { scope: './', updateViaCache: 'none' });
  askToTakeOver(reg);
  return 'moving';
}
