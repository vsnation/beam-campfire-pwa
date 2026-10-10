// The person's own BEAM node, seen from the page: checking an address before
// it is saved, telling the service worker which node to add to the CSP, and
// switching between it and BEAM's random nodes.
//
// A page's Content-Security-Policy is fixed when it loads. The service worker
// adds the own node to the policy of every page and worker it serves from then
// on (sw.js "set-node"), so moving to a node this page's policy does not name
// takes one reload: the wallet locks, the app reopens, and unlock starts the
// engine on that node. Moving back to BEAM's nodes needs none: they are in
// every policy, so the engine just restarts on them, as a node switch always did.

import { normalizeNodeAddress, NODE_PROBE_PAGE } from './node_address.js';
import { RANDOM_NODE } from './nodes.js';
import { wallet } from './wallet.js';
import { scanEnabled } from './session.js';

const META_CACHE = 'campfire-meta';
const OWN_NODE_KEY = '__campfire_node';
const SWITCH_NOTE = 'campfire-node-switched';
const RECONCILE_KEY = 'campfire-node-reconciled';
export const PROBE_TIMEOUT_MS = 10000;

/** The own node this page's policy was served with (read once at boot). */
let servedWith = null;

export const isOwnNode = (node) => typeof node === 'string' && node !== RANDOM_NODE && normalizeNodeAddress(node).ok;

/** The own node the service worker adds to connect-src now, or null. */
export async function loaderNode() {
  try {
    const r = await (await caches.open(META_CACHE)).match(new URL(OWN_NODE_KEY, document.baseURI).href);
    const v = r ? await r.json() : null;
    const n = v && v.node ? normalizeNodeAddress(v.node) : null;
    return n && n.ok ? n.address : null;
  } catch {
    return null;
  }
}

function askLoader(msg, timeoutMs = 10000) {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!sw) return Promise.reject(new Error('Your own node works in the installed app only.'));
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => reject(new Error('The app did not answer in time.')), timeoutMs);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(e.data);
    };
    sw.postMessage(msg, [ch.port2]);
  });
}

/** Tells the service worker which own node to allow (null: none). */
export async function setLoaderNode(address) {
  const r = await askLoader({ type: 'set-node', node: address });
  if (!r || r.result !== 'saved') throw new Error(r && r.reason ? r.reason : 'This copy of the app cannot use an own node yet. Check for updates, then try again.');
  return r.node;
}

export const canUseOwnNode = () => Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);

/**
 * Opens the node check frame for `address` and waits for its answer:
 * {ok: true} once a WebSocket to wss://address opened, {ok: false, code} otherwise.
 */
export function probeNode(address, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const n = normalizeNodeAddress(address);
  if (!n.ok) return Promise.resolve({ ok: false, code: 'invalid' });
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.className = 'hidden';
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      frame.remove();
      resolve(r);
    };
    const onMessage = (e) => {
      if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
      const d = e.data;
      if (!d || d.type !== 'campfire-node-probe' || d.id !== id) return;
      finish({ ok: d.ok === true, code: String(d.code || '') });
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), timeoutMs);
    window.addEventListener('message', onMessage);
    frame.src = `${NODE_PROBE_PAGE}?node=${encodeURIComponent(n.address)}&id=${id}`;
    document.body.appendChild(frame);
  });
}

/** After the reload that moves to an own node, unlock says which node it will connect to. */
export function takeSwitchNote() {
  try {
    const v = sessionStorage.getItem(SWITCH_NOTE);
    sessionStorage.removeItem(SWITCH_NOTE);
    return v;
  } catch {
    return null;
  }
}

/**
 * Makes `address` the only node: the service worker adds it to the policy,
 * prefs remember it, and - unless this page's policy already names it - the
 * wallet locks and the app reopens on it. Returns 'reload' or 'restarted'.
 */
export async function useOwnNode(app, address, { ownerKey = false } = {}) {
  const n = normalizeNodeAddress(address);
  if (!n.ok) throw new Error(n.error);
  await setLoaderNode(n.address);
  await app.setPrefs({ node: n.address, ownNodeKey: Boolean(ownerKey) });
  if (servedWith === n.address) {
    await restartOn(app, n.address);
    return 'restarted';
  }
  await app.lock('node');
  try {
    sessionStorage.setItem(SWITCH_NOTE, n.address);
  } catch {
    /* only for the line on the unlock screen */
  }
  location.reload();
  return 'reload';
}

/** Back to BEAM's random nodes: one restart, no reload. The own node leaves the policy of every page served from now on. */
export async function useRandomNodes(app) {
  await setLoaderNode(null).catch((e) => console.warn('[campfire] own node', e.message));
  await app.setPrefs({ node: RANDOM_NODE });
  await restartOn(app, RANDOM_NODE);
}

async function restartOn(app, node) {
  if (!app.dbPass) return;
  await wallet.stop();
  await wallet.start({ dbPass: app.dbPass, node, bodyRequests: scanEnabled(app) });
}

/**
 * At boot: the page's policy and the person's choice agree. An own node the
 * worker does not know yet is handed to it once, with one reload; a node the
 * worker still allows but nobody uses is dropped. Returns true when it reloads.
 */
export async function reconcileOwnNode(app) {
  servedWith = await loaderNode();
  if (!canUseOwnNode()) return false;
  const want = isOwnNode(app.prefs.node) ? normalizeNodeAddress(app.prefs.node).address : null;
  if (servedWith === want) return false;
  if (want === null) {
    await setLoaderNode(null).catch(() => {});
    return false;
  }
  let tried = null;
  try {
    tried = sessionStorage.getItem(RECONCILE_KEY);
    sessionStorage.setItem(RECONCILE_KEY, want);
  } catch {
    return false;
  }
  if (tried === want) return false;
  try {
    await setLoaderNode(want);
  } catch {
    return false;
  }
  location.reload();
  return true;
}
