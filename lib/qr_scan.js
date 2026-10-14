// Scanning a BEAM address from a QR code: the phone's camera through the
// browser (getUserMedia), frames read on the device by jsQR in a worker
// (lib/qr_worker.js). Nothing leaves the device; the frames are never stored.
// The desktop app scans in Send (beam_send_screen.dart _scan) and its address
// book; what it reads goes through the same rule as a paste (_applyText): the
// first line, and a "beam:" payment link fills the address and the amount.
//
// iPhone: Safari and Home Screen apps can use the camera (iOS 14.3 and later)
// once the person allows it; the page must be allowed it by its own
// Permissions-Policy (camera=(self), tools/headers.mjs). The video must play
// inline and muted or iOS will not start it.

import { parseAmount } from './amount.js';
import { t } from './i18n.js';

/**
 * What a scanned (or pasted) text means for Send: {address, amount?} or null when
 * it holds nothing that could be an address. amount is groth (BigInt), only from
 * a "beam:" link with a valid amount.
 */
export function parseScanned(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  const nl = s.search(/[\r\n]/);
  if (nl >= 0) s = s.slice(0, nl).trim();
  let amount = null;
  const m = /^beam:(?:\/\/)?([^?#]*)(?:\?([^#]*))?/i.exec(s);
  if (m) {
    s = decodeSafe(m[1]).trim();
    const q = new URLSearchParams(m[2] || '');
    const a = q.get('amount') ?? q.get('tx_amount');
    if (a != null) {
      try {
        const g = parseAmount(a);
        if (g > 0n) amount = g;
      } catch {
        amount = null;
      }
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    return null; // a link of another kind (https:, bitcoin:, ...): not a BEAM address
  }
  s = s.replace(/\s+/g, '');
  if (!s || s.length > 1024 || !/^[0-9A-Za-z._~@-]+$/.test(s)) return null;
  return amount != null ? { address: s, amount } : { address: s };
}

function decodeSafe(x) {
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
}

/** Whether this browser can open a camera at all (a secure page with mediaDevices). */
export function cameraSupported(nav = globalThis.navigator) {
  return Boolean(nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function' && globalThis.isSecureContext !== false);
}

/** Why the camera did not start, in words, from getUserMedia's error. */
export function cameraProblem(e) {
  const n = (e && e.name) || '';
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError')
    return { code: 'denied', text: t('BEAM Campfire may not use the camera. To scan, allow the camera for this app in your phone’s settings (iPhone: Settings → Apps → Safari → Camera), then try again. Or paste the address.') };
  if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return { code: 'none', text: t('This device has no camera BEAM Campfire can use. Paste the address instead.') };
  if (n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError') return { code: 'busy', text: t('The camera is in use by another app, or could not start. Close that app and try again, or paste the address.') };
  if (n === 'unsupported') return { code: 'unsupported', text: t('This browser can’t use the camera here. Paste the address instead.') };
  return { code: 'other', text: t('The camera could not start. Try again, or paste the address.') };
}

const MAX_SIDE = 720; // frames are scaled down to this before decoding: enough for an address QR, quick on a phone

/** A worker that answers {id, text} for {id, data, width, height}. */
export function qrDecoder(url = 'lib/qr_worker.js') {
  const w = new Worker(url);
  let next = 1;
  const waiting = new Map();
  w.onmessage = (e) => {
    const r = e.data || {};
    const f = waiting.get(r.id);
    if (f) {
      waiting.delete(r.id);
      f(r.text || null);
    }
  };
  w.onerror = () => {
    for (const f of waiting.values()) f(null);
    waiting.clear();
  };
  return {
    decode(img, { thorough = false } = {}) {
      const id = next++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        w.postMessage({ id, data: img.data.buffer, width: img.width, height: img.height, thorough }, [img.data.buffer]);
      });
    },
    stop() {
      w.terminate();
      for (const f of waiting.values()) f(null);
      waiting.clear();
    },
  };
}

/** The pixels of a video frame or an image, scaled so the longer side is at most max. */
export function framePixels(source, w, h, canvas, max = MAX_SIDE) {
  if (!w || !h) return null;
  const k = Math.min(1, max / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== ch) canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, cw, ch);
  return ctx.getImageData(0, 0, cw, ch);
}

/**
 * Starts the back camera in `video` and reads frames until onText(text) returns
 * true (the text was used) or stop() is called. Rejects with the getUserMedia
 * error when the camera does not start.
 */
export async function startCameraScan(video, { onText, nav = globalThis.navigator, decoder = null } = {}) {
  if (!cameraSupported(nav)) {
    const e = new Error('no camera API'); // i18n-ignore: cameraProblem() says it in words, from its name
    e.name = 'unsupported';
    throw e;
  }
  const stream = await nav.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  let stopped = false;
  const dec = decoder || qrDecoder();
  const canvas = document.createElement('canvas');
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.muted = true;
  video.srcObject = stream;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    dec.stop();
  };
  try {
    await video.play();
  } catch (e) {
    stop();
    throw e;
  }
  let n = 0;
  (async function loop() {
    while (!stopped) {
      if (video.readyState >= 2 && video.videoWidth) {
        const img = framePixels(video, video.videoWidth, video.videoHeight, canvas);
        // Every third frame also tries the inverted image (light code on dark).
        const text = img ? await dec.decode(img, { thorough: ++n % 3 === 0 }) : null;
        if (stopped) return;
        if (text && onText(text)) return stop();
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  })();
  return { stop, stream };
}

/** Reads a QR code from a photo the person chose (when there is no live camera). */
export async function scanImageFile(file, { decoder = null } = {}) {
  const bmp = await createImageBitmap(file);
  const dec = decoder || qrDecoder();
  try {
    const canvas = document.createElement('canvas');
    const img = framePixels(bmp, bmp.width, bmp.height, canvas, 1600);
    return img ? await dec.decode(img, { thorough: true }) : null;
  } finally {
    if (bmp.close) bmp.close();
    if (!decoder) dec.stop();
  }
}
