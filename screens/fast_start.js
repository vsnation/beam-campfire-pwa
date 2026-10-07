/* Getting ready (after setup) / Find coins from other wallets (Settings)
 * Spec: ONE job: get the wallet in step with the BEAM network.
 *       New wallet, or one imported from its wallet.db: no choice to make - it connects and opens
 *       (no download, ~5 s). An imported wallet is never offered the snapshot scan.
 *       Restore / "Find coins": primary CTA "Download <size> and start"
 *       (secondary on restore: "Skip and scan instead").
 *       Taps from app open: the last setup screen (once per device); Settings -> 2.
 * Exit-intent reasons and answers:
 *   - "330 MB?!" -> only for restoring or finding coins, said before it starts, with why and "use Wi-Fi".
 *   - "Is it stuck?" -> live MB / percent, then the reading step with its own percent.
 *   - "I left the app and it stopped" -> said up front: keep it open; Try again starts over.
 *   - "Something failed" -> what happened, and the way on: try again (or skip and scan on restore).
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { primary, secondary, textButton, notice, progressBar } from '../lib/ui.js';
import { downloadRecovery, recoverySize, RECOVERY_APPROX_MB } from '../lib/recovery.js';
import { markSetupDone, scanEnabled, setScan, isImported } from '../lib/session.js';
import { wallet } from '../lib/wallet.js';

const MB = (n) => Math.round(n / 1e6);

export default function fastStart(app, params = {}) {
  if (!app.dbPass) {
    queueMicrotask(() => app.go(app.record ? 'unlock' : 'welcome'));
    return { el: h('div') };
  }
  const imported = isImported(app);
  if (params.rescan && imported) {
    queueMicrotask(() => app.go('settings'));
    return { el: h('div') };
  }
  const rescan = Boolean(params.rescan);
  const restoring = Boolean(app.record && app.record.restored);
  const newWallet = !rescan && !restoring;
  let sizeBytes = null;
  let abort = null;
  let destroyed = false;
  let phase = 'choose';
  let lastError = null;

  const body = h('div', { class: 'content' });
  const actions = h('div', { class: 'actions' });
  const title = rescan ? 'Find coins from other wallets' : 'Getting ready';
  const el = h(
    'main',
    { class: 'screen' },
    h('header', { class: 'topbar' }, rescan ? h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => phase === 'choose' && app.go('settings') }, icon('back')) : null, h('h1', { text: title })),
    body,
    actions,
  );

  function view(content, buttons) {
    if (destroyed) return;
    put(body, ...content);
    put(actions, ...buttons);
  }

  function choose(errorText) {
    phase = 'choose';
    lastError = errorText || null;
    const size = sizeBytes ? `${MB(sizeBytes)} MB` : `about ${RECOVERY_APPROX_MB} MB`;
    const lead = rescan
      ? 'This wallet sees the payments it makes and receives itself. If its 12 words were also used in another wallet app, BEAM Campfire can find those coins by reading a snapshot of the BEAM blockchain once.'
      : 'To find your coins, BEAM Campfire downloads a snapshot of the BEAM blockchain once.';
    view(
      [
        h('div', { class: 'status-icon wait' }, icon('download')),
        h('p', { class: 'lead', text: lead }),
        notice('warn', h('strong', { text: `${size} - use Wi-Fi. ` }), 'It takes a few minutes. Keep BEAM Campfire open until it finishes; leaving the app stops the download.'),
        h('p', { class: 'small', text: "The snapshot is BEAM's own daily file, checked by the wallet engine against the blockchain's proof of work. It is not stored on your phone after it's read." }),
        errorText ? notice('error', errorText) : null,
      ],
      [
        primary(`Download ${size} and start`, startDownload, { 'data-testid': 'fast-download' }),
        restoring ? textButton('Skip and scan instead (an hour or more)', () => runWallet(null, true), { 'data-testid': 'fast-skip' }) : null,
        rescan ? textButton('Not now', () => app.go('settings'), { 'data-testid': 'fast-cancel' }) : null,
      ],
    );
  }

  async function startDownload() {
    phase = 'download';
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
      await wallet.start({ dbPass: app.dbPass, node: app.prefs.node, recovery: buf, bodyRequests: scan });
      buf = null;
      off();
      if (scan !== scanEnabled(app)) await setScan(app, scan);
      if (!app.record.setupDone) await markSetupDone(app);
      app.go('home');
    } catch (e) {
      off();
      buf = null;
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
      } else choose(e.message || 'The wallet did not start.');
    }
  }

  if (newWallet) {
    // A new seed has no history: start at the network's tip, no download, no scan.
    runWallet(null, false);
  } else {
    recoverySize().then((n) => {
      sizeBytes = n;
      if (phase === 'choose' && !lastError && n) choose();
    });
    choose();
  }

  return {
    el,
    destroy() {
      destroyed = true;
      if (abort) abort.abort();
    },
  };
}
