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
import { compareVersions, ReleaseError, RELEASE_APP_ID, verifyReleaseSignature, verifyManifest } from './release.js';

// Public copies of the published release (github.com/vsnation/beam-campfire-pwa),
// each serving every file with Access-Control-Allow-Origin: *. Fresher first:
// raw.githubusercontent.com caches 5 min, GitHub Pages 10 min, jsDelivr up to 12 h.
// tools/build.mjs writes this list into release.json (signed), and the loader
// prefers the installed release's list, so a release can change it without a
// new loader.
export const BUILTIN_SOURCES = Object.freeze([
  'https://raw.githubusercontent.com/vsnation/beam-campfire-pwa/main/',
  'https://vsnation.github.io/beam-campfire-pwa/',
  'https://cdn.jsdelivr.net/gh/vsnation/beam-campfire-pwa@main/',
]);

export const MAX_SOURCE_LENGTH = 2000;
export const MAX_RELEASE_SOURCES = 10;
export const MAX_ADDED_SOURCES = 3;

/**
 * An address the person typed or pasted, as the folder a copy is served from:
 * https only, no user name or password, no query or fragment, a trailing slash.
 * An address typed without a scheme ("example.org/campfire") gets https, and
 * a link to the copy's index.html or release.json means its folder.
 * Returns {ok: true, url} or {ok: false, reason}.
 */
export function normalizeSource(input) {
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
export function releaseSources(release) {
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
export function updateSources({ own, builtins = BUILTIN_SOURCES, added = [] }) {
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
export function loaderCompatible(release, loader) {
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
export async function readRelease(get, publicJwk) {
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
export async function findUpdate({ sources, installed, pending = null, loader, fetchRelease, stage, onSource = null }) {
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
