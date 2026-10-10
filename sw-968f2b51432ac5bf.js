/* BEAM Campfire service worker (the "loader").
 *
 * It serves the app only from a release it verified itself:
 *   - release.json is signed (ECDSA P-256 / SHA-256) by the BEAM Campfire
 *     release key, whose public half is built into this file;
 *   - manifest.json must hash to the value in release.json;
 *   - every file must match its size and SHA-256 in manifest.json.
 *
 * First install: files are downloaded (6 at a time, largest first) into a staging cache and
 * each is kept only after its hash matched. The install can be interrupted
 * (app closed, connection lost) and continues where it stopped: files already
 * staged are re-checked and kept. Nothing is served until the whole signed
 * release verified. Progress is written to the meta cache, where the page
 * reads it to show "x of y files checked".
 *
 * Installed: every app file comes from the verified copy and nothing else.
 * A path that is not in the release gets a 404 from here, never a network
 * request, so the app keeps working when its web address is down, returns 404
 * everywhere or serves a parking page. Later releases are downloaded and
 * verified only on request ("check-update": the Check for updates button)
 * into a separate cache, and become the served copy only on "apply-update",
 * which only the Update button sends.
 *
 * Update sources (lib/update_sources.js, inlined below): this app's own
 * address first, then the public copies the installed release names, then an
 * address the person added. The first that answers with a valid signed release
 * decides; the rest are never contacted. Files from any source go into this
 * app's own cache under its own scope URLs, each only after its hash matched.
 * A release from anywhere but the own address must run under THIS loader (a
 * service worker comes only from its own address), so it is staged only when
 * it ships this loader or one that serves pages the same way (loader_compat).
 *
 * Every response gets the security headers (COOP/COEP for the engine's
 * SharedArrayBuffer, CSP, CORP): a response from the cache would carry none.
 * When the person uses their own BEAM node, its wss origin - exactly that one -
 * is added to connect-src for every page and worker served ("set-node", kept
 * in the meta cache). node_probe.html, the frame that checks an address before
 * it is saved, gets a policy that allows only the address it is checking
 * (lib/node_address.js, inlined below), and only as a frame of this app.
 *
 * dApp frames: a navigation to dapp-run/<policy>/... is answered with the
 * frame document built from the verified dapp-frame.js and the frame's own
 * headers (lib/dapps/frame_policy.js, inlined below): a sandboxed, opaque
 * origin with its own CSP. Nothing for that route ever comes from the network.
 *
 * Not intercepted (they go to the network, and only when the app asks):
 * release.json/.sig, manifest.json, the loader script, the recovery snapshot,
 * the explorer status and dev-server paths. The BEAM node is a WebSocket,
 * which never passes here.
 *
 * This file carries nothing release-specific (no version), so its bytes - and
 * its content-addressed name, sw-<hash>.js - stay the same across releases
 * unless the loader itself changes. A legitimate deployment therefore never
 * changes the bytes at a loader URL a phone has registered, which is what
 * lets the page treat any such change as a warning sign (lib/loader.js).
 *
 * The build (tools/build.mjs) fills in the placeholders and inlines
 * lib/release.js where marked.
 */
'use strict';

const RELEASE_PUBLIC_JWK = {"kty":"EC","crv":"P-256","x":"nHc0TAS1zffyZvN4tSmEyelt5vpEB-QDUEgHSNztzpc","y":"hHBISFLKDalMgMsjuW78PAMirodfcnlZ5N3-9A9Pa9A"};
const SECURITY_HEADERS = {"Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Embedder-Policy":"require-corp","Cross-Origin-Resource-Policy":"same-origin","Content-Security-Policy":"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' wss://eu-node02.mainnet.beam.mw:8200 wss://eu-node03.mainnet.beam.mw:8200 wss://eu-node04.mainnet.beam.mw:8200 wss://eu-nodes.mainnet.beam.mw:8200 wss://eu-node01.mainnet.beam.mw:8200 https://raw.githubusercontent.com/BeamMW/beam-ui/2f36c21ed010dee350c052ffce9097b23f69ecfb/ui/apps/mainnet/ https://eth2.stackwallet.com https://ethereum-rpc.publicnode.com https://eth.drpc.org https://rpc.mevblocker.io https://eth-mainnet.public.blastapi.io https://api.coingecko.com/api/v3/simple/price https://buybeam.my/api/v1/buy/ https://pwa.buybeam.my/recovery/; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","Permissions-Policy":"camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()"};
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

