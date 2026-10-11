/* Scan a QR code (a sheet over Send and the contact form)
 * Spec: ONE job: get an address off someone's screen or paper without typing it.
 *       Primary CTA: none while the camera looks (pointing it is the action); on a camera
 *       problem: "Paste instead".
 *       Taps from app open: 2 (Home -> Send -> Scan).
 * Exit-intent reasons and answers:
 *   - "Is it filming me / sending this somewhere?" -> says the picture stays on the phone; frames
 *     are read on the device and never kept.
 *   - "The camera does not open" -> says why (refused, no camera, in use, browser can't) and how
 *     to allow it, with Paste and "Use a photo" right there.
 *   - "It reads nothing" -> a QR code that is not a BEAM address is named as such; scanning goes on.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openSheet, notice, primary, secondary, textButton } from '../lib/ui.js';
import { parseScanned, startCameraScan, cameraProblem, cameraSupported, scanImageFile } from '../lib/qr_scan.js';

/**
 * Opens the scanner. Resolves {address, amount?} (lib/qr_scan.js parseScanned),
 * {paste: true} when the person chose to paste instead, or null.
 */
export function scanAddress({ title = 'Scan a QR code' } = {}) {
  return new Promise((resolve) => {
    let scanner = null;
    let done = false;
    const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true, 'aria-label': 'Camera picture', 'data-testid': 'scan-video' });
    const stage = h('div', { class: 'scan-stage', 'data-testid': 'scan-stage' }, video, h('div', { class: 'scan-frame', 'aria-hidden': 'true' }));
    const status = h('p', { class: 'small center', 'aria-live': 'polite', 'data-testid': 'scan-status', text: 'Starting the camera…' });
    const problemBox = h('div');
    const photo = h('input', { type: 'file', accept: 'image/*', class: 'file-input', 'data-testid': 'scan-photo-input', 'aria-label': 'Choose a photo of the QR code' });
    const photoBtn = h('label', { class: 'btn btn-secondary' }, icon('file'), 'Use a photo', photo);
    const pasteBtn = secondary(h('span', {}, 'Paste instead'), () => finish({ paste: true }), { 'data-testid': 'scan-paste' });
    const privacy = h('p', { class: 'small center', text: 'The picture stays on this phone: BEAM Campfire reads the code here and keeps nothing.' });

    const finish = (v) => {
      if (done) return;
      done = true;
      if (scanner) scanner.stop();
      sheet.close(v);
    };
    // A QR code that is not an address: say so, keep looking.
    const consider = (text) => {
      const r = parseScanned(text);
      if (r) {
        finish(r);
        return true;
      }
      status.textContent = "That QR code isn't a BEAM address. Point the camera at the receiver's address.";
      status.className = 'small center bad-text';
      return false;
    };

    const sheet = openSheet(
      () => [
        h('h2', { text: title }),
        stage,
        status,
        problemBox,
        privacy,
        h('div', { class: 'btn-row' }, pasteBtn, photoBtn),
        textButton('Cancel', () => finish(null), { 'data-testid': 'scan-cancel' }),
      ],
      { label: title },
    );
    sheet.then((v) => {
      if (scanner) scanner.stop();
      done = true;
      resolve(v || null);
    });

    function showProblem(e) {
      const p = cameraProblem(e);
      stage.classList.add('hidden');
      privacy.classList.add('hidden');
      pasteBtn.classList.add('hidden'); // the problem box has its own, as the primary way on
      status.textContent = '';
      put(problemBox, h('div', { 'data-testid': 'scan-problem', 'data-code': p.code }, notice('warn', p.text)), primary('Paste instead', () => finish({ paste: true }), { 'data-testid': 'scan-problem-paste' }));
    }

    photo.addEventListener('change', async () => {
      const f = photo.files && photo.files[0];
      photo.value = '';
      if (!f) return;
      status.className = 'small center';
      status.textContent = 'Reading the photo…';
      try {
        const text = await scanImageFile(f);
        if (!text) {
          status.textContent = 'No QR code found in that photo. Try a sharper one, closer to the code.';
          return;
        }
        consider(text);
      } catch {
        status.textContent = "That photo couldn't be read. Try another, or paste the address.";
      }
    });

    if (!cameraSupported()) return showProblem({ name: 'unsupported' });
    startCameraScan(video, { onText: consider })
      .then((s) => {
        if (done) return s.stop();
        scanner = s;
        status.textContent = 'Point the camera at the QR code of a BEAM address.';
      })
      .catch((e) => {
        if (!done) showProblem(e);
      });
  });
}
