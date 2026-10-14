// "Export wallet.db" (Settings -> Backup): the wallet as a file that BEAM
// Campfire desktop, BEAM's desktop wallet, LightWallet or the BEAM CLI can
// open, with the person's BEAM Campfire password. The way out that needs no
// web address and no recovery phrase.
//
// The wallet is stopped for a moment so the copy is consistent, then started
// again; the copy is re-keyed in memory (engine.rekeyCopy); the live wallet.db
// and its database password are untouched. The file is handed to the share
// sheet (iOS: Save to Files, AirDrop) or downloaded. Nothing is uploaded.

import { wallet } from './wallet.js';
import { readWalletDb, rekeyCopy } from './engine.js';
import { scanEnabled } from './session.js';
import { walletNode } from './nodes.js';

export function exportFileName(now = new Date()) {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `beam-campfire-wallet-${d}.db`;
}

/** @returns {Promise<File>} wallet.db re-keyed to `password`. The caller has verified the password. */
export async function prepareExport(app, password) {
  const dbPass = app.dbPass;
  if (!dbPass) throw new Error('Unlock the wallet first.');
  const running = Boolean(wallet.session);
  if (running) await wallet.stop();
  let bytes;
  try {
    bytes = await readWalletDb();
  } finally {
    if (running && app.dbPass) await wallet.start({ dbPass: app.dbPass, node: walletNode(app.prefs), bodyRequests: scanEnabled(app) }).catch((e) => console.warn('[campfire] restart after export', e.message));
  }
  const out = await rekeyCopy(bytes, dbPass, password);
  return new File([out], exportFileName(), { type: 'application/octet-stream' });
}

/** A copy kept in the cloud can be attacked offline for as long as anyone likes: its password is longer. */
export const CLOUD_MIN_PASSWORD = 12;

/**
 * How a saved file reaches the person's cloud here. 'ios': the share sheet's Save to Files, then
 * iCloud Drive. 'mac': Safari's share sheet on a Mac has no Save to Files, so a download, then
 * iCloud Drive in Finder. 'other': the share sheet (Google Drive, Dropbox, ...) or a download.
 * iPadOS presents itself as a Mac with touch.
 */
export function cloudPlatform(nav = globalThis.navigator) {
  const ua = (nav && nav.userAgent) || '';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)) return 'ios';
  if (/Macintosh/.test(ua)) return 'mac';
  return 'other';
}

/** Share sheet where the browser has one for files, else a download. Needs a fresh tap. */
export async function deliverExport(file, { download = false, title = 'BEAM Campfire wallet.db' } = {}) {
  if (!download && typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
    let can = false;
    try {
      can = navigator.canShare({ files: [file] });
    } catch {
      can = false;
    }
    if (can) {
      try {
        await navigator.share({ files: [file], title });
        return 'shared';
      } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
        // Not allowed here: fall back to a download.
      }
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}