// ---- inlined from lib/update_sources.js
// Where "Check for updates" looks for a newer signed release, and how it picks
// one. Shared by the service worker (the build inlines this file into sw.js,
// after lib/release.js, whose names it uses), the page (an address the person
// adds) and the unit tests. The only import is lib/release.js; the build drops
// that line when inlining.
//
// Every source is held to the same checks (lib/release.js): the signature under
// the key built into the app, the manifest hash, every file's size and SHA-256,
// the app id, and a version strictly newer than the one installed. So where the
// bytes come from does not decide what runs; it only decides whether an update
// can be found at all once the app's own address is gone.
//
// Order: this app's own address, then the copies below (or the list the
// installed, signed release names), then an address the person added. The
// first source that answers with a valid signed release of the installed
// version or newer decides; one that does not answer, sends no CORS headers,
// sends something unsigned or altered, or is behind the installed version is
// noted and the next one is asked.

// Public copies of the published release (github.com/vsnation/beam-campfire-pwa),
// each serving every file with Access-Control-Allow-Origin: *. Fresher first:
// raw.githubusercontent.com caches 5 min, GitHub Pages 10 min, jsDelivr up to 12 h.
// tools/build.mjs writes this list into release.json (signed), and the loader
// prefers the installed release's list, so a release can change it without a
// new loader.
const BUILTIN_SOURCES = Object.freeze([
  'https://raw.githubusercontent.com/vsnation/beam-campfire-pwa/main/',
  'https://vsnation.github.io/beam-campfire-pwa/',
  'https://cdn.jsdelivr.net/gh/vsnation/beam-campfire-pwa@main/',
]);

const MAX_SOURCE_LENGTH = 2000;
const MAX_RELEASE_SOURCES = 10;
const MAX_ADDED_SOURCES = 3;

/**
 * An address the person typed or pasted, as the folder a copy is served from:
 * https only, no user name or password, no query or fragment, a trailing slash.
 * An address typed without a scheme ("example.org/campfire") gets https, and
 * a link to the copy's index.html or release.json means its folder.
 * Returns {ok: true, url} or {ok: false, reason}.
 */
function normalizeSource(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return { ok: false, reason: 'Paste the address of a copy of BEAM Campfire.' };
  if (s.length > MAX_SOURCE_LENGTH) return { ok: false, reason: 'That address is too long.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: "That isn't a web address." };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'Use an address that starts with https://.' };
  if (u.username || u.password) return { ok: false, reason: 'Leave out the user name and password: the address must work without them.' };
  if (!u.hostname) return { ok: false, reason: "That isn't a web address." };
  u.hash = '';
  u.search = '';
  u.pathname = u.pathname.replace(/\/(index\.html|release\.json|release\.sig|manifest\.json)$/i, '/');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return { ok: true, url: u.href };
}

/** The list a signed release names (release.json update_sources), cleaned; null when it names none. */
function releaseSources(release) {
  if (!release || !Array.isArray(release.update_sources)) return null;
  const out = [];
  for (const s of release.update_sources.slice(0, MAX_RELEASE_SOURCES)) {
    if (typeof s !== 'string') continue;
    const n = normalizeSource(s);
    if (n.ok && !out.includes(n.url)) out.push(n.url);
  }
  return out;
}

/**
 * Every place to ask, in order, each once: {url, host, kind: 'own'|'builtin'|'added', own}.
 * own is the app's own folder (the service worker's scope).
 */
function updateSources({ own, builtins = BUILTIN_SOURCES, added = [] }) {
  const out = [];
  const seen = new Set();
  const push = (url, kind) => {
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, host: new URL(url).host, kind, own: kind === 'own' });
  };
  push(new URL(own).href, 'own');
  for (const b of builtins || []) {
    const n = normalizeSource(b);
    if (n.ok) push(n.url, 'builtin');
  }
  for (const a of (added || []).slice(0, MAX_ADDED_SOURCES)) {
    if (typeof a !== 'string') continue;
    const n = normalizeSource(a);
    if (n.ok) push(n.url, 'added');
  }
  return out;
}

/**
 * Whether a release can run under the loader that is running now. A service
 * worker can only come from the app's own address, so a release from anywhere
 * else runs under the current loader until that address answers again. That
 * is safe when the release ships this very loader, or one that serves pages
 * exactly as this one does: the same security headers, MIME types, dApp frame
 * policy and page <-> loader contract (the build hashes those into
 * loader_compat; sw.js holds its own value).
 */
function loaderCompatible(release, loader) {
  if (!release || !loader || typeof release.loader !== 'string') return false;
  if (release.loader === loader.name) return true;
  return typeof release.loader_compat === 'string' && Boolean(loader.compat) && release.loader_compat === loader.compat;
}

/**
 * release.json, its signature and manifest.json from one source, verified.
 * get(path) returns the bytes. Something that is not this app's release.json
 * at all (a parking page, another app, an error page) means there is no
 * release there: 'unreachable', not 'refused'. A release.json that names this
 * app but fails the signature or the manifest hash is refused.
 */
