/* BEAM Campfire service worker.
 *
 * It serves the app only from a release it verified itself:
 *   - release.json is signed (ECDSA P-256 / SHA-256) by the BEAM Campfire
 *     release key, whose public half is built into this file;
 *   - manifest.json must hash to the value in release.json;
 *   - every file must match its size and SHA-256 in manifest.json.
 * The first install caches the release only if all of that holds. Later
 * releases are downloaded and verified on request ("check-update") into a
 * separate cache, and become the served copy only on "apply-update", which
 * only the Update button sends. A tampered file or bad signature leaves the
 * current copy in place. Every response gets the security headers (COOP/COEP
 * for the engine's SharedArrayBuffer, CSP, CORP) because a response from the
 * cache would otherwise carry none.
 *
 * Not served from the cache (go to the network as they are): the release
 * files themselves, sw.js, the recovery snapshot, the explorer status and
 * dev-server paths. The BEAM node is a WebSocket, which never passes here.
 *
 * The build (tools/build.mjs) fills in the placeholders and inlines
 * lib/release.js where marked.
 */
'use strict';

const RELEASE_PUBLIC_JWK = {"kty":"EC","crv":"P-256","x":"nHc0TAS1zffyZvN4tSmEyelt5vpEB-QDUEgHSNztzpc","y":"hHBISFLKDalMgMsjuW78PAMirodfcnlZ5N3-9A9Pa9A"};
const SW_VERSION = "0.1.3";
const SECURITY_HEADERS = {"Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Embedder-Policy":"require-corp","Cross-Origin-Resource-Policy":"same-origin","Content-Security-Policy":"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' wss://eu-nodes.mainnet.beam.mw:8200 wss://eu-node01.mainnet.beam.mw:8200 wss://eu-node02.mainnet.beam.mw:8200; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","Permissions-Policy":"camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()"};
const MIME = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json",".webmanifest":"application/manifest+json",".wasm":"application/wasm",".svg":"image/svg+xml",".png":"image/png",".ttf":"font/ttf",".woff2":"font/woff2",".txt":"text/plain; charset=utf-8",".sig":"text/plain; charset=utf-8",".jwk":"application/json"};

// ---- inlined from lib/release.js
// Signed releases. Shared by the service worker (the build inlines this file
// into sw.js), the build (which signs) and the unit tests. No imports, so it
// can be inlined; only WebCrypto, available in browsers, workers and Node 22.
//
// A deployment carries three files:
//   manifest.json  {"app","version","files":[{"path","sha256","size"}, ...]}
//   release.json   {"app","version","created","manifest_sha256","file_count"}
//   release.sig    base64 of the ECDSA P-256 / SHA-256 signature (IEEE P1363,
//                  r||s, 64 bytes, the format WebCrypto produces and Safari
//                  verifies) over the exact bytes of release.json.
// The app trusts a release only when the signature verifies under the public
// key built into it, manifest.json hashes to manifest_sha256, and every file
// matches its size and SHA-256.

const RELEASE_APP_ID = 'beam-campfire-pwa';

class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'bad_signature' | 'malformed' | 'manifest_mismatch' | 'file_mismatch' | 'downgrade'
  }
}

function bytesToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

async function sha256Hex(data) {
  const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
}

