/* dApps
 * Spec: ONE job: open one of BEAM's own dApps without giving it the wallet.
 *       Primary CTA: the dApp's row, "Open" (the first time: "Download and open").
 *       Taps from app open: 2 after unlock (Home > dApps > Open); 3 the first time.
 * Exit-intent reasons and answers:
 *   - "What will it download, from where, and who sees it?" -> the size and the host are on
 *     the button's sheet before anything is fetched, and the extra hosts a dApp contacts are
 *     off unless turned on, with the reason (they see your IP address).
 *   - "Can it take my money?" -> it can only ask. Every payment or contract call shows this
 *     dApp's name, what leaves and what arrives, and needs Face ID or the password.
 *   - "It broke / it's stuck" -> every failure says what happened and offers Try again;
 *     Close is always on screen.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, notice, openSheet, progressBar, toast } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { loadEngine } from '../lib/engine.js';
import { isControlled } from '../lib/loader.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { CATALOGUE, iconPath, sizeText, hostOf } from '../lib/dapps/catalogue.js';
import { downloadPackage, cachedPackage, keepPackage, isCached, forgetPackage, openPackage, PackageError } from '../lib/dapps/package.js';
import { DappRunner, runnerStats } from '../lib/dapps/runner.js';
import { openApp } from '../lib/contracts.js';

export { runnerStats };

const remoteHosts = (e) => e.remoteOrigins.map(hostOf).join(' and ');

function dappPrefs(app) {
  return (app.prefs && app.prefs.dapps) || {};
}

async function setDappPref(app, guid, patch) {
  const all = { ...dappPrefs(app) };
  all[guid] = { ...(all[guid] || {}), ...patch };
  await app.setPrefs({ dapps: all });
}

export default function dapps(app, params = {}) {
  let runner = null;
  let downloadCtl = null;
  let destroyed = false;
  const listBox = h('div', { class: 'card list dapp-list', 'data-testid': 'dapp-list' });
  const topNote = h('div');
  const layer = h('div', { class: 'dapp-layer hidden', 'data-testid': 'dapp-layer' });
  const cached = new Map();

  const canRun = isControlled();

  function renderList() {
    put(
      listBox,
      ...CATALOGUE.map((e) =>
        h(
          'button',
          { class: 'row dapp-row', onclick: () => tapOpen(e), disabled: !canRun, 'data-testid': `dapp-${e.guid}`, 'data-name': e.name },
          h('span', { class: 'dapp-icon' }, h('img', { src: iconPath(e), alt: '' })),
          h(
            'span',
            { class: 'main' },
            h('div', { class: 't', text: e.name }),
            h('div', { class: 's', text: e.blurb }),
            h('div', { class: 's meta', 'data-testid': 'dapp-size', text: cached.get(e.guid) ? 'Downloaded' : `${sizeText(e.size)} download` }),
          ),
          h('span', { class: 'pill', text: 'Open' }),
        ),
      ),
    );
  }

  function renderNote(s) {
    const parts = [];
    if (!canRun) parts.push(notice('warn', 'dApps run only in the installed BEAM Campfire (the copy checked against its release signature). Open BEAM Campfire from its home screen icon or its web address and try again.'));
    else if (s.sync.state !== 'synced') parts.push(notice('info', `The wallet is ${s.sync.title.toLowerCase().replace(/[.…]+$/, '')}. dApps can open now; what they read from the network waits until it has caught up.`));
    put(topNote, ...parts);
  }

  async function refreshCached() {
    for (const e of CATALOGUE) cached.set(e.guid, await isCached(e).catch(() => false));
    if (!destroyed) renderList();
  }

  // ---------------------------------------------------------------- opening
  function tapOpen(e) {
    app.touch();
    const pref = dappPrefs(app)[e.guid];
    if (cached.get(e.guid) && (e.remoteOrigins.length === 0 || (pref && typeof pref.remote === 'boolean'))) return start(e);
    prepareSheet(e);
  }

  function prepareSheet(e) {
    const pref = dappPrefs(app)[e.guid] || {};
    const allow = h('input', { type: 'checkbox', checked: pref.remote === true, 'data-testid': 'dapp-remote' });
    const needsDownload = !cached.get(e.guid);
    openSheet(
      (close) => [
        h('div', { class: 'dapp-sheet-head' }, h('span', { class: 'dapp-icon big' }, h('img', { src: iconPath(e), alt: '' })), h('h2', { text: e.name })),
        needsDownload
          ? h('p', { class: 'lead', 'data-testid': 'dapp-size-note', text: `Downloads ${sizeText(e.size)} from BEAM's GitHub (raw.githubusercontent.com), once. GitHub sees your IP address. BEAM Campfire checks the file against the fingerprint built into this app before anything runs.` })
          : null,
        h('p', { class: 'small', text: 'It runs walled off from your wallet: it can ask, and nothing leaves without your OK.' }),
        e.remoteOrigins.length
          ? h('label', { class: 'check-row' }, allow, h('span', {}, h('strong', { text: 'Also allow price lookups. ' }), `It fetches prices from ${remoteHosts(e)}, which see your IP address. Off: the dApp still works, without prices.`))
          : null,
        h('button', {
          class: 'btn btn-primary',
          'data-testid': 'dapp-go',
          onclick: async () => {
            if (e.remoteOrigins.length) await setDappPref(app, e.guid, { remote: allow.checked });
            close(true);
            start(e);
          },
        }, needsDownload ? 'Download and open' : 'Open'),
        h('button', { class: 'btn btn-text', onclick: () => close(false) }, 'Not now'),
      ],
      { label: `Open ${e.name}` },
    );
  }

  /** Download (first time) or load the kept copy, verify, then run. */
  async function start(e) {
    const status = { text: '', fraction: null, error: null };
    let sheet = null;
    const show = () => {
      if (!sheet || sheet.closed) return;
      sheet.rerender();
    };
    sheet = openSheet(
      (close) => [
        h('div', { class: 'dapp-sheet-head' }, h('span', { class: 'dapp-icon big' }, h('img', { src: iconPath(e), alt: '' })), h('h2', { text: e.name })),
        status.error
          ? notice('error', status.error)
          : h('div', { class: 'dapp-progress', 'data-testid': 'dapp-progress' }, h('p', { class: 'lead', text: status.text }), progressBar(status.fraction)),
        status.error ? h('button', { class: 'btn btn-primary', 'data-testid': 'dapp-retry', onclick: () => { close(); start(e); } }, 'Try again') : null,
        h('button', { class: 'btn btn-text', 'data-testid': 'dapp-cancel', onclick: () => { if (downloadCtl) downloadCtl.abort(); close(); } }, status.error ? 'Back to dApps' : 'Cancel'),
      ],
      { dismissable: false, label: `Opening ${e.name}` },
    );
    try {
      let bytes = await cachedPackage(e);
      if (!bytes) {
        status.text = `Downloading ${sizeText(e.size)} from BEAM's GitHub…`;
        status.fraction = 0;
        show();
        downloadCtl = new AbortController();
        bytes = await downloadPackage(e, {
          signal: downloadCtl.signal,
          onProgress: (done, total) => {
            status.text = `Downloading: ${sizeText(done)} of ${sizeText(total)}`;
            status.fraction = done / total;
            show();
          },
        });
        downloadCtl = null;
        await keepPackage(e, bytes);
        cached.set(e.guid, true);
        renderList();
      }
      status.text = 'Checked against its fingerprint. Opening…';
      status.fraction = null;
      show();
      const { files, manifest } = await openPackage(e, bytes);
      if (destroyed || sheet.closed) return;
      status.text = 'Connecting it to your wallet…';
      show();
      const appApi = await connect(manifest, e);
      if (destroyed || sheet.closed) {
        appApi.close();
        return;
      }
      sheet.close();
      run(e, files, manifest, appApi);
    } catch (err) {
      downloadCtl = null;
      if (sheet.closed || destroyed) return;
      if (err instanceof PackageError && err.code === 'aborted') return sheet.close();
      status.error = plainError(e, err);
      show();
    }
  }

  function plainError(e, err) {
    if (err instanceof PackageError) {
      if (err.code === 'network') return `The download didn't finish: ${err.message} Check your connection and try again.`;
      if (err.code === 'hash' || err.code === 'size') return `This file is not the ${e.name} BEAM published (its fingerprint doesn't match), so nothing was run. Try again later; if it keeps happening, the download is being changed on its way to you.`;
      return `${e.name} could not be opened: ${err.message}`;
    }
    if (err && err.code === 'timeout') return `Your wallet did not answer in time; it may still be finishing what the last dApp asked. Try again in a moment.`;
    if (err && (err.code === 'locked' || err.code === 'no_wallet')) return 'The wallet was locked. Unlock it and open the dApp again.';
    return `${e.name} could not be opened: ${(err && err.message) || err}`;
  }

  /**
   * This dApp's own app API in BEAM's engine (lib/contracts.js): its own app
   * identity, privilege 0. The wallet's approve sheet asks before anything it
   * requests is signed, with the dApp's name on it.
   */
  function connect(manifest, e) {
    return openApp({ appName: manifest.name, appUrl: `campfire-pwa:dapp/${e.guid}/${manifest.startPath}` });
  }

  // ---------------------------------------------------------------- running
  function run(e, files, manifest, appApi) {
    const pref = dappPrefs(app)[e.guid] || {};
    const remoteOrigins = pref.remote === true ? [...e.remoteOrigins] : [];
    const stage = h('div', { class: 'dapp-stage' });
    const busyBar = h('div', { class: 'dapp-busy hidden', 'data-testid': 'dapp-busy' }, progressBar(null));
    const wideHint = h(
      'div',
      { class: 'dapp-hint hidden', 'data-testid': 'dapp-wide-hint' },
      h('span', { text: `${manifest.name} is laid out for a wider screen: swipe sideways to see all of it, or turn your phone.` }),
      h('button', { class: 'icon-btn', 'aria-label': 'Hide this note', onclick: () => wideHint.classList.add('hidden') }, icon('close')),
    );
    const cover = h('div', { class: 'dapp-cover', 'data-testid': 'dapp-cover' }, h('div', { class: 'spinner' }), h('p', { text: `Starting ${manifest.name}…` }));
    const bar = h(
      'header',
      { class: 'dapp-bar' },
      h('button', { class: 'icon-btn', 'aria-label': `Close ${manifest.name}`, 'data-testid': 'dapp-close', onclick: () => closeRunner() }, icon('close')),
      h('span', { class: 'dapp-bar-icon' }, h('img', { src: iconPath(e), alt: '' })),
      h('h1', { text: manifest.name }),
      h('button', { class: 'icon-btn', 'aria-label': 'More', 'data-testid': 'dapp-more', onclick: () => moreSheet(e, files, manifest) }, icon('more')),
    );
    put(layer, bar, busyBar, wideHint, stage, cover);
    layer.classList.remove('hidden');
    document.body.classList.add('dapp-open');
    let busy = 0;
    let busyTimer = null;
    runner = new DappRunner({
      entry: e,
      manifest,
      files,
      appApi,
      remoteOrigins,
      confirmSign: (req) => presentSign(req),
      onActivity: () => app.touch(),
      onOpenLink: (url) => presentLink(manifest.name, url),
      onLayout: ({ width, viewport }) => {
        if (viewport > 0 && width > viewport * 1.2) wideHint.classList.remove('hidden');
      },
      onRefused: (why) => toast(why, 6000),
      onBusy: (d) => {
        busy += d;
        clearTimeout(busyTimer);
        if (busy > 0) busyTimer = setTimeout(() => busyBar.classList.remove('hidden'), 800);
        else busyBar.classList.add('hidden');
      },
      onState: ({ kind, message }) => {
        if (kind === 'running') cover.classList.add('hidden');
        if (kind === 'failed' || kind === 'gone') showStopped(e, files, manifest, message);
      },
    });
    runner.mount(stage);
  }

  function showStopped(e, files, manifest, message) {
    const layerCover = h(
      'div',
      { class: 'dapp-cover', 'data-testid': 'dapp-stopped' },
      notice('warn', message || `${manifest.name} stopped.`),
      h('button', { class: 'btn btn-primary', 'data-testid': 'dapp-reopen', onclick: () => { closeRunner(); start(e); } }, `Open ${manifest.name} again`),
      h('button', { class: 'btn btn-text', onclick: () => closeRunner() }, 'Back to dApps'),
    );
    layer.appendChild(layerCover);
  }

  function moreSheet(e, files, manifest) {
    const pref = dappPrefs(app)[e.guid] || {};
    openSheet((close) => [
      h('h2', { text: manifest.name }),
      h('p', { class: 'small', text: `Version ${manifest.version || e.version} · from BEAM's beam-ui release, checked against its SHA-256 fingerprint.` }),
      e.remoteOrigins.length
        ? h('button', {
            class: 'btn btn-secondary',
            'data-testid': 'dapp-toggle-remote',
            onclick: async () => {
              await setDappPref(app, e.guid, { remote: !(pref.remote === true) });
              close();
              closeRunner();
              start(e);
            },
          }, pref.remote === true ? `Turn off price lookups (${remoteHosts(e)})` : `Turn on price lookups (${remoteHosts(e)} see your IP address)`)
        : null,
      h('button', { class: 'btn btn-secondary', onclick: () => { close(); closeRunner(); start(e); } }, 'Reload'),
      h('button', {
        class: 'btn btn-text',
        onclick: async () => {
          close();
          closeRunner();
          await forgetPackage(e);
          cached.set(e.guid, false);
          renderList();
          toast(`Removed the downloaded copy of ${manifest.name}.`);
        },
      }, 'Remove the downloaded copy'),
    ], { label: manifest.name });
  }

  function closeRunner() {
    if (runner) runner.close();
    runner = null;
    layer.classList.add('hidden');
    put(layer);
    document.body.classList.remove('dapp-open');
    document.querySelectorAll('.overlay').forEach((o) => o.remove());
  }

  // ---------------------------------------------------------------- asking
  function presentSign(req) {
    return new Promise((resolve) => {
      const s = openSheet(
        (close) => [
          h('h2', { 'data-testid': 'dapp-sign', text: `${req.appName} asks you to sign a message` }),
          h('div', { class: 'card mono dapp-message', text: req.message }),
          h('p', { class: 'small', text: 'Signing shows that this wallet wrote the message. It moves no funds.' }),
          h('button', { class: 'btn btn-primary', 'data-testid': 'dapp-sign-approve', onclick: async () => close(await confirmIdentity(app, { title: 'Confirm it is you', detail: `${req.appName}: sign this message`, cta: 'Sign' })) }, 'Sign'),
          h('button', { class: 'btn btn-text', 'data-testid': 'dapp-sign-reject', onclick: () => close(false) }, 'Reject'),
        ],
        { dismissable: false, label: `${req.appName} asks` },
      );
      s.then((v) => resolve(v === true));
    });
  }

  function presentLink(appName, url) {
    const u = new URL(url);
    openSheet((close) => [
      h('h2', { text: `${appName} wants to open a link` }),
      h('p', { class: 'lead' }, h('strong', { text: u.host }), h('br'), h('span', { class: 'small mono', text: url.length > 120 ? `${url.slice(0, 117)}…` : url })),
      h('p', { class: 'small', text: 'It opens in your browser, outside BEAM Campfire. That site sees your IP address.' }),
      h('button', {
        class: 'btn btn-primary',
        onclick: () => {
          close();
          window.open(url, '_blank', 'noopener,noreferrer');
        },
      }, icon('external'), 'Open in browser'),
      h('button', { class: 'btn btn-text', onclick: () => close() }, 'Stay here'),
    ], { label: 'Open link' });
  }

  // ---------------------------------------------------------------- page
  const off = wallet.onChange((s) => renderNote(s));
  renderNote(wallet.state);
  renderList();
  refreshCached();

  const el = screen(
    { title: 'dApps', back: () => app.go('home') },
    h('p', { class: 'lead', text: "BEAM's own dApps. Each runs walled off from your wallet: nothing leaves it without your OK." }),
    topNote,
    listBox,
    layer,
  );

  if (params.open) {
    const e = CATALOGUE.find((x) => x.guid === params.open);
    if (e) queueMicrotask(() => tapOpen(e));
  }

  return {
    el,
    destroy() {
      destroyed = true;
      off();
      if (downloadCtl) downloadCtl.abort();
      closeRunner();
    },
  };
}