async function readRelease(get, publicJwk) {
  const relBytes = await get('release.json');
  let claimed = null;
  try {
    claimed = JSON.parse(new TextDecoder().decode(relBytes));
  } catch {
    claimed = null;
  }
  if (!claimed || claimed.app !== RELEASE_APP_ID) throw new ReleaseError('unreachable', 'No BEAM Campfire release is published at this address.');
  const sig = new TextDecoder().decode(await get('release.sig'));
  const release = await verifyReleaseSignature(relBytes, sig, publicJwk);
  const manifest = await verifyManifest(release, await get('manifest.json'));
  return { release, manifest };
}

const reasonOf = (e) => String((e && e.message) || e || 'unknown error');
const isUnreachable = (e) => !e || !e.code || e.code === 'unreachable';

/**
 * Asks each source in turn. installed/pending: {version, manifestSha} (pending
 * also {from}); loader: {name, compat}. fetchRelease(source) -> {release,
 * manifest}; stage(source, rel) downloads and verifies every file (and throws
 * on the first that fails). Nothing is staged from a source other than the own
 * address when the release could not run under the current loader.
 *
 * Returns {result, version?, reason?, from?: {host, own}, tried: [...]}, where
 * result is 'ready' (a newer release is verified and waiting for Update),
 * 'none' (nothing newer anywhere that answered), 'needs_own_address' (newer,
 * but only installable from the own address), 'refused' (only altered or
 * unsigned releases answered) or 'unreachable' (no release answered at all).
 */
async function findUpdate({ sources, installed, pending = null, loader, fetchRelease, stage, onSource = null }) {
  const tried = [];
  const note = (src, outcome, extra = {}) => {
    const t = { host: src.host, kind: src.kind, own: src.own, outcome, ...extra };
    tried.push(t);
    return t;
  };
  const from = (t) => ({ host: t.host, own: t.own });
  let refused = null;
  let blocked = null;
  let behind = false;
  for (const src of sources) {
    if (onSource) await onSource(src);
    let rel;
    try {
      rel = await fetchRelease(src);
    } catch (e) {
      const t = note(src, isUnreachable(e) ? 'unreachable' : 'refused', { reason: reasonOf(e) });
      if (t.outcome === 'refused' && !refused) refused = t;
      continue;
    }
    const v = rel.release.version;
    const cmp = compareVersions(v, installed.version);
    if (cmp < 0) {
      note(src, 'older', { version: v });
      behind = true;
      continue;
    }
    if (cmp === 0) {
      if (rel.release.manifest_sha256 !== installed.manifestSha) {
        const t = note(src, 'refused', { version: v, reason: `A different release claims version ${v}.` });
        if (!refused) refused = t;
        continue;
      }
      const t = note(src, 'same', { version: v });
      return { result: 'none', version: installed.version, from: from(t), tried };
    }
    if (pending && pending.version === v && pending.manifestSha === rel.release.manifest_sha256) {
      const t = note(src, 'ready', { version: v });
      return { result: 'ready', version: v, from: pending.from || from(t), tried };
    }
    if (!src.own && !loaderCompatible(rel.release, loader)) {
      const t = note(src, 'needs_own_address', { version: v });
      if (!blocked) blocked = t;
      continue;
    }
    try {
      await stage(src, rel);
    } catch (e) {
      const t = note(src, isUnreachable(e) ? 'unreachable' : 'refused', { version: v, reason: reasonOf(e) });
      if (t.outcome === 'refused' && !refused) refused = t;
      continue;
    }
    const t = note(src, 'ready', { version: v });
    return { result: 'ready', version: v, from: from(t), tried };
  }
  if (blocked) return { result: 'needs_own_address', version: blocked.version, from: from(blocked), tried };
  if (refused) return { result: 'refused', version: refused.version || null, reason: refused.reason, from: from(refused), tried };
  if (behind) return { result: 'none', version: installed.version, tried };
  return { result: 'unreachable', tried };
}

// ---- end of lib/update_sources.js

// ---- inlined from lib/dapps/frame_policy.js
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

const FRAME_ROUTE = 'dapp-run/';

/** Every remote origin a dApp may be granted, by bit (1, 2, ...). */
const REMOTE_ORIGINS = ['https://api.coingecko.com', 'https://explorer-api.beam.mw'];

const SEGMENT = /^e([01])r(0|[1-9][0-9]?)$/;

function policySegment({ evalAllowed, remoteMask = 0 }) {
  const mask = Number(remoteMask) >>> 0;
  if (mask >= 1 << REMOTE_ORIGINS.length) throw new Error('remote mask out of range');
  return `e${evalAllowed ? 1 : 0}r${mask}`;
}

