// BEAM's recovery snapshot (≈330 MB, refreshed daily by BEAM). On a public
// node it is the only fast way to find a restored wallet's coins, and the only
// fast way to start a new wallet (otherwise the engine reads every block since
// 2019). BEAM's own web wallet does the same for both.
//
// The upstream file has no CORS headers, so the deployment serves it on this
// origin at /recovery/mainnet_recovery.bin (a streaming proxy or a mirror).
// It is read straight into ONE preallocated buffer of the announced size; the
// engine's file system then takes ownership of that buffer (canOwn), so the
// snapshot is held in memory once and is dropped as soon as the import ends.
// Nothing is written to disk or to the browser cache.

export const RECOVERY_PATH = 'recovery/mainnet_recovery.bin';
// Where BEAM publishes it (shown to the person; the app itself never contacts it).
export const RECOVERY_OFFICIAL = 'mobile-restore.beam.mw/mainnet/mainnet_recovery.bin';
export const RECOVERY_APPROX_MB = 330;
// Copies hosted without a relay (GitHub Pages, static mirrors) read it through
// BEAM Campfire's own server, which serves this one file to any origin,
// read-only. Whoever serves it, the engine checks it against the chain's proof
// of work. The CSP names this path only, never the rest of that host.
export const RECOVERY_FALLBACK_HOST = 'pwa.buybeam.my';
export const RECOVERY_FALLBACK = `https://${RECOVERY_FALLBACK_HOST}/recovery/mainnet_recovery.bin`;
export function recoveryConnectSources() {
  return [`https://${RECOVERY_FALLBACK_HOST}/recovery/`];
}
const crossOrigin = (url) => /^https:\/\//.test(url) ? { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' } : {};

export class RecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'network' | 'memory' | 'aborted' | 'size' | 'absent' (this host has no snapshot relay)
  }
}

/** Size in bytes from a HEAD request at `url`, or null. */
async function headSize(url, fetchImpl) {
  try {
    const r = await fetchImpl(url, { method: 'HEAD', cache: 'no-store', ...crossOrigin(url) });
    const n = Number(r.headers.get('Content-Length'));
    // A static host without the relay answers 404, or an HTML page: no snapshot there.
    if (!r.ok || /text\/html/i.test(r.headers.get('Content-Type') || '')) return null;
    return n > 1e6 ? n : null;
  } catch {
    return null;
  }
}

/** Where the snapshot comes from: {url, bytes, own} (this app's address first), or null. */
export async function recoverySource({ fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const own = await headSize(RECOVERY_PATH, fetchImpl);
  if (own) return { url: RECOVERY_PATH, bytes: own, own: true };
  const other = await headSize(RECOVERY_FALLBACK, fetchImpl);
  return other ? { url: RECOVERY_FALLBACK, bytes: other, own: false } : null;
}

/** Size in bytes, from whichever source answers, or null. */
export async function recoverySize() {
  const s = await recoverySource();
  return s ? s.bytes : null;
}

/**
 * Downloads the snapshot. onProgress(doneBytes, totalBytes).
 * An interrupted download (a phone that slept, a network that changed) carries
 * on from the bytes it has with a Range request, checked against the first
 * answer's ETag / Last-Modified, instead of starting the 330 MB again.
 * @returns {Promise<Uint8Array>}
 */
export async function downloadRecovery(onProgress, signal, { urls = [RECOVERY_PATH, RECOVERY_FALLBACK], ...opts } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await downloadFrom(urls[i], onProgress, signal, opts);
    } catch (e) {
      // No snapshot behind this address: the next source, if there is one.
      if (!(e instanceof RecoveryError) || e.code !== 'absent' || i === urls.length - 1) throw e;
    }
  }
}

