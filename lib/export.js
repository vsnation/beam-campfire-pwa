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
    if (running && app.dbPass) await wallet.start({ dbPass: app.dbPass, node: app.prefs.node, bodyRequests: scanEnabled(app) }).catch((e) => console.warn('[campfire] restart after export', e.message));
  }
  const out = await rekeyCopy(bytes, dbPass, password);
  return new File([out], exportFileName(), { type: 'application/octet-stream' });
}

/** Share sheet where the browser has one for files, else a download. Needs a fresh tap. */
export async function deliverExport(file) {
  if (typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
    let can = false;
    try {
      can = navigator.canShare({ files: [file] });
    } catch {
      can = false;
    }
    if (can) {
      try {
        await navigator.share({ files: [file], title: 'BEAM Campfire wallet.db' });
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
