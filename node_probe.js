// The node check frame (node_probe.html?node=host:port&id=...): opens one
// WebSocket to that node and tells the page whether it opened. The service
// worker serves this frame with a policy whose connect-src is exactly that
// node (lib/node_address.js probeCsp), so an address can be checked before
// anything is saved and before the app's own policy names it. It does nothing
// unless it is a frame of this app (the worker also refuses to serve it as a
// page, and frame-ancestors 'self' keeps other sites from framing it).
import { normalizeNodeAddress, PROBE_ID } from './lib/node_address.js';

const OPEN_TIMEOUT_MS = 8000;
const qs = new URLSearchParams(location.search);
const id = qs.get('id') || '';
const n = normalizeNodeAddress(qs.get('node'));
let done = false;

function report(ok, code) {
  if (done) return;
  done = true;
  window.parent.postMessage({ type: 'campfire-node-probe', id, ok, code }, location.origin);
}

if (window.parent !== window && PROBE_ID.test(id) && n.ok) {
  let ws = null;
  const timer = setTimeout(() => {
    report(false, 'timeout');
    try {
      if (ws) ws.close();
    } catch {
      /* closing anyway */
    }
  }, OPEN_TIMEOUT_MS);
  try {
    ws = new WebSocket(`wss://${n.address}/`);
    ws.onopen = () => {
      clearTimeout(timer);
      report(true, 'open');
      ws.close(1000);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      report(false, 'failed');
    };
    ws.onclose = () => {
      clearTimeout(timer);
      report(false, 'closed');
    };
  } catch {
    clearTimeout(timer);
    report(false, 'blocked');
  }
}
