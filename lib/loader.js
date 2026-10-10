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

import { LOADER } from './version.js';

const META_CACHE = 'campfire-meta';
const PROGRESS_KEY = '__campfire_install';
const MIGRATE_KEY = 'campfire-loader-tried';
const RELOAD_KEY = 'campfire-sw-reload';

export const INTEGRITY_CODES = new Set(['bad_signature', 'manifest_mismatch', 'file_mismatch', 'malformed', 'downgrade']);

export function swSupported() {
  return 'serviceWorker' in navigator;
}

export function isControlled() {
  return Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);
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
export async function watchLoader({ onIntrusion }) {
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
  });
  const reg = await sw.getRegistration();
  if (!reg) return;
  check(reg.installing);
  check(reg.waiting);
  reg.addEventListener('updatefound', () => check(reg.installing));
  if (!endsWithLoader(controllerUrl)) askToTakeOver(reg);

  // Moving to this release's loader, once, right after an approved Update that
  // brought a new one. The only time the page asks the web address for a loader.
  if (!endsWithLoader(controllerUrl)) {
    let tried = null;
    try {
      tried = localStorage.getItem(MIGRATE_KEY);
    } catch {
      /* private mode */
    }
    if (tried !== LOADER) {
      try {
        localStorage.setItem(MIGRATE_KEY, LOADER);
      } catch {
        /* private mode */
      }
      sw.register(LOADER, { scope: './', updateViaCache: 'none' }).catch(() => {
        /* the address is down: the older loader keeps serving this verified copy */
      });
    }
  }
}