function b64ToBytes(s) {
  const bin = atob(String(s).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importReleaseKey(publicJwk) {
  if (!publicJwk || publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256' || publicJwk.d)
    throw new ReleaseError('malformed', 'Release key must be a public P-256 JWK.');
  const { kty, crv, x, y } = publicJwk;
  return crypto.subtle.importKey('jwk', { kty, crv, x, y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

/** Compares "1.2.3" style versions. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Verifies release.json bytes against release.sig with the embedded key.
 * Returns the parsed release object.
 */
async function verifyReleaseSignature(releaseBytes, sigText, publicJwk) {
  const key = await importReleaseKey(publicJwk);
  let sig;
  try {
    sig = b64ToBytes(sigText);
  } catch {
    throw new ReleaseError('bad_signature', 'The release signature is not readable.');
  }
  const ok = sig.length === 64 && (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, releaseBytes));
  if (!ok) throw new ReleaseError('bad_signature', 'This update is not signed with the BEAM Campfire release key.');
  let rel;
  try {
    rel = JSON.parse(new TextDecoder().decode(releaseBytes));
  } catch {
    throw new ReleaseError('malformed', 'release.json is not JSON.');
  }
  if (rel.app !== RELEASE_APP_ID || typeof rel.version !== 'string' || !/^[0-9a-f]{64}$/.test(rel.manifest_sha256 || ''))
    throw new ReleaseError('malformed', 'release.json is missing fields.');
  return rel;
}

/** Checks manifest.json bytes against a verified release; returns the manifest. */
async function verifyManifest(release, manifestBytes) {
  const h = await sha256Hex(manifestBytes);
  if (h !== release.manifest_sha256) throw new ReleaseError('manifest_mismatch', "This update's file list is not the one that was signed.");
  const m = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (m.app !== RELEASE_APP_ID || m.version !== release.version || !Array.isArray(m.files))
    throw new ReleaseError('malformed', 'manifest.json does not belong to this release.');
  if (typeof release.file_count === 'number' && release.file_count !== m.files.length)
    throw new ReleaseError('manifest_mismatch', 'File count differs from the signed release.');
  const seen = new Set();
  for (const f of m.files) {
    if (typeof f.path !== 'string' || !/^[A-Za-z0-9._\-/]+$/.test(f.path) || f.path.includes('..') || f.path.startsWith('/'))
      throw new ReleaseError('malformed', `Bad file path in manifest: ${f.path}`);
    if (seen.has(f.path)) throw new ReleaseError('malformed', `Duplicate path ${f.path}`);
    seen.add(f.path);
    if (!/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0)
      throw new ReleaseError('malformed', `Bad entry for ${f.path}`);
  }
  return m;
}

/** Checks one downloaded file against its manifest entry. */
async function verifyFile(entry, bytes) {
  const len = bytes.byteLength;
  if (len !== entry.size) throw new ReleaseError('file_mismatch', `A file in this update (${entry.path}) is not the one that was signed.`);
  const h = await sha256Hex(bytes);
  if (h !== entry.sha256) throw new ReleaseError('file_mismatch', `A file in this update (${entry.path}) is not the one that was signed.`);
}

// ---- end of lib/release.js

const META_CACHE = 'campfire-meta';
const scopeUrl = new URL(self.registration.scope);
const STATE_KEY = new URL('__campfire_state', scopeUrl).href;
const PASSTHROUGH = [/^release\.json$/, /^release\.sig$/, /^manifest\.json$/, /^sw\.js$/, /^recovery\//, /^explorer\//, /^__dev\//, /^_headers$/];

let stateCache = null;
let updateRun = null;

function mimeFor(path) {
  const i = path.lastIndexOf('.');
  return (i >= 0 && MIME[path.slice(i).toLowerCase()]) || 'application/octet-stream';
}

async function readState() {
  if (stateCache) return stateCache;
  const c = await caches.open(META_CACHE);
  const r = await c.match(STATE_KEY);
  stateCache = r ? await r.json() : { current: null, pending: null };
  return stateCache;
}

async function writeState(st) {
  const c = await caches.open(META_CACHE);
  await c.put(STATE_KEY, new Response(JSON.stringify(st), { headers: { 'Content-Type': 'application/json' } }));
  stateCache = st;
}

function relPath(url) {
  let p = url.pathname;
  if (!p.startsWith(scopeUrl.pathname)) return null;
  p = p.slice(scopeUrl.pathname.length);
  if (p === '' || p.endsWith('/')) p += 'index.html';
  try {
    return decodeURIComponent(p);
  } catch {
    return null;
  }
}

async function fetchBytes(path) {
  let r;
  try {
    r = await fetch(new URL(path, scopeUrl).href, { cache: 'no-store', credentials: 'same-origin' });
  } catch {
    throw new ReleaseError('unreachable', `Could not download ${path}.`);
  }
  if (!r.ok) throw new ReleaseError('unreachable', `${path}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function fetchVerifiedRelease() {
  const relBytes = await fetchBytes('release.json');
  const sig = new TextDecoder().decode(await fetchBytes('release.sig'));
  const release = await verifyReleaseSignature(relBytes, sig, RELEASE_PUBLIC_JWK);
  const manifest = await verifyManifest(release, await fetchBytes('manifest.json'));
  return { release, manifest };
}

async function stageRelease({ release, manifest }) {
  const cacheName = `campfire-${release.version}-${release.manifest_sha256.slice(0, 16)}`;
  await caches.delete(cacheName);
  const cache = await caches.open(cacheName);
  try {
    for (const f of manifest.files) {
      const bytes = await fetchBytes(f.path);
      await verifyFile(f, bytes);
      await cache.put(new URL(f.path, scopeUrl).href, new Response(bytes, { headers: { 'Content-Type': mimeFor(f.path) } }));
    }
  } catch (e) {
    await caches.delete(cacheName);
    throw e;
  }
  const files = {};
  for (const f of manifest.files) files[f.path] = f.sha256;
  return { version: release.version, cache: cacheName, files, manifestSha: release.manifest_sha256, verifiedAt: Date.now() };
}

async function cleanup(st) {
  const keep = new Set([META_CACHE, st.current && st.current.cache, st.pending && st.pending.cache].filter(Boolean));
  for (const name of await caches.keys()) if (name.startsWith('campfire-') && !keep.has(name)) await caches.delete(name);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const st = await readState();
      if (!st.current) {
        // First install: nothing is served until a signed release verified.
        const current = await stageRelease(await fetchVerifiedRelease());
        await writeState({ current, pending: null, lastRefusal: null });
      }
      // A later sw.js (the browser re-downloads it on its own) changes how
      // files are served, never which files: it keeps the verified copy.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const st = await readState();
      await cleanup(st);
      await self.clients.claim();
    })(),
  );
});

function withHeaders(resp, path) {
  const h = new Headers(SECURITY_HEADERS);
  h.set('Content-Type', mimeFor(path));
  h.set('Cache-Control', 'no-cache');
  return new Response(resp.body, { status: 200, headers: h });
}

async function serve(request, path) {
  const st = await readState();
  if (st.current && Object.prototype.hasOwnProperty.call(st.current.files, path)) {
    const cache = await caches.open(st.current.cache);
    const hit = await cache.match(new URL(path, scopeUrl).href);
    if (hit) return withHeaders(hit, path);
  }
  return fetch(request);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = relPath(url);
  if (path === null || PASSTHROUGH.some((r) => r.test(path))) return;
  event.respondWith(serve(req, path));
});

async function checkUpdate() {
  const st = await readState();
  let rel;
  try {
    rel = await fetchVerifiedRelease();
  } catch (e) {
    const code = e && e.code;
    if (code === 'unreachable') return { result: 'unreachable', reason: e.message };
    st.lastRefusal = { at: Date.now(), reason: e.message };
    await writeState(st);
    return { result: 'refused', reason: e.message };
  }
  const v = rel.release.version;
  if (!st.current) return { result: 'none' };
  const cmp = compareVersions(v, st.current.version);
  if (cmp === 0 && rel.release.manifest_sha256 !== st.current.manifestSha) {
    return { result: 'refused', version: v, reason: `A different release claims version ${v}.` };
  }
  if (cmp <= 0) return { result: 'none', version: st.current.version };
  if (st.pending && st.pending.version === v && st.pending.manifestSha === rel.release.manifest_sha256) return { result: 'ready', version: v };
  try {
    const staged = await stageRelease(rel);
    st.pending = staged;
    st.lastRefusal = null;
    await writeState(st);
    await cleanup(st);
    return { result: 'ready', version: v };
  } catch (e) {
    if (e && e.code === 'unreachable') return { result: 'unreachable', reason: e.message };
    st.lastRefusal = { at: Date.now(), reason: e.message, version: v };
    await writeState(st);
    return { result: 'refused', version: v, reason: e.message };
  }
}

async function applyUpdate() {
  const st = await readState();
  if (!st.pending) return { result: 'none' };
  const next = { current: st.pending, pending: null, lastRefusal: null, previous: st.current && st.current.version };
  await writeState(next);
  await cleanup(next);
  return { result: 'applied', version: next.current.version };
}

self.addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  if (!port) return;
  const type = event.data && event.data.type;
  event.waitUntil(
    (async () => {
      try {
        if (type === 'status') {
          const st = await readState();
          port.postMessage({
            swVersion: SW_VERSION,
            current: st.current && st.current.version,
            pending: st.pending && st.pending.version,
            currentSw: st.current && st.current.files['sw.js'],
            pendingSw: st.pending && st.pending.files['sw.js'],
            lastRefusal: st.lastRefusal || null,
          });
        } else if (type === 'check-update') {
          if (!updateRun) updateRun = checkUpdate().finally(() => (updateRun = null));
          port.postMessage(await updateRun);
        } else if (type === 'apply-update') {
          port.postMessage(await applyUpdate());
        } else {
          port.postMessage({ result: 'error', reason: 'unknown request' });
        }
      } catch (e) {
        port.postMessage({ result: 'error', reason: String((e && e.message) || e) });
      }
    })(),
  );
});
