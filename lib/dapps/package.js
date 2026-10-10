// Getting a dApp package: download from BEAM's GitHub, check it against the
// pin, keep the checked bytes on this device, and open it.
//
// Nothing runs unless the bytes match the catalogue's size and SHA-256. The
// copy kept on the device (Cache API, "dapp-packages", keyed by the pinned
// SHA-256) is checked again every time it is opened; a copy that no longer
// matches is deleted and downloaded again.

import { sourceUrl } from './catalogue.js';
import { readZip } from './zip.js';

export class PackageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'network' | 'size' | 'hash' | 'zip' | 'manifest' | 'aborted'
  }
}

// Not "campfire-...": the loader deletes caches with that prefix that are not a release.
const CACHE_NAME = 'dapp-packages';

export function toHex(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export async function sha256Hex(bytes) {
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

/** Throws PackageError('size'|'hash') unless `bytes` are exactly the pinned package. */
export async function verifyPackage(entry, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== entry.size) {
    throw new PackageError('size', `${entry.fileName} is ${bytes ? bytes.length : 0} bytes, the pin says ${entry.size}.`);
  }
  const got = await sha256Hex(bytes);
  if (got !== entry.sha256) throw new PackageError('hash', `${entry.fileName} does not match its fingerprint (SHA-256 ${got.slice(0, 16)}…, pinned ${entry.sha256.slice(0, 16)}…).`);
  return bytes;
}

/**
 * Downloads the package and verifies it. onProgress(done, total) as bytes arrive.
 * fetchImpl is for tests.
 */
export async function downloadPackage(entry, { onProgress = null, signal = null, fetchImpl = globalThis.fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(sourceUrl(entry), { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', signal });
  } catch (e) {
    if (signal && signal.aborted) throw new PackageError('aborted', 'The download was stopped.');
    throw new PackageError('network', "Couldn't reach BEAM's GitHub.");
  }
  if (!res.ok) throw new PackageError('network', `BEAM's GitHub answered ${res.status}.`);
  const out = new Uint8Array(entry.size);
  let n = 0;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (n + value.length > entry.size) {
          await reader.cancel().catch(() => {});
          throw new PackageError('size', `${entry.fileName} is larger than its pin (${entry.size} bytes).`);
        }
        out.set(value, n);
        n += value.length;
        if (onProgress) onProgress(n, entry.size);
      }
    } else {
      const all = new Uint8Array(await res.arrayBuffer());
      if (all.length > entry.size) throw new PackageError('size', `${entry.fileName} is larger than its pin (${entry.size} bytes).`);
      out.set(all);
      n = all.length;
      if (onProgress) onProgress(n, entry.size);
    }
  } catch (e) {
    if (e instanceof PackageError) throw e;
    if (signal && signal.aborted) throw new PackageError('aborted', 'The download was stopped.');
    throw new PackageError('network', 'The download stopped before it finished.');
  }
  return verifyPackage(entry, n === entry.size ? out : out.subarray(0, n));
}

// Only a key: nothing is ever fetched from it (the service worker answers it with a 404).
function cacheKey(entry) {
  return new URL(`__dapp-packages/${entry.sha256}`, globalThis.location.href).href;
}

async function openCache() {
  if (typeof caches === 'undefined' || !globalThis.location) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/** The kept copy, verified again, or null. A copy that fails is deleted. */
export async function cachedPackage(entry) {
  const c = await openCache();
  if (!c) return null;
  const r = await c.match(cacheKey(entry));
  if (!r) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  try {
    return await verifyPackage(entry, bytes);
  } catch {
    await c.delete(cacheKey(entry));
    return null;
  }
}

export async function isCached(entry) {
  const c = await openCache();
  if (!c) return false;
  return Boolean(await c.match(cacheKey(entry)));
}

/** Keeps verified bytes. Storage failures are not fatal: the next open downloads again. */
export async function keepPackage(entry, bytes) {
  const c = await openCache();
  if (!c) return false;
  try {
    await c.put(cacheKey(entry), new Response(bytes, { headers: { 'Content-Type': 'application/zip' } }));
    return true;
  } catch {
    return false;
  }
}

export async function forgetPackage(entry) {
  const c = await openCache();
  if (c) await c.delete(cacheKey(entry));
}

const GUID = /^[0-9a-f]{32}$/;

/**
 * Unzips a verified package and reads its manifest.json (beam-ui's rules,
 * as the desktop: the guid must be the catalogue's, the start page a
 * localapp/ path that exists in the package).
 * @returns {Promise<{files: Map<string, Uint8Array>, manifest: {name, guid, startPath, apiVersion, minApiVersion, version}}>}
 */
export async function openPackage(entry, bytes) {
  let files;
  try {
    files = await readZip(bytes);
  } catch (e) {
    throw new PackageError('zip', `The package could not be unpacked: ${e.message}`);
  }
  const raw = files.get('manifest.json');
  if (!raw || raw.length > 64 * 1024) throw new PackageError('manifest', 'The package has no readable manifest.json.');
  let m;
  try {
    m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new PackageError('manifest', 'The package manifest is not valid JSON.');
  }
  const guid = String(m.guid || '').toLowerCase().replace(/-/g, '');
  if (!GUID.test(guid) || guid !== entry.guid) throw new PackageError('manifest', 'The package is not the dApp it claims to be.');
  const url = String(m.url || '');
  if (!url.startsWith('localapp/')) throw new PackageError('manifest', 'The package start page is not inside the package.');
  const startPath = url.slice('localapp/'.length);
  if (!files.has(startPath)) throw new PackageError('manifest', 'The package start page is missing.');
  const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 30) : entry.name;
  return {
    files,
    manifest: {
      name,
      guid,
      startPath,
      version: typeof m.version === 'string' ? m.version : null,
      apiVersion: typeof m.api_version === 'string' ? m.api_version : null,
      minApiVersion: typeof m.min_api_version === 'string' ? m.min_api_version : null,
    },
  };
}

const TYPES = {
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain',
  map: 'application/json',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function mimeFor(path) {
  const i = path.lastIndexOf('.');
  return (i >= 0 && TYPES[path.slice(i + 1).toLowerCase()]) || 'application/octet-stream';
}
