/* Getting ready (after setup) / Rescan (Settings)
 * Spec: ONE job: get the wallet in step with the BEAM network.
 *       New wallet, or one imported from its wallet.db: no choice to make - it connects and opens
 *       (no download, ~5 s).
 *       Restore: primary CTA "Download <size> and start" (secondary: "Skip and scan instead").
 *       Rescan (any wallet): primary CTA "Download <size> and rescan"; the coins are forgotten and
 *       found again from the snapshot, history and addresses stay (engine patch 0107).
 *       Taps from app open: the last setup screen (once per device); Settings -> Rescan: 2.
 * Exit-intent reasons and answers:
 *   - "330 MB?!" -> only for restoring or finding coins, said before it starts, with why. "Wi-Fi is
 *     better" only when the browser says this is mobile data (it never says "use Wi-Fi" to someone
 *     who is on Wi-Fi: iPhone and desktop browsers do not tell, so they get the plain size).
 *   - "Is it stuck?" -> live MB / percent, then the reading step with its own percent.
 *   - "I left the app and it stopped" -> said up front: keep it open; Try again starts over.
 *   - "Something failed" -> what happened, and the way on: try again (or skip and scan on restore).
 *     A rescan that fails changes nothing, and leaving it starts the wallet again as it was.
 *   - "Will a rescan break my payment?" -> it waits: with a payment under way it says so and
 *     points to Activity instead of starting.
 *   - "The BEAM Campfire site is gone" -> the snapshot can come from BEAM directly: download
 *     mainnet_recovery.bin yourself (the exact address is shown) and choose the file; it is read on
 *     this device and checked by the engine exactly like the downloaded one.
 *   - "Who made this file, and must it come from this site?" (issue #79) -> one line, always: BEAM
 *     publishes it daily at its address (the file BEAM's own wallets use), this site only passes it
 *     on, the engine checks any copy against the proof of work, and (restore) scanning the chain is
 *     the way without it. "Use a recovery file I downloaded" is always there as a second button.
 *     No address of another copy can be typed in: that would widen the page's connect-src.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { primary, secondary, textButton, notice, progressBar, toast } from '../lib/ui.js';
import { downloadRecovery, recoverySource, readRecoveryFile, RECOVERY_APPROX_MB, RECOVERY_OFFICIAL, RECOVERY_FALLBACK_HOST } from '../lib/recovery.js';
import { markSetupDone, scanEnabled, setScan, isImported } from '../lib/session.js';
import { wallet } from '../lib/wallet.js';
import { onMobileData } from '../lib/network.js';

const MB = (n) => Math.round(n / 1e6);

/** How long a restore takes without the snapshot (scanning every block since 2019 on a public node). */
export const SCAN_TIME = '1–4 hours';

/**
 * Where the snapshot comes from, in one line (issue #79), as {lead, address, rest}: the address is
 * shown as a link between them. relay: who passes it on here ('This site', or BEAM Campfire's own
 * server when this address has none), or null when nobody does and the person brings the file.
 * rescan: no scanning instead (a rescan needs the snapshot).
 */
export function sourceWords({ relay = 'This site', rescan = false } = {}) {
  const passes = relay ? ` ${relay} only passes it on, and the wallet engine checks any copy against the blockchain's proof of work.` : " The wallet engine checks it against the blockchain's proof of work.";
  return {
    lead: 'BEAM publishes this snapshot daily at ',
    address: RECOVERY_OFFICIAL,
    rest: `, for its own wallets too.${passes}${rescan ? '' : ` Without it, the wallet can scan the chain instead (${SCAN_TIME}).`}`,
  };
}

