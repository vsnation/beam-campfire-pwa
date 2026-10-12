// Whether the browser keeps this app's storage (wallet.db in IndexedDB, the
// verified copy in Cache Storage) or may clear it under pressure. Asked for once
// a wallet exists; the answer is shown in Settings -> About. No network.
//
// The browser can delete the only copy of what this app keeps (audit A-7): a wallet imported from a
// wallet.db (no 12 words), airdrop codes (the only key to locked coins), bridge records (the only
// handle to coins in flight). Safari deletes a site's script-written storage after 7 days of use
// without a visit to it, in a tab (a Home Screen app has its own count and storage); other browsers
// clear least-used sites when the device runs low on space unless the site's storage is kept
// (persist()). evictionRisk() says which applies here; Home and the screens that make such a
// record say so (screens/storage_warning.js).
//
// Chrome grants persist() silently, and only to a site it trusts more (installed, bookmarked,
// allowed to notify, often used), so it is asked again when the app is installed.

let watching = false;

export async function refreshPersistence(app, { request = false } = {}) {
  const s = navigator.storage;
  if (!s || typeof s.persisted !== 'function') {
    app.persisted = null;
    return null;
  }
  if (!watching && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    watching = true;
    window.addEventListener('appinstalled', () => {
      if (app.record) refreshPersistence(app, { request: true }).catch(() => {});
    });
  }
  try {
    let kept = await s.persisted();
    if (!kept && request && typeof s.persist === 'function') kept = await s.persist();
    app.persisted = Boolean(kept);
  } catch {
    app.persisted = null;
  }
  return app.persisted;
}

export function persistenceText(persisted) {
  if (persisted === true) return 'kept';
  if (persisted === false) return 'may be cleared by the system';
  return 'unknown in this browser';
}

/** Safari (any iPhone or iPad browser, Safari on a Mac) in a tab, not the Home Screen / Dock app. */
export function isSafariTab(env = globalThis) {
  const nav = env.navigator || {};
  const ua = String(nav.userAgent || '');
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1);
  const macSafari = /Macintosh/.test(ua) && /Version\/[\d.]+.*Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Firefox|Edg|OPR/.test(ua);
  let standalone = nav.standalone === true;
  try {
    standalone = standalone || Boolean(env.matchMedia && env.matchMedia('(display-mode: standalone)').matches);
  } catch {
    /* no matchMedia */
  }
  return (ios || macSafari) && !standalone;
}

/**
 * Whether this browser may delete what this app keeps: 'safariTab' (not kept, in a Safari tab:
 * gone after 7 days without a visit), 'mayClear' (not kept elsewhere: cleared when space runs low),
 * or null (kept, or the browser cannot say).
 */
export function evictionRisk(app, env = globalThis) {
  if (!app || app.persisted !== false) return null;
  return isSafariTab(env) ? 'safariTab' : 'mayClear';
}
