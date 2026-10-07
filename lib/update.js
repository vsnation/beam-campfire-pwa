// Talking to the service worker about releases. The worker owns the rules
// (sw.js): it serves only files from a release whose signature and hashes it
// verified, and it switches releases only when apply() is called - which only
// the "Update" button does. Nothing here updates by itself.

import { BUILT } from './version.js';
import { sha256Hex } from './release.js';

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

export const updates = {
  available: null, // {version} once a verified update is staged
  refused: null, // {reason}
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
  /** Downloads and verifies a newer signed release, if there is one. Never applies it. */
  async check() {
    const r = await ask({ type: 'check-update' });
    if (r.result === 'ready') {
      this.available = { version: r.version };
      this.refused = null;
    } else if (r.result === 'refused') {
      this.refused = { reason: r.reason, version: r.version };
    } else if (r.result === 'none') {
      this.refused = null;
    }
    this.emit();
    return r;
  },
  async apply() {
    const r = await ask({ type: 'apply-update' });
    if (r.result === 'applied') location.reload();
    return r;
  },
  /**
   * The browser re-downloads sw.js by itself; that is the one file the
   * signed-release checks cannot gate. Compare what the server offers now with
   * the hash in the verified manifest (current or staged update).
   */
  async loaderCheck() {
    try {
      const st = await this.status();
      const r = await fetch('sw.js', { cache: 'no-store' });
      if (!r.ok) return { ok: null, reason: 'unreachable' };
      const live = await sha256Hex(new Uint8Array(await r.arrayBuffer()));
      const known = [st.currentSw, st.pendingSw].filter(Boolean);
      return { ok: known.includes(live), live };
    } catch {
      return { ok: null, reason: 'offline' };
    }
  },
};

/**
 * First visit: install the service worker (which verifies the signed release
 * before caching anything) and reload so every file comes from that copy.
 * @returns 'controlled' | 'reloading' | 'unsupported' | 'unbuilt' | {failed: reason}
 */
export async function ensureVerifiedCopy() {
  if (!BUILT) return 'unbuilt';
  if (!('serviceWorker' in navigator)) return 'unsupported';
  let reg;
  try {
    reg = await navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });
  } catch (e) {
    return { failed: `The app could not install its offline copy (${e.message}).` };
  }
  if (navigator.serviceWorker.controller) return 'controlled';
  const worker = reg.installing || reg.waiting || reg.active;
  const outcome = await new Promise((resolve) => {
    if (!worker) return resolve('no-worker');
    if (worker.state === 'activated') return resolve('activated');
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve('activated');
      if (worker.state === 'redundant') resolve('redundant');
    });
  });
  if (outcome === 'activated') {
    if (sessionStorage.getItem('campfire-sw-reload') === '1') {
      // Already reloaded once and still not controlled (e.g. a hard reload). Carry on unverified-but-pinned.
      return 'controlled-pending';
    }
    sessionStorage.setItem('campfire-sw-reload', '1');
    location.reload();
    return 'reloading';
  }
  return { failed: 'This copy of BEAM Campfire did not pass its signature check, so it was not installed.' };
}
