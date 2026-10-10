// Runs one dApp in a sandboxed frame and connects it to the wallet.
//
// 1. An <iframe> (no sandbox attribute yet) loads <scope>dapp-run/<policy>/<start page>.
//    The service worker answers that navigation with the frame document
//    (lib/dapps/frame_policy.js): the bootstrap only, under a CSP that
//    sandboxes it into an opaque origin. A sandbox attribute on the element
//    from the start would make the browser skip the service worker for that
//    navigation (Chrome and WebKit both do), and the frame would come from
//    the network, unsigned.
// 2. On that first load the sandbox attribute is set, so whatever the frame
//    navigates to afterwards is sandboxed too, and is fetched past the
//    service worker (the wallet's own pages refuse to be framed).
// 3. Still on the first load, and only then, the frame's window gets a
//    MessagePort. All traffic goes over that port; nothing listens for
//    window messages. A later load (the dApp reloading or navigating away)
//    is pinged on the port: a new document has no port and cannot answer,
//    and the dApp is closed.
// 4. The bootstrap gets the verified files and writes the dApp's page.
//    Every request comes back as a JSON-RPC string and goes through
//    DappSession (method gate, parameter rules, contract policy) to this
//    dApp's own app API in BEAM's engine.

import { DappSession } from './session.js';
import { validateFrameMessage } from './messages.js';
import { FRAME_ROUTE, policySegment, remoteMaskFor } from './frame_policy.js';
import { mimeFor } from './package.js';

/** The colours BEAM dApps are drawn for: the desktop and Qt wallets' mainnet palette. */
export const DAPP_STYLE = Object.freeze({
  content_main: '#ffffff',
  background_main: '#042548',
  background_main_top: '#035b8f',
  background_popup: '#00446c',
  validator_error: '#ff625c',
  navigation_background: '#000000',
  appsGradientOffset: -95,
  appsGradientTop: 135,
});

export const HOST_CSS = `html { background-color: ${DAPP_STYLE.background_main}; background-image: linear-gradient(to bottom, ${DAPP_STYLE.background_main_top} ${DAPP_STYLE.appsGradientOffset}px, ${DAPP_STYLE.background_main} ${DAPP_STYLE.appsGradientTop}px, ${DAPP_STYLE.background_main}); background-repeat: no-repeat; background-attachment: fixed; min-height: 100%; }`;

/**
 * Which wallet shape the dApp is offered, by the user agent it is shown.
 * BEAM dApps choose from navigator.userAgent alone: "Android"/"iPhone" ->
 * the mobile shape (compact layout), "QtWebEngine" -> the Qt shape (desktop
 * layout), anything else -> the web-extension handshake, which several of
 * them refuse outside Chrome. So the frame is given a mobile or a Qt user
 * agent, never the web one.
 */
export function shapeFor(width, realUa, { desktopOnly = false } = {}) {
  if (desktopOnly) return { shape: 'qt', ua: `${realUa.replace(/\b(Android|iPad|iPhone|iPod)\b/gi, 'Device')} QtWebEngine/6.11.1 CampfireDapp` };
  if (/android|iPad|iPhone|iPod/i.test(realUa)) return { shape: 'mobile', ua: null };
  if (width < 700) return { shape: 'mobile', ua: `${realUa} Android CampfireDapp` };
  return { shape: 'qt', ua: `${realUa} QtWebEngine/6.11.1 CampfireDapp` };
}

// Loaded into every dApp frame before the dApp's own scripts: an in-memory
// IndexedDB (an opaque origin has none; two of the nine dApps need one).
// From the verified copy, like every file of the app.
const FRAME_SHIMS = ['vendor/fake-indexeddb/fake-indexeddb.js'];
let shimTexts = null;
async function frameShims() {
  if (!shimTexts) {
    shimTexts = Promise.all(
      FRAME_SHIMS.map(async (p) => {
        const r = await fetch(new URL(`../../${p}`, import.meta.url), { cache: 'no-cache' });
        if (!r.ok) throw new Error(`${p}: ${r.status}`);
        return r.text();
      }),
    );
    shimTexts.catch(() => {
      shimTexts = null;
    });
  }
  return shimTexts;
}

/** The frame's address, in this app's scope (this file is lib/dapps/runner.js). */
export function frameAddress(entry, startPath, { remoteOrigins = [] } = {}) {
  const seg = policySegment({ evalAllowed: entry.needsEval, remoteMask: remoteMaskFor(remoteOrigins) });
  return new URL(`../../${FRAME_ROUTE}${seg}/${startPath.split('/').map(encodeURIComponent).join('/')}`, import.meta.url).href;
}

const liveRunners = new Set();
/** For the e2e tests: counters only, nothing a dApp sent. */
export function runnerStats() {
  return [...liveRunners].map((r) => ({ name: r.name, state: r.state, loads: r.loads, ...r.session.stats, dropped: r.dropped, shape: r.shape }));
}

