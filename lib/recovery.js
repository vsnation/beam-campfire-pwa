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

export class RecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'network' | 'memory' | 'aborted' | 'size' | 'absent' (this host has no snapshot relay)
  }
}

/** Size in bytes from a HEAD request, or null. */
export async function recoverySize() {
  try {
    const r = await fetch(RECOVERY_PATH, { method: 'HEAD', cache: 'no-store' });
    const n = Number(r.headers.get('Content-Length'));
    // A static host without the relay answers 404, or an HTML page: no snapshot here.
    if (!r.ok || /text\/html/i.test(r.headers.get('Content-Type') || '')) return null;
    return n > 1e6 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Downloads the snapshot. onProgress(doneBytes, totalBytes).
 * @returns {Promise<Uint8Array>}
 */
export async function downloadRecovery(onProgress, signal) {
  let r;
  try {
    r = await fetch(RECOVERY_PATH, { cache: 'no-store', signal });
  } catch (e) {
    if (signal && signal.aborted) throw new RecoveryError('aborted', 'Download stopped.');
    throw new RecoveryError('network', "The download didn't start. Check your connection and try again.");
  }
  if (r.status === 404 || r.status === 410 || /text\/html/i.test(r.headers.get('Content-Type') || '')) {
    throw new RecoveryError('absent', "This copy of BEAM Campfire is hosted without BEAM's snapshot. Use a recovery file you download yourself (below), or scan instead.");
  }
  if (!r.ok || !r.body) throw new RecoveryError('network', `The snapshot server answered ${r.status}. Try again in a minute.`);
  const total = Number(r.headers.get('Content-Length'));
  if (!(total > 1e6 && total < 2e9)) throw new RecoveryError('size', 'The snapshot size is unknown, so it cannot be loaded safely.');
  let buf;
  try {
    buf = new Uint8Array(total);
  } catch {
    throw new RecoveryError('memory', `This device does not have ${Math.round(total / 1e6)} MB of free memory for the snapshot. Close other apps and try again.`);
  }
  const reader = r.body.getReader();
  let off = 0;
  let last = 0;
  try {
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
    if (signal && signal.aborted) throw new RecoveryError('aborted', 'Download stopped.');
    throw new RecoveryError('network', 'The download was interrupted. Check your connection and try again.');
  }
  if (off !== total) throw new RecoveryError('network', 'The download ended early. Try again.');
  if (onProgress) onProgress(off, total);
  return buf;
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
