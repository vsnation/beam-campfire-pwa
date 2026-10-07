// Talking to the service worker about releases. The worker owns the rules
// (sw.js): it serves only files from a release whose signature and hashes it
// verified, and it switches releases only when apply() is called - which only
// the "Update" button does.
//
// Nothing here runs by itself: there is no update check at start, no timer and
// no re-registration. The web address is contacted only when the person taps
// "Check for updates" (and once after an Update they approved, if that release
// brings a new loader: lib/loader.js). The installed copy keeps working when the
// address is gone.

const LAST_CHECK_KEY = 'campfire-last-update-check';

function ask(msg, timeoutMs = 120000) {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!sw) return Promise.reject(new Error('The app is not running from its verified copy yet.'));
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => reject(new Error('The update check took too long.')), timeoutMs);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(e.data);
    };
    sw.postMessage(msg, [ch.port2]);
  });
}

function readLastCheck() {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_CHECK_KEY) || 'null');
    return v && typeof v.at === 'number' ? v : null;
  } catch {
    return null;
  }
}

export const updates = {
  available: null, // {version} once a verified update is staged
  refused: null, // {reason}
  lastCheck: readLastCheck(), // {at, result, version?} of the last check the person asked for
  listeners: new Set(),
  emit() {
    for (const fn of this.listeners) fn(this);
  },
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  async status() {
    return ask({ type: 'status' }, 10000);
  },
  /** Downloads and verifies a newer signed release, if there is one. Never applies it. Only on request. */
  async check() {
    let r;
    try {
      r = await ask({ type: 'check-update' });
    } catch (e) {
      r = { result: 'unreachable', reason: e.message };
    }
    if (r.result === 'ready') {
      this.available = { version: r.version };
      this.refused = null;
    } else if (r.result === 'refused') {
      this.refused = { reason: r.reason, version: r.version };
    } else if (r.result === 'none') {
      this.refused = null;
    }
    this.lastCheck = { at: Date.now(), result: r.result, version: r.version || null };
    try {
      localStorage.setItem(LAST_CHECK_KEY, JSON.stringify(this.lastCheck));
    } catch {
      /* only for the "last checked" line */
    }
    this.emit();
    return r;
  },
  async apply() {
    const r = await ask({ type: 'apply-update' });
    if (r.result === 'applied') location.reload();
    return r;
  },
};

/** "Last checked 5 min ago: up to date." for Settings and About. */
export function lastCheckText(lc, now = Date.now()) {
  if (!lc) return 'Never checked. Updates are signed and install only when you tap Update.';
  const mins = Math.max(0, Math.round((now - lc.at) / 60000));
  const when = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  const what = {
    none: 'you have the latest version.',
    ready: `version ${lc.version} is ready to install.`,
    unreachable: 'no update source was reachable; your app keeps working.',
    refused: 'an update was refused.',
  }[lc.result] || 'no answer.';
  return `Last checked ${when}: ${what}`;
}