export class DappRunner {
  /**
   * @param {object} o
   * @param {object} o.entry catalogue entry
   * @param {object} o.manifest from openPackage
   * @param {Map<string, Uint8Array>} o.files from openPackage
   * @param {{call: Function, close: Function, onEvent?: Function}} o.appApi this dApp's app API (openApp)
   * @param {string[]} o.remoteOrigins granted remote origins
   * @param {(req) => Promise<boolean>} o.confirmSign
   * @param {(state: {kind: string, message?: string}) => void} o.onState
   * @param {(url: string) => void} o.onOpenLink
   * @param {() => void} o.onActivity
   */
  constructor({ entry, manifest, files, appApi, remoteOrigins = [], confirmSign, onState, onOpenLink, onActivity, onLayout = null, onRefused = null, onBusy = null }) {
    this.entry = entry;
    this.name = manifest.name;
    this.manifest = manifest;
    this.files = files;
    this.appApi = appApi;
    this.remoteOrigins = remoteOrigins;
    this.onState = onState || (() => {});
    this.onOpenLink = onOpenLink || (() => {});
    this.onActivity = onActivity || (() => {});
    this.onLayout = onLayout || (() => {});
    this.session = new DappSession({ appName: manifest.name, app: appApi, confirmSign, onRefused, onBusy, apiVersion: manifest.apiVersion, minApiVersion: manifest.minApiVersion });
    this.loads = 0;
    this.dropped = 0;
    this.state = 'idle';
    this.port = null;
    this.pingN = 0;
    this.pongWait = null;
    this.readyTimer = null;
    this.iframe = null;
    this.offEvents = null;
  }

  /** Puts the frame into `container` and starts the dApp. */
  mount(container) {
    const { shape, ua } = shapeFor(container.clientWidth || window.innerWidth, navigator.userAgent, { desktopOnly: this.entry.desktopShape === true });
    this.shape = shape;
    this.ua = ua;
    const f = document.createElement('iframe');
    f.className = 'dapp-frame';
    f.title = this.name;
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('data-testid', 'dapp-frame');
    f.addEventListener('load', () => this.onLoad());
    f.src = frameAddress(this.entry, this.manifest.startPath, { remoteOrigins: this.remoteOrigins });
    this.iframe = f;
    this.setState('loading');
    liveRunners.add(this);
    container.appendChild(f);
    if (this.appApi && typeof this.appApi.onEvent === 'function') {
      this.offEvents = this.appApi.onEvent((name, data) => {
        const json = this.session.event(name, data);
        if (json && this.port) this.port.postMessage({ t: 'deliver', json });
      });
    }
  }

  setState(kind, message) {
    this.state = kind;
    this.onState({ kind, message });
  }

  onLoad() {
    if (this.state === 'closed') return;
    this.loads++;
    if (this.loads === 1) {
      // From now on every navigation of this frame is sandboxed by the element too.
      this.iframe.setAttribute('sandbox', 'allow-scripts');
      const ch = new MessageChannel();
      this.port = ch.port1;
      this.port.onmessage = (e) => this.onFrameMessage(e.data);
      this.iframe.contentWindow.postMessage({ t: 'campfire-port' }, '*', [ch.port2]);
      this.readyTimer = setTimeout(() => this.fail('The dApp frame did not start.'), 10000);
      return;
    }
    // A later load: the bootstrap's own page write (same document, it answers),
    // or a navigation to something else (no port, no answer).
    const n = ++this.pingN;
    clearTimeout(this.pongWait);
    this.pongWait = setTimeout(() => {
      if (this.state !== 'closed') this.setState('gone', 'The dApp reloaded or left its page, so BEAM Campfire closed it.');
      this.close();
    }, 3000);
    try {
      this.port.postMessage({ t: 'ping', n });
    } catch {
      /* closed below */
    }
  }

  fail(message) {
    if (this.state === 'closed') return;
    this.setState('failed', message);
    this.close();
  }

  onFrameMessage(raw) {
    const m = validateFrameMessage(raw);
    if (!m) {
      this.dropped++;
      return;
    }
    switch (m.t) {
      case 'ready':
        clearTimeout(this.readyTimer);
        this.sendFiles().catch((e) => this.fail(`The dApp could not start: ${e.message}`));
        break;
      case 'started':
        this.setState('running');
        break;
      case 'rpc':
        this.session.handle(m.json).then((json) => {
          if (this.port && this.state !== 'closed') this.port.postMessage({ t: 'deliver', json });
        });
        break;
      case 'hello': {
        const ok = this.session.handshake({ apiver: m.apiver, apivermin: m.apivermin });
        this.port.postMessage({ t: 'handshake', ok });
        break;
      }
      case 'pong':
        if (m.n === this.pingN) clearTimeout(this.pongWait);
        break;
      case 'activity':
        this.onActivity();
        break;
      case 'open-link':
        this.onOpenLink(m.url);
        break;
      case 'layout':
        this.onLayout(m);
        break;
      case 'failed':
        this.fail(`The dApp could not start: ${m.message}`);
        break;
      default:
        break;
    }
  }

  async sendFiles() {
    const shims = await frameShims();
    if (this.state === 'closed') return;
    const list = [];
    const transfer = [];
    for (const [path, bytes] of this.files) {
      const buf = bytes.slice().buffer;
      list.push({ path, type: mimeFor(path), buf });
      transfer.push(buf);
    }
    this.port.postMessage({ t: 'start', files: list, start: this.manifest.startPath, shape: this.shape, ua: this.ua, style: { ...DAPP_STYLE }, hostCss: HOST_CSS, shims }, transfer);
  }

  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this.readyTimer);
    clearTimeout(this.pongWait);
    liveRunners.delete(this);
    this.session.close();
    if (this.offEvents) this.offEvents();
    try {
      if (this.port) this.port.close();
    } catch {
      /* already closed */
    }
    this.port = null;
    if (this.iframe) this.iframe.remove();
    this.iframe = null;
    try {
      if (this.appApi) this.appApi.close();
    } catch {
      /* already closed */
    }
    this.files = null;
  }
}