function parsePolicySegment(seg) {
  const m = SEGMENT.exec(String(seg));
  if (!m) return null;
  const mask = Number(m[2]);
  if (mask >= 1 << REMOTE_ORIGINS.length) return null;
  return { evalAllowed: m[1] === '1', remoteMask: mask, remoteOrigins: REMOTE_ORIGINS.filter((_, i) => mask & (1 << i)) };
}

function remoteMaskFor(origins) {
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
function frameRouteFor(relPath) {
  if (typeof relPath !== 'string' || !relPath.startsWith(FRAME_ROUTE)) return null;
  const rest = relPath.slice(FRAME_ROUTE.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return parsePolicySegment(rest.slice(0, slash));
}

/** The frame's Content-Security-Policy. No 'self' anywhere: the wallet's origin is not the frame's to reach. */
function frameCsp({ evalAllowed, remoteOrigins, nonce }) {
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

function frameHeaders(policy, nonce) {
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
function frameDocument(scriptText, nonce) {
  if (String(scriptText).toLowerCase().includes('</script')) throw new Error('the frame script cannot contain </script');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><script nonce="${nonce}">${scriptText}</script></head><body></body></html>`;
}

/** 24 random bytes, base64url. */
function newNonce() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- end of lib/dapps/frame_policy.js

// ---- inlined from lib/node_address.js
// The address of the person's own BEAM node: host:port and nothing else.
// Shared by the page, the node check frame (node_probe.js) and the service
// worker: the build inlines this file into sw.js, so it imports nothing. The
// worker runs every address through normalizeNodeAddress before it goes into a
// Content-Security-Policy, so nothing but [a-z0-9.-], one colon and a port can
// ever reach that header.

const NODE_EXAMPLE = 'node.example.com:8200';

const fail = (code, error) => ({ ok: false, code, error });

function validIPv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
}

function validHostname(host) {
  if (host.length > 253) return false;
  const labels = host.split('.');
  // An all-digit last label would be read as a (shortened) IPv4 address.
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return false;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/**
 * "wss://Node.Example.com:8200/" -> {ok: true, address: "node.example.com:8200", host, port}.
 * Refused, each with a plain sentence: a scheme other than wss://, a user name
 * or password, a path, query or fragment, IPv6 (CSP host sources cannot name
 * one), a missing or out-of-range port, anything that is not a host name or an
 * IPv4 address.
 */
function normalizeNodeAddress(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return fail('empty', `Type your node's address, for example ${NODE_EXAMPLE}.`);
  if (/^wss:\/\//i.test(s)) s = s.slice(6);
  else if (/^ws:\/\//i.test(s)) return fail('insecure', `The app connects to nodes over a secure connection (wss) only. Type the address without ws://, like ${NODE_EXAMPLE}.`);
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return fail('scheme', `Leave out ${s.slice(0, s.indexOf('://') + 3)} and type only the host and port, like ${NODE_EXAMPLE}.`);
  if (s.endsWith('/')) s = s.slice(0, -1);
  if (s.includes('@')) return fail('credentials', `Leave out the user name and password: type only the host and port, like ${NODE_EXAMPLE}.`);
  if (/[/?#\\]/.test(s)) return fail('path', `Leave out everything after the port: type only the host and port, like ${NODE_EXAMPLE}.`);
  if (/\s/.test(s)) return fail('host', `An address has no spaces. It looks like ${NODE_EXAMPLE}.`);
  if (s.startsWith('[') || (s.match(/:/g) || []).length > 1) return fail('ipv6', "IPv6 addresses can't be used here. Use the node's host name or its IPv4 address.");
  const colon = s.lastIndexOf(':');
  if (colon < 0) return fail('port', `Add the port your node accepts wallets on (its websocket_port), like ${NODE_EXAMPLE}.`);
  const portText = s.slice(colon + 1);
  if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) return fail('port', 'The port must be a number from 1 to 65535.');
  const port = Number(portText);
  let host = s.slice(0, colon).toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (/[^\x21-\x7e]/.test(host)) {
    // An international name: its ASCII (punycode) form is what DNS and the CSP use.
    try {
      host = new URL(`wss://${host}/`).hostname;
    } catch {
      host = '';
    }
  }
  const dotted = /^[0-9.]+$/.test(host);
  if (!host || (dotted ? !validIPv4(host) : !validHostname(host))) return fail('host', `That is not a host name or an IPv4 address. It looks like ${NODE_EXAMPLE}.`);
  return { ok: true, address: `${host}:${port}`, host, port };
}

/** The WebSocket origin of a checked address: "wss://host:port". */
function nodeOrigin(address) {
  const n = normalizeNodeAddress(address);
  if (!n.ok) throw new Error('not a node address');
  return `wss://${n.address}`;
}

/** `csp` with the person's own node added to connect-src, and nothing else changed. null: `csp` itself. */
function cspWithNode(csp, address) {
  if (address == null) return csp;
  const origin = nodeOrigin(address);
  return csp
    .split('; ')
    .map((d) => (d.startsWith('connect-src ') && !d.split(' ').includes(origin) ? `${d} ${origin}` : d))
    .join('; ');
}

/**
 * The policy of the node check frame: it may run this app's own scripts and
 * open a WebSocket to the one address being checked, nothing else, and only
 * this app's own pages may frame it.
 */
function probeCsp(address) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `connect-src ${nodeOrigin(address)}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}

const NODE_PROBE_PAGE = 'node_probe.html';
const PROBE_ID = /^[a-z0-9]{8,40}$/;

// ---- end of lib/node_address.js

const META_CACHE = 'campfire-meta';
const scopeUrl = new URL(self.registration.scope);
const STATE_KEY = new URL('__campfire_state', scopeUrl).href;
const PROGRESS_KEY = new URL('__campfire_install', scopeUrl).href;
const OWN_NODE_KEY = new URL('__campfire_node', scopeUrl).href;
const PASSTHROUGH = [/^release\.json$/, /^release\.sig$/, /^manifest\.json$/, /^sw(-[0-9a-f]+)?\.js$/, /^recovery\//, /^explorer\//, /^__dev\//, /^_headers$/];
const PARALLEL = 6;
const FRAME_SCRIPT = 'dapp-frame.js';
const FILE_TIMEOUT_MS = 90000; // per file: a stalled connection fails the run, which can then resume
const PROBE_TIMEOUT_MS = 30000; // release.json/.sig/manifest.json at one update source, then the next
const MAX_META_BYTES = 4 * 1024 * 1024; // release.json, release.sig or manifest.json larger than this is not ours
// The page <-> loader contract. Raise it when page code starts to rely on
// something only a newer loader does (a message, a route, a header): it is
// part of LOADER_COMPAT, so such a release then installs only from the own
// address, where its loader comes along.
const LOADER_API = 2;
// Hash of what this loader does to pages (security headers, MIME types, dApp
// frame policy, the own-node policy, LOADER_API), filled in by the build; release.json carries the
// same value for the release's own loader (see loaderCompatible()).
const LOADER_COMPAT = "58bb6cf6516114b22ecd365c6cab6b16d8f49c97ea89e0108d7b3360a92f856c";
const LOADER_NAME = self.location.pathname.split('/').pop();

let stateCache = null;
let ownNodeCache; // the person's own node "host:port", null for BEAM's pool; undefined until read
let updateRun = null;
const updateListeners = new Set();
let installAbort = null;

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

async function readOwnNode() {
  if (ownNodeCache !== undefined) return ownNodeCache;
  let saved = null;
  try {
    const r = await (await caches.open(META_CACHE)).match(OWN_NODE_KEY);
    saved = r ? await r.json() : null;
  } catch {
    saved = null;
  }
  const n = saved && saved.node ? normalizeNodeAddress(saved.node) : null;
  ownNodeCache = n && n.ok ? n.address : null;
  return ownNodeCache;
}

async function writeOwnNode(address) {
  const c = await caches.open(META_CACHE);
  if (address) await c.put(OWN_NODE_KEY, new Response(JSON.stringify({ node: address }), { headers: { 'Content-Type': 'application/json' } }));
  else await c.delete(OWN_NODE_KEY);
  ownNodeCache = address;
}

/** The security headers, with the person's own node (if any) in connect-src. */
function pageHeaders(ownNode) {
  return ownNode ? { ...SECURITY_HEADERS, 'Content-Security-Policy': cspWithNode(SECURITY_HEADERS['Content-Security-Policy'], ownNode) } : SECURITY_HEADERS;
}

/** What the first-run screen shows. The page reads it from the meta cache. */
async function writeProgress(p) {
  try {
    const c = await caches.open(META_CACHE);
    await c.put(PROGRESS_KEY, new Response(JSON.stringify({ ...p, at: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
  } catch {
    /* progress is only for the screen */
  }
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

/** Reads a response body, giving up once it is larger than max bytes. */
async function readCapped(r, max, tooBig) {
  const announced = Number(r.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > max) throw tooBig();
  if (!r.body || !Number.isFinite(max)) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      reader.cancel().catch(() => {});
      throw tooBig();
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/**
 * One file of a release from base (this app's folder or another copy).
 * Another copy gets no cookies and no referrer; it must send CORS headers,
 * or the browser hands nothing over (reported as unreachable).
 */
async function fetchBytes(base, path, { signal = null, timeoutMs = FILE_TIMEOUT_MS, max = Infinity, tooBig = null } = {}) {
  const url = new URL(path, base);
  const own = url.origin === self.location.origin;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort);
  }
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const where = own ? '' : ` from ${url.host}`;
  try {
    let r;
    try {
      r = await fetch(url.href, { cache: 'no-store', credentials: own ? 'same-origin' : 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal });
    } catch {
      throw new ReleaseError('unreachable', `Could not download ${path}${where}.`);
    }
    if (!r.ok) throw new ReleaseError('unreachable', `${path}${where}: HTTP ${r.status}`);
    try {
      return await readCapped(r, max, tooBig || (() => new ReleaseError('unreachable', `${path}${where} is far larger than a BEAM Campfire release file.`)));
    } catch (e) {
      if (e instanceof ReleaseError) throw e;
      throw new ReleaseError('unreachable', `The download of ${path}${where} was interrupted.`);
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** release.json + its signature + manifest.json from base, verified (readRelease in lib/update_sources.js). */
function fetchVerifiedRelease(base, { signal = null, timeoutMs = FILE_TIMEOUT_MS } = {}) {
  return readRelease((path) => fetchBytes(base, path, { signal, timeoutMs, max: MAX_META_BYTES }), RELEASE_PUBLIC_JWK);
}

const cacheNameFor = (release) => `campfire-${release.version}-${release.manifest_sha256.slice(0, 16)}`;

/**
 * Downloads and verifies every file of a release into its own cache.
 * Resumable: entries already in that cache are re-checked against the manifest
 * and kept. The cache is recorded as state.staging so cleanup keeps it, and it
 * is never served until it has become state.current (first install, every
 * file verified) or state.pending and then current (Update button).
 */
async function stageRelease({ release, manifest }, { base = scopeUrl, signal = null, report = null } = {}) {
  const cacheName = cacheNameFor(release);
  const st = await readState();
  if (st.staging !== cacheName) await writeState({ ...st, staging: cacheName });
  const cache = await caches.open(cacheName);
  const files = manifest.files;
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const prog = { state: 'downloading', version: release.version, total: files.length, totalBytes, done: 0, doneBytes: 0, resumed: 0, error: null };
  const todo = [];
  for (const f of files) {
    const key = new URL(f.path, scopeUrl).href;
    const hit = await cache.match(key);
    if (hit) {
      try {
        await verifyFile(f, new Uint8Array(await hit.arrayBuffer()));
        prog.done++;
        prog.doneBytes += f.size;
        prog.resumed++;
        continue;
      } catch {
        await cache.delete(key);
      }
    }
    todo.push(f);
  }
  if (report) await report(prog);
  // Biggest first, so the engine (5.8 MB) is not the last thing left on a slow line.
  todo.sort((a, b) => b.size - a.size);
  let next = 0;
  let failure = null;
  const run = new AbortController();
  const onOuterAbort = () => run.abort();
  if (signal) signal.addEventListener('abort', onOuterAbort);
  const worker = async () => {
    while (!failure && next < todo.length) {
      const f = todo[next++];
      try {
        // Never more than the signed size: a larger answer fails the check without being read whole.
        const bytes = await fetchBytes(base, f.path, { signal: run.signal, max: f.size, tooBig: () => new ReleaseError('file_mismatch', `A file in this update (${f.path}) is not the one that was signed.`) });
        await verifyFile(f, bytes);
        await cache.put(new URL(f.path, scopeUrl).href, new Response(bytes, { headers: { 'Content-Type': mimeFor(f.path) } }));
        prog.done++;
        prog.doneBytes += f.size;
        if (report) await report(prog);
      } catch (e) {
        if (!failure) failure = e;
        run.abort();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
  } finally {
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
  if (failure) throw failure;
  const map = {};
  for (const f of files) map[f.path] = f.sha256;
  return {
    version: release.version,
    cache: cacheName,
    files: map,
    manifestSha: release.manifest_sha256,
    verifiedAt: Date.now(),
    // Where the next check looks, from the signed release; the loader that ships with it; and
    // what that loader does to pages (see loaderCompatible()).
    sources: releaseSources(release),
    loader: typeof release.loader === 'string' ? release.loader : null,
    loaderCompat: typeof release.loader_compat === 'string' ? release.loader_compat : null,
  };
}

async function cleanup(st) {
  const keep = new Set([META_CACHE, st.current && st.current.cache, st.pending && st.pending.cache, st.staging].filter(Boolean));
  for (const name of await caches.keys()) if (name.startsWith('campfire-') && !keep.has(name)) await caches.delete(name);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const st = await readState();
      if (!st.current) {
        // First install: nothing is served until a signed release verified.
        installAbort = new AbortController();
        const signal = installAbort.signal;
        try {
          await writeProgress({ state: 'checking', done: 0, total: 0, doneBytes: 0, totalBytes: 0, error: null });
          const rel = await fetchVerifiedRelease(scopeUrl, { signal });
          let last = null;
          const current = await stageRelease(rel, { signal, report: (p) => writeProgress((last = p)) });
          const now = await readState();
          await writeState({ ...now, current, pending: null, staging: null, lastRefusal: null });
          await writeProgress({ ...(last || {}), state: 'done', version: current.version, error: null });
        } catch (e) {
          const code = signal.aborted ? 'stopped' : (e && e.code) || 'error';
          await writeProgress({ state: 'failed', error: { code, message: String((e && e.message) || e) } });
          throw e;
        } finally {
          installAbort = null;
        }
      }
      // Another loader (the page registers one only after an Update the person
      // approved) changes how files are served, never which files: it keeps
      // the verified copy.
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

function withHeaders(resp, path, base = SECURITY_HEADERS) {
  const h = new Headers(base);
  h.set('Content-Type', mimeFor(path));
  h.set('Cache-Control', 'no-cache');
  return new Response(resp.body, { status: 200, headers: h });
}

async function serve(request, path) {
  const st = await readState();
  if (!st.current) return fetch(request); // not installed yet: no page is controlled by this worker then
  if (Object.prototype.hasOwnProperty.call(st.current.files, path)) {
    const cache = await caches.open(st.current.cache);
    const hit = await cache.match(new URL(path, scopeUrl).href);
    if (hit && path === NODE_PROBE_PAGE) return probeResponse(request, hit);
    if (hit) return withHeaders(hit, path, pageHeaders(await readOwnNode()));
  }
  // Installed: only the verified copy is served; nothing is fetched from the web address.
  return new Response('Not part of this BEAM Campfire release.', { status: 404, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** The node check frame: only as a frame, and allowed to reach only the address in its query. */
function probeResponse(request, hit) {
  const n = normalizeNodeAddress(new URL(request.url).searchParams.get('node'));
  if (request.destination !== 'iframe' || !n.ok) return notInRelease();
  const h = new Headers(SECURITY_HEADERS);
  h.set('Content-Security-Policy', probeCsp(n.address));
  h.set('Content-Type', mimeFor(NODE_PROBE_PAGE));
  h.set('Cache-Control', 'no-store');
  return new Response(hit.body, { status: 200, headers: h });
}

const notInRelease = () => new Response('Not part of this BEAM Campfire release.', { status: 404, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });

/** A dApp frame document: the verified bootstrap under a fresh nonce, with the frame's own headers. */
async function serveFrame(request, policy) {
  if (request.mode !== 'navigate') return notInRelease();
  const st = await readState();
  if (!st.current || !Object.prototype.hasOwnProperty.call(st.current.files, FRAME_SCRIPT)) return notInRelease();
  const cache = await caches.open(st.current.cache);
  const hit = await cache.match(new URL(FRAME_SCRIPT, scopeUrl).href);
  if (!hit) return notInRelease();
  const nonce = newNonce();
  return new Response(frameDocument(await hit.text(), nonce), { status: 200, headers: frameHeaders(policy, nonce) });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = relPath(url);
  if (path === null || PASSTHROUGH.some((r) => r.test(path))) return;
  if (path.startsWith(FRAME_ROUTE)) {
    const policy = frameRouteFor(path);
    event.respondWith(policy ? serveFrame(req, policy) : Promise.resolve(notInRelease()));
    return;
  }
  event.respondWith(serve(req, path));
});

/**
 * "Check for updates": asks the sources in order (findUpdate in
 * lib/update_sources.js) and stages the first newer release it may install.
 * added: addresses the person added. progress(p) gets {step, host, own, ...}.
 */
async function checkUpdate({ added = [], progress = null } = {}) {
  const st = await readState();
  if (!st.current) return { result: 'none' };
  const say = (p) => {
    if (progress) progress(p);
  };
  const sources = updateSources({ own: scopeUrl.href, builtins: Array.isArray(st.current.sources) ? st.current.sources : BUILTIN_SOURCES, added });
  const ownFrom = { host: scopeUrl.host, own: true };
  const r = await findUpdate({
    sources,
    installed: { version: st.current.version, manifestSha: st.current.manifestSha },
    pending: st.pending ? { version: st.pending.version, manifestSha: st.pending.manifestSha, from: st.pending.from || ownFrom } : null,
    loader: { name: LOADER_NAME, compat: LOADER_COMPAT },
    onSource: (src) => say({ step: 'checking', host: src.host, own: src.own }),
    fetchRelease: (src) => fetchVerifiedRelease(src.url, { timeoutMs: PROBE_TIMEOUT_MS }),
    stage: async (src, rel) => {
      const staged = await stageRelease(rel, {
        base: src.url,
        report: (p) => say({ step: 'downloading', host: src.host, own: src.own, version: rel.release.version, done: p.done, total: p.total }),
      });
      const now = await readState();
      const next = { ...now, pending: { ...staged, from: { host: src.host, own: src.own } }, staging: null, lastRefusal: null };
      await writeState(next);
      await cleanup(next);
    },
  });
  if (r.result === 'refused') {
    const now = await readState();
    await writeState({ ...now, lastRefusal: { at: Date.now(), reason: r.reason, version: r.version || undefined, host: r.from && !r.from.own ? r.from.host : undefined } });
  }
  return r;
}

/**
 * Switches to the staged release. A release whose loader this one cannot
 * stand in for (loaderCompatible) is switched to only when the page says its
 * own address just served that loader with the signed bytes (loaderReady): the
 * page then moves to it right after the reload. Otherwise it stays staged.
 */
async function applyUpdate({ loaderReady = false } = {}) {
  const st = await readState();
  if (!st.pending) return { result: 'none' };
  const p = st.pending;
  const compatible = loaderCompatible({ loader: p.loader, loader_compat: p.loaderCompat }, { name: LOADER_NAME, compat: LOADER_COMPAT });
  if (!compatible && !loaderReady) {
    const l = releaseLoaderOf(p);
    return { result: 'needs_loader', version: p.version, loader: l && l.path, loaderSha256: l && l.sha256 };
  }
  const next = { current: p, pending: null, staging: null, lastRefusal: null, previous: st.current && st.current.version };
  await writeState(next);
  await cleanup(next);
  return { result: 'applied', version: next.current.version, from: p.from || null };
}

/** The loader file the installed release ships, with its signed SHA-256 (for the page's move to it). */
function releaseLoaderOf(rec) {
  if (!rec || !rec.files) return null;
  const path = rec.loader || Object.keys(rec.files).find((f) => /^sw(-[0-9a-f]+)?\.js$/.test(f));
  return path && rec.files[path] ? { path, sha256: rec.files[path] } : null;
}

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'abort-install') {
    // The first-run screen saw no progress for a while: end this run now. The
    // page registers again, and the next run resumes from what was verified.
    if (installAbort) installAbort.abort();
    return;
  }
  if (type === 'skip-waiting') {
    // The page moves to this loader once, after an Update the person approved.
    // Chrome can drop the skipWaiting() made during install when the old loader
    // is busy with the page's reload (measured: this loader then waited five
    // minutes behind the old one), so the page asks again once it is waiting.
    event.waitUntil(self.skipWaiting());
    return;
  }
  const port = event.ports && event.ports[0];
  if (!port) return;
  event.waitUntil(
    (async () => {
      try {
        if (type === 'status') {
          const st = await readState();
          port.postMessage({
            loader: LOADER_NAME,
            api: LOADER_API,
            compat: LOADER_COMPAT,
            current: st.current && st.current.version,
            currentFrom: (st.current && st.current.from) || null,
            pending: st.pending && st.pending.version,
            pendingFrom: (st.pending && st.pending.from) || null,
            currentFiles: st.current ? Object.keys(st.current.files).length : 0,
            releaseLoader: releaseLoaderOf(st.current),
            sources: st.current ? updateSources({ own: scopeUrl.href, builtins: Array.isArray(st.current.sources) ? st.current.sources : BUILTIN_SOURCES }).map((x) => ({ host: x.host, kind: x.kind })) : [],
            lastRefusal: st.lastRefusal || null,
          });
        } else if (type === 'check-update') {
          // One check at a time; every page that asks hears its progress and its answer.
          const added = Array.isArray(event.data.added) ? event.data.added.slice(0, MAX_ADDED_SOURCES) : [];
          if (event.data.progress === true) updateListeners.add(port);
          if (!updateRun) {
            updateRun = checkUpdate({ added, progress: (p) => updateListeners.forEach((l) => l.postMessage({ progress: p })) }).finally(() => {
              updateRun = null;
              updateListeners.clear();
            });
          }
          const r = await updateRun;
          updateListeners.delete(port);
          port.postMessage(r);
        } else if (type === 'apply-update') {
          port.postMessage(await applyUpdate({ loaderReady: event.data.loaderReady === true }));
        } else if (type === 'set-node') {
          // The person's own node (or null for BEAM's pool): from the next page load on, in connect-src.
          const raw = event.data.node;
          const n = raw == null ? null : normalizeNodeAddress(raw);
          if (n && !n.ok) port.postMessage({ result: 'refused', reason: n.error });
          else {
            await writeOwnNode(n ? n.address : null);
            port.postMessage({ result: 'saved', node: n ? n.address : null });
          }
        } else {
          port.postMessage({ result: 'error', reason: 'unknown request' });
        }
      } catch (e) {
        port.postMessage({ result: 'error', reason: String((e && e.message) || e) });
      }
    })(),
  );
});