async function downloadFrom(url, onProgress, signal, { fetchImpl = (...a) => globalThis.fetch(...a), retries = 6, pauseMs = 2000, whenVisible = visible } = {}) {
  const aborted = () => new RecoveryError('aborted', 'Download stopped.');
  const ask = async (from, validator) => {
    const headers = from > 0 ? { Range: `bytes=${from}-`, ...(validator ? { 'If-Range': validator } : {}) } : {};
    try {
      return await fetchImpl(url, { cache: 'no-store', signal, headers, ...crossOrigin(url) });
    } catch {
      if (signal && signal.aborted) throw aborted();
      return null;
    }
  };
  let r = await ask(0);
  if (!r) throw new RecoveryError('network', "The download didn't start. Check your connection and try again.");
  if (r.status === 404 || r.status === 410 || /text\/html/i.test(r.headers.get('Content-Type') || '')) {
    throw new RecoveryError('absent', "This copy of BEAM Campfire is hosted without BEAM's snapshot. Use a recovery file you download yourself (below), or scan instead.");
  }
  if (!r.ok || !r.body) throw new RecoveryError('network', `The snapshot server answered ${r.status}. Try again in a minute.`);
  const total = Number(r.headers.get('Content-Length'));
  if (!(total > 1e6 && total < 2e9)) throw new RecoveryError('size', 'The snapshot size is unknown, so it cannot be loaded safely.');
  const validator = r.headers.get('ETag') || r.headers.get('Last-Modified');
  let buf;
  try {
    buf = new Uint8Array(total);
  } catch {
    throw new RecoveryError('memory', `This device does not have ${Math.round(total / 1e6)} MB of free memory for the snapshot. Close other apps and try again.`);
  }
  let off = 0;
  let last = 0;
  let left = retries;
  for (;;) {
    if (r) {
      try {
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (off + value.length > total) throw new RecoveryError('size', 'The snapshot was larger than announced.');
          buf.set(value, off);
          off += value.length;
          const now = performance.now();
          if (onProgress && now - last > 200) {
            last = now;
            onProgress(off, total);
          }
        }
      } catch (e) {
        if (e instanceof RecoveryError) throw e;
        if (signal && signal.aborted) throw aborted();
      }
    }
    if (off === total) break;
    if (left-- <= 0) throw new RecoveryError('network', 'The download was interrupted. Check your connection and try again.');
    await whenVisible(signal);
    await new Promise((res) => setTimeout(res, pauseMs));
    if (signal && signal.aborted) throw aborted();
    r = await ask(off, validator);
    if (!r) continue;
    if (r.status === 206 && rangeStartsAt(r.headers.get('Content-Range'), off, total)) continue;
    if (r.status === 200 && Number(r.headers.get('Content-Length')) === total && r.body) {
      off = 0; // no ranges here, or a new snapshot under the same size: read it whole again
      continue;
    }
    if (r.status === 200) throw new RecoveryError('network', 'BEAM published a new snapshot during the download. Start again.');
    r = null;
  }
  if (onProgress) onProgress(off, total);
  return buf;
}

/** "bytes 100-329999999/330000000" from `from` to the end of `total`. */
function rangeStartsAt(contentRange, from, total) {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(contentRange || '').trim());
  return Boolean(m) && Number(m[1]) === from && Number(m[2]) === total - 1 && Number(m[3]) === total;
}

/** Resolves once the page is visible: a hidden page on a phone is paused, so retrying then is wasted. */
function visible(signal) {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') return Promise.resolve();
  return new Promise((res) => {
    const done = () => {
      document.removeEventListener('visibilitychange', on);
      res();
    };
    const on = () => document.visibilityState === 'visible' && done();
    document.addEventListener('visibilitychange', on);
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * BEAM's recovery file chosen from the device (downloaded by the person from
 * RECOVERY_OFFICIAL). Read into one buffer, like the download; the engine checks
 * it against the blockchain's proof of work, exactly as for the download.
 */
export async function readRecoveryFile(file) {
  const n = file && file.size;
  if (!(n > 1e6 && n < 2e9)) throw new RecoveryError('size', "That file isn't BEAM's recovery file (mainnet_recovery.bin, about 330 MB). Choose that file.");
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new RecoveryError('memory', `The file could not be read into memory (${Math.round(n / 1e6)} MB). Close other apps and try again; if it is in iCloud Drive, let it download first.`);
  }
}
