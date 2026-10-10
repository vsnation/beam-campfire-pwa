// How a dApp frame is served. Shared by the page (which builds the frame's
// address), the service worker (the build inlines this file into it, so it
// imports nothing) and the dev server.
//
// A dApp runs in an <iframe> whose document the service worker builds from
// the verified copy: dapp-frame.js inlined under a per-response nonce, with
// the headers below. The Content-Security-Policy starts with
// "sandbox allow-scripts" (no allow-same-origin), so the document gets an
// opaque origin: it cannot reach this wallet's storage, cookies, service
// worker, engine or DOM. The page sets the iframe's own sandbox attribute
// right after that first load, so anything the frame navigates to later is
// sandboxed too and is never served by the service worker (browsers bypass
// it for sandboxed frames).
//
// The frame's address carries its policy: <scope>dapp-run/e<0|1>r<mask>/<start page>.
// e1 allows 'unsafe-eval' (most dApp bundles are webpack eval builds); the
// mask grants REMOTE_ORIGINS by bit. Nothing else can widen it, and a
// frame document never gets anything from the wallet but its first load's
// MessagePort, so a dApp that navigates itself to a wider policy gains
// nothing: no files, no bridge.

export const FRAME_ROUTE = 'dapp-run/';

/** Every remote origin a dApp may be granted, by bit (1, 2, ...). */
export const REMOTE_ORIGINS = ['https://api.coingecko.com', 'https://explorer-api.beam.mw'];

const SEGMENT = /^e([01])r(0|[1-9][0-9]?)$/;

export function policySegment({ evalAllowed, remoteMask = 0 }) {
  const mask = Number(remoteMask) >>> 0;
  if (mask >= 1 << REMOTE_ORIGINS.length) throw new Error('remote mask out of range');
  return `e${evalAllowed ? 1 : 0}r${mask}`;
}

export function parsePolicySegment(seg) {
  const m = SEGMENT.exec(String(seg));
  if (!m) return null;
  const mask = Number(m[2]);
  if (mask >= 1 << REMOTE_ORIGINS.length) return null;
  return { evalAllowed: m[1] === '1', remoteMask: mask, remoteOrigins: REMOTE_ORIGINS.filter((_, i) => mask & (1 << i)) };
}

export function remoteMaskFor(origins) {
  let mask = 0;
  for (const o of origins) {
    const i = REMOTE_ORIGINS.indexOf(o);
    if (i < 0) throw new Error(`not a known remote origin: ${o}`);
    mask |= 1 << i;
  }
  return mask;
}

/**
 * The policy for a path inside the service worker's scope, or null when the
 * path is not a dApp frame. "dapp-run/e1r0/app/index.html" -> {evalAllowed, ...}.
 */
export function frameRouteFor(relPath) {
  if (typeof relPath !== 'string' || !relPath.startsWith(FRAME_ROUTE)) return null;
  const rest = relPath.slice(FRAME_ROUTE.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return parsePolicySegment(rest.slice(0, slash));
}

/** The frame's Content-Security-Policy. No 'self' anywhere: the wallet's origin is not the frame's to reach. */
export function frameCsp({ evalAllowed, remoteOrigins, nonce }) {
  if (!/^[A-Za-z0-9+/=_-]{16,64}$/.test(String(nonce))) throw new Error('bad nonce');
  const remote = remoteOrigins.length ? ` ${remoteOrigins.join(' ')}` : '';
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src 'nonce-${nonce}' blob:${evalAllowed ? " 'unsafe-eval'" : ''}`,
    "style-src blob: 'unsafe-inline'",
    `img-src blob: data:${remote}`,
    'media-src blob: data:',
    'font-src blob: data:',
    `connect-src blob: data:${remote}`,
    "worker-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

export function frameHeaders(policy, nonce) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': frameCsp({ ...policy, nonce }),
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()',
    'Cache-Control': 'no-store',
  };
}

/** The frame document: nothing but the bootstrap, which waits for the wallet. */
export function frameDocument(scriptText, nonce) {
  if (String(scriptText).toLowerCase().includes('</script')) throw new Error('the frame script cannot contain </script');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script nonce="${nonce}">${scriptText}</script></head><body></body></html>`;
}

/** 24 random bytes, base64url. */
export function newNonce() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
