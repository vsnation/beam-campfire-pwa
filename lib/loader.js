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
// Best effort, stated plainly in docs/beam/PWA.md: a page opened after a
// takeover is served by the new code, and that code can show anything.
//
// An update that came from another copy while the app's own address was down
// (lib/update_sources.js) runs under the loader the device already has, since
// a service worker comes only from its own address. The page moves to its own
// loader later, when a tapped Check for updates finds that address serving the
// installed release again; every move first checks that the address serves the
// loader's signed bytes.

import { LOADER, LOADER_COMPAT, BUILT } from './version.js';

const META_CACHE = 'campfire-meta';
const PROGRESS_KEY = '__campfire_install';
const RELOAD_KEY = 'campfire-sw-reload';

export const INTEGRITY_CODES = new Set(['bad_signature', 'manifest_mismatch', 'file_mismatch', 'malformed', 'downgrade']);

export function swSupported() {
  return 'serviceWorker' in navigator;
}

// The loader that served this document. Its headers (the CSP) stay in force
// for the life of the page, even after a newer loader takes over.
const servedBy = typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null;

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
export function askLoader(msg, { timeoutMs = 120000, onProgress = null, slowMessage = 'The update check took too long.' } = {}) {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!sw) return Promise.reject(new Error('The app is not running from its verified copy yet.'));
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    let t = null;
    const arm = () => {
      clearTimeout(t);
      t = setTimeout(() => reject(new Error(slowMessage)), timeoutMs);
    };
    ch.port1.onmessage = (e) => {
      if (e.data && e.data.progress) {
        arm();
        if (onProgress) onProgress(e.data.progress);
        return;
      }
      clearTimeout(t);
      resolve(e.data);
    };
    arm();
    sw.postMessage(msg, [ch.port2]);
  });
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Whether this app's address serves the loader file `path` with the signed
 * bytes (sha256 from the release's manifest; without it, the hash its
 * content-addressed name carries). A loader that replaces another is installed
 * only after this.
 */
export async function loaderServed(path, sha256 = null) {
  if (!/^sw-[0-9a-f]{16}\.js$/.test(String(path))) return false;
  let bytes;
  try {
    const r = await fetch(new URL(path, document.baseURI).href, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return false;
    bytes = await r.arrayBuffer();
  } catch {
    return false;
  }
  const got = hex(await crypto.subtle.digest('SHA-256', bytes));
  return sha256 ? got === sha256 : got.startsWith(path.slice(3, 19));
}

const endsWithLoader = (url) => typeof url === 'string' && url.split('?')[0].endsWith(`/${LOADER}`);

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
  // A worker for LOADER is expected only while the page is moving to it from an
  // older loader (after an approved Update). Anything else is a change of code
  // at a URL whose bytes never change legitimately.
  const expected = (w) => endsWithLoader(w && w.scriptURL) && !endsWithLoader(sw.controller && sw.controller.scriptURL);
  const check = (w) => {
    if (w && !expected(w)) fire(`a new service worker (${w.scriptURL.split('/').pop()}) is being installed`);
  };
  let controllerUrl = sw.controller.scriptURL;
  sw.addEventListener('controllerchange', () => {
    const now = sw.controller ? sw.controller.scriptURL : null;
    const ok = endsWithLoader(now) && !endsWithLoader(controllerUrl);
    controllerUrl = now;
    if (!ok) fire('the service worker controlling this page changed');
    else onMoved();
  });
  const reg = await sw.getRegistration();
  if (!reg) return;
  check(reg.installing);
  check(reg.waiting);
  reg.addEventListener('updatefound', () => check(reg.installing));
  if (!endsWithLoader(controllerUrl)) askToTakeOver(reg);

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
  const reg = await sw.register(LOADER, { scope: './', updateViaCache: 'none' });
  askToTakeOver(reg);
  return 'moving';
}