export default function fastStart(app, params = {}) {
  if (!app.dbPass) {
    queueMicrotask(() => app.go(app.record ? 'unlock' : 'welcome'));
    return { el: h('div') };
  }
  const imported = isImported(app);
  const rescan = Boolean(params.rescan);
  const restoring = Boolean(app.record && app.record.restored);
  const newWallet = !rescan && !restoring;
  let sizeBytes = null;
  let sizeChecked = false;
  let fromFallback = false; // this address has no snapshot: it comes from BEAM Campfire's server
  let releaseAwake = null;
  let abort = null;
  let destroyed = false;
  let phase = 'choose';
  let lastError = null;

  const body = h('div', { class: 'content' });
  const actions = h('div', { class: 'actions' });
  const title = rescan ? 'Rescan' : 'Getting ready';
  const el = h(
    'main',
    { class: 'screen' },
    h('header', { class: 'topbar' }, rescan ? h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => phase === 'choose' && leave() }, icon('back')) : null, h('h1', { text: title })),
    body,
    actions,
  );
  // BEAM's own recovery file, downloaded by hand: the way to restore without this app's web address.
  const fileInput = h('input', { type: 'file', id: 'recovery-file-input', class: 'file-input', tabindex: '-1', 'aria-hidden': 'true', 'data-testid': 'recovery-file' });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f && phase === 'choose') useFile(f);
  });
  el.appendChild(fileInput);

  function view(content, buttons) {
    if (destroyed) return;
    put(body, ...content);
    put(actions, ...buttons);
  }

  function choose(errorText) {
    phase = 'choose';
    lastError = errorText || null;
    const size = sizeBytes ? `${MB(sizeBytes)} MB` : `about ${RECOVERY_APPROX_MB} MB`;
    // No snapshot through this app's web address or BEAM Campfire's server: the person brings the file.
    const noRelay = sizeChecked && !sizeBytes;
    // How to get the file, when it is the way on (an error, or no relay); the button is always there (#79).
    const howToFile = Boolean(errorText) || noRelay;
    const fileButton = (cls) => h('label', { class: `btn ${cls}`, for: 'recovery-file-input', role: 'button', tabindex: '0', 'data-testid': 'recovery-file-choose' }, icon('file'), h('span', { text: 'Use a recovery file I downloaded' }));
    const words = sourceWords({ relay: noRelay ? null : fromFallback ? RECOVERY_FALLBACK_HOST : 'This site', rescan });
    const lead = rescan
      ? `Rescan rebuilds your balance from the BEAM blockchain. Use it if your balance looks wrong or coins are missing${imported ? '' : ', for example coins sent to these 12 words in another app'}. Your payment history and addresses stay as they are.`
      : noRelay
        ? "To find your coins, BEAM Campfire reads a snapshot of the BEAM blockchain once. This site has no copy of it, so download BEAM's recovery file and choose it below."
        : fromFallback
          ? `To find your coins, BEAM Campfire downloads a snapshot of the BEAM blockchain once, from ${RECOVERY_FALLBACK_HOST} (this site has no copy of it).`
          : 'To find your coins, BEAM Campfire downloads a snapshot of the BEAM blockchain once.';
    view(
      [
        h('div', { class: 'status-icon wait' }, icon('download')),
        h('p', { class: 'lead', text: lead }),
        noRelay
          ? // The person downloads it in the browser, outside this app.
            notice('info', h('strong', { text: `The file is ${size}. ` }), 'Download it once, then come back and choose it here.')
          : onMobileData()
            ? notice('warn', h('strong', { text: `This is mobile data: the download is ${size}. ` }), 'Wi-Fi is better. Keep BEAM Campfire open until it finishes; leaving the app pauses it.')
            : notice('info', h('strong', { text: `${rescan ? 'A download of' : 'A one-time download of'} ${size}. ` }), 'It takes a few minutes. Keep BEAM Campfire open until it finishes: the screen stays on meanwhile, and if it is interrupted it carries on where it stopped.'),
        h(
          'p',
          { class: 'small', 'data-testid': 'recovery-source' },
          words.lead,
          h('a', { class: 'source-link', href: `https://${RECOVERY_OFFICIAL}`, target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'recovery-file-link', text: words.address }),
          words.rest,
          fromFallback && !noRelay ? ` ${RECOVERY_FALLBACK_HOST} sees your IP address while it downloads.` : '',
        ),
        errorText ? notice('error', errorText) : null,
      ],
      [
        // No snapshot behind this address (a plain static host, or the site is down): the file the
        // person downloads from BEAM becomes the main way; the download stays as a second try.
        noRelay ? fileButton('btn-primary') : primary(`Download ${size} and ${rescan ? 'rescan' : 'start'}`, startDownload, { 'data-testid': 'fast-download' }),
        // Always offered (issue #79): the file BEAM publishes, brought by the person, instead of the download.
        noRelay ? secondary('Try the download anyway', startDownload, { 'data-testid': 'fast-download' }) : fileButton('btn-secondary'),
        howToFile
          ? h('p', { class: 'small', 'data-testid': 'recovery-file-help', text: `To use the file: tap the address above (about ${RECOVERY_APPROX_MB} MB; on iPhone, Safari saves it to Files → Downloads), then come back and choose it with "Use a recovery file I downloaded". It is read on this device only.` })
          : null,
        restoring && !rescan ? textButton(`Skip and scan instead (${SCAN_TIME})`, () => runWallet(null, true), { 'data-testid': 'fast-skip' }) : null,
        rescan ? textButton('Not now', leave, { 'data-testid': 'fast-cancel' }) : null,
      ],
    );
  }

  // A rescan waits for a payment under way: forgetting coins meanwhile could leave it short.
  function paymentFirst() {
    phase = 'choose';
    view(
      [
        h('div', { class: 'status-icon wait' }, icon('clock')),
        h('p', { class: 'lead', text: 'A payment is under way.' }),
        h('div', { 'data-testid': 'rescan-wait' }, notice('info', 'Rescan once it has finished, so nothing interrupts it. Activity shows it as Completed when it is done.')),
      ],
      [primary('Open Activity', () => app.go('activity'), { 'data-testid': 'rescan-activity' }), textButton('Not now', leave, { 'data-testid': 'fast-cancel' })],
    );
  }

  // Leaving a rescan: a failed one stopped the wallet (unchanged), so it runs again as it was.
  async function leave() {
    if (rescan && !wallet.session) {
      try {
        await wallet.start({ dbPass: app.dbPass, node: app.prefs.node, bodyRequests: scanEnabled(app) });
      } catch {
        /* Home says the wallet is not connected and offers the way on */
      }
    }
    app.go('settings');
  }

  // A locked phone pauses the page: keep the screen on while the snapshot is
  // downloaded and read (Screen Wake Lock, where the browser has it).
  function keepAwake() {
    if (releaseAwake || !('wakeLock' in navigator)) return;
    let lock = null;
    let on = true;
    const get = async () => {
      if (!on || document.visibilityState !== 'visible') return;
      try {
        lock = await navigator.wakeLock.request('screen');
      } catch {
        lock = null;
      }
    };
    const onVisible = () => document.visibilityState === 'visible' && get();
    document.addEventListener('visibilitychange', onVisible);
    get();
    releaseAwake = () => {
      on = false;
      releaseAwake = null;
      document.removeEventListener('visibilitychange', onVisible);
      if (lock) lock.release().catch(() => {});
    };
  }

  async function useFile(f) {
    phase = 'reading';
    keepAwake();
    view([h('div', { class: 'status-icon wait' }, icon('file')), h('p', { class: 'lead', text: 'Reading the recovery file…' }), progressBar(null), notice('info', 'Keep BEAM Campfire open until this finishes.')], []);
    let buf;
    try {
      buf = await readRecoveryFile(f);
    } catch (e) {
      if (releaseAwake) releaseAwake();
      return choose(e.message);
    }
    await runWallet(buf, true);
  }

  async function startDownload() {
    phase = 'download';
    keepAwake();
    const ctl = new AbortController();
    abort = ctl;
    const bar = progressBar(0);
    const line = h('p', { class: 'small', 'aria-live': 'polite', text: 'Starting…' });
    view(
      [h('div', { class: 'status-icon wait' }, icon('download')), h('p', { class: 'lead', text: 'Downloading the BEAM snapshot…' }), bar, line, notice('info', 'Keep BEAM Campfire open until this finishes.')],
      [secondary('Stop', () => ctl.abort(), { 'data-testid': 'fast-stop' })],
    );
    let buf;
    try {
      buf = await downloadRecovery((done, total) => {
        bar.firstChild.style.width = `${(done / total) * 100}%`;
        line.textContent = `${MB(done)} of ${MB(total)} MB (${Math.floor((done / total) * 100)}%)`;
      }, ctl.signal);
    } catch (e) {
      abort = null;
      if (releaseAwake) releaseAwake();
      if (e.code === 'aborted') return choose();
      return choose(e.message);
    }
    abort = null;
    await runWallet(buf, true);
  }

  /** buf: the snapshot or null. scan: read block bodies (restore / after a snapshot). */
  async function runWallet(buf, scan) {
    phase = 'run';
    const bar = progressBar(buf ? 0 : null);
    const line = h('p', { class: 'small', 'aria-live': 'polite', text: buf ? 'Reading the snapshot…' : 'Connecting to the BEAM network…' });
    view([h('div', { class: 'status-icon wait' }, icon('refresh')), h('p', { class: 'lead', text: buf ? 'Reading the snapshot' : 'Opening your wallet' }), bar, line, buf ? notice('info', 'Keep BEAM Campfire open until this finishes.') : null], []);
    const off = wallet.onChange((s) => {
      if (s.importProgress && s.importProgress.total) {
        const f = s.importProgress.done / s.importProgress.total;
        bar.firstChild.style.width = `${f * 100}%`;
        line.textContent = `Reading the snapshot… ${Math.floor(f * 100)}%`;
      }
    });
    try {
      if (wallet.session) await wallet.stop();
      await wallet.start({ dbPass: app.dbPass, node: app.prefs.node, recovery: buf, bodyRequests: scan, rescan: rescan && Boolean(buf) });
      buf = null;
      off();
      if (scan !== scanEnabled(app)) await setScan(app, scan);
      if (!app.record.setupDone) await markSetupDone(app);
      if (releaseAwake) releaseAwake();
      if (rescan) toast('Rescan done: your balance is rebuilt from the blockchain.');
      app.go('home');
    } catch (e) {
      off();
      buf = null;
      if (releaseAwake) releaseAwake();
      await wallet.stop().catch(() => {});
      if (newWallet) {
        view(
          [notice('error', `The wallet did not open: ${e.message}`)],
          [
            primary('Try again', () => runWallet(null, false)),
            // An imported file that will not run: the way out is removing it and importing again.
            imported ? textButton('Remove it from this device', () => app.go('deleteWallet'), { 'data-testid': 'fast-remove' }) : null,
          ],
        );
      } else if (rescan && e.code === 'import') {
        // The engine rolled the rescan back: say so, and that the balance is as it was.
        choose('The snapshot could not be read, so nothing changed: your balance is as it was. Try again; if it keeps failing, use a recovery file you downloaded.');
      } else choose(e.message || 'The wallet did not start.');
    }
  }

  if (newWallet) {
    // A new seed has no history: start at the network's tip, no download, no scan.
    runWallet(null, false);
  } else if (rescan && wallet.paymentUnderWay()) {
    paymentFirst();
  } else {
    recoverySource().then((src) => {
      sizeBytes = src ? src.bytes : null;
      fromFallback = Boolean(src && !src.own);
      sizeChecked = true;
      if (phase === 'choose' && !lastError) choose();
    });
    choose();
  }

  return {
    el,
    destroy() {
      destroyed = true;
      if (abort) abort.abort();
      if (releaseAwake) releaseAwake();
    },
  };
}
