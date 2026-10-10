/* dApps
 * Spec: ONE job: open a dApp without giving it the wallet: one of BEAM's own, or one
 *       installed from a .dapp file.
 *       Primary CTA: the dApp's row, "Open" (the first time: "Download and open").
 *       "Install from file" is secondary, below the list.
 *       Taps from app open: 2 after unlock (Home > dApps > Open); 3 the first time.
 *       From a file: dApps > Install from file > (pick) > Install <name>, then Open.
 * Exit-intent reasons and answers:
 *   - "What will it download, from where, and who sees it?" -> the size and the host are on
 *     the button's sheet before anything is fetched, and the extra hosts a dApp contacts are
 *     off unless turned on, with the reason (they see your IP address).
 *   - "Can it take my money?" -> it can only ask. Every payment or contract call shows this
 *     dApp's name, what leaves and what arrives, and needs Face ID or the password.
 *   - "Is this file safe?" -> the install sheet says plainly that BEAM Campfire did not
 *     check it, warns when its name copies one of BEAM's dApps, and it reaches no server
 *     until the person allows that server, by name, when the dApp first tries it.
 *   - "It broke / it's stuck" -> every failure says what happened and offers the next step;
 *     Close is always on screen.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, notice, openSheet, progressBar, toast } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { isControlled } from '../lib/loader.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { CATALOGUE, iconPath, sizeText, hostOf } from '../lib/dapps/catalogue.js';
import { downloadPackage, cachedPackage, keepPackage, isCached, forgetPackage, openPackage, PackageError } from '../lib/dapps/package.js';
import { DappRunner, runnerStats } from '../lib/dapps/runner.js';
import { DEFAULT_LIMITS } from '../lib/dapps/zip.js';
import { InstallError, readFilePackage, catalogueEntryFor, catalogueNameCopiedBy, installErrorText } from '../lib/dapps/file_package.js';
import { installed, iconDataUrl } from '../lib/dapps/installed.js';
import { remoteOriginFor } from '../lib/dapps/frame_policy.js';
import { openApp } from '../lib/contracts.js';

export { runnerStats };

const FILE_INPUT_ID = 'dapp-file-input';
const NOT_CHECKED = 'installed from a file, not checked by BEAM Campfire';

const remoteHosts = (e) => e.remoteOrigins.map(hostOf).join(' and ');

function dappPrefs(app) {
  return (app.prefs && app.prefs.dapps) || {};
}

async function setDappPref(app, guid, patch) {
  const all = { ...dappPrefs(app) };
  all[guid] = { ...(all[guid] || {}), ...patch };
  await app.setPrefs({ dapps: all });
}

/** A dApp installed from a file, as the runner and this screen see it. */
function fileEntry(rec) {
  return { file: true, guid: rec.guid, name: rec.name, needsEval: true, remoteOrigins: [...rec.origins], rec };
}

const versionText = (v) => (v ? `Version ${v}` : 'No version');
const publisherText = (p) => (p ? `by ${p}` : 'unknown publisher');

function dappIcon(e, cls = 'dapp-icon') {
  if (!e.file) return h('span', { class: cls }, h('img', { src: iconPath(e), alt: '' }));
  return e.rec.icon ? h('span', { class: `${cls} file` }, h('img', { src: e.rec.icon, alt: '' })) : h('span', { class: `${cls} file none` }, icon('apps'));
}

export default function dapps(app, params = {}) {
  let runner = null;
  let cur = null; // the running dApp: {e, declined: Set of origins, queue, asking}
  let downloadCtl = null;
  let destroyed = false;
  let ready = false;
  let loadFailed = false;
  let installing = false;
  let files = []; // installed from a file
  const cached = new Map();
  const listBox = h('div', { 'data-testid': 'dapp-list' });
  const topNote = h('div');
  const layer = h('div', { class: 'dapp-layer hidden', 'data-testid': 'dapp-layer' });

  const canRun = isControlled();

  // No `accept` attribute: iOS has no file type for ".dapp" and would grey every file out.
  // Whatever is picked is checked as a package (lib/dapps/file_package.js).
  const fileInput = h('input', { type: 'file', id: FILE_INPUT_ID, class: 'file-input', 'data-testid': 'dapp-file-input', tabindex: '-1', 'aria-hidden': 'true', disabled: !canRun });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // picking the same file again still counts as a pick
    if (f) picked(f);
  });
  const chooseFile = (cls, label, testid) => {
    const l = h('label', { class: `btn ${cls}${canRun ? '' : ' disabled'}`, for: FILE_INPUT_ID, role: 'button', tabindex: '0', 'aria-disabled': canRun ? null : 'true', 'data-testid': testid }, icon('file'), h('span', { text: label }));
    l.addEventListener('keydown', (ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), fileInput.click()));
    return l;
  };

  // ---------------------------------------------------------------- list
  function catalogueRow(e) {
    const down = cached.get(e.guid);
    return h(
      'button',
      { class: 'row dapp-row', onclick: () => tapOpen(e), disabled: !canRun, 'data-testid': `dapp-${e.guid}`, 'data-name': e.name },
      dappIcon(e),
      h(
        'span',
        { class: 'main' },
        h('div', { class: 't', text: e.name }),
        h('div', { class: 's', text: e.blurb }),
        h('div', { class: 's meta', 'data-testid': 'dapp-size', text: down ? 'Downloaded · checked against its fingerprint' : `${sizeText(e.size)} download` }),
      ),
      h('span', { class: 'pill', text: 'Open' }),
    );
  }

  function fileRow(rec) {
    const e = fileEntry(rec);
    return h(
      'button',
      { class: 'row dapp-row', onclick: () => start(e), disabled: !canRun, 'data-testid': `dapp-file-${rec.guid}`, 'data-name': rec.name },
      dappIcon(e),
      h(
        'span',
        { class: 'main' },
        h('div', { class: 't', text: rec.name }),
        h('div', { class: 's', text: rec.description }),
        h('div', { class: 's meta wrap', text: `${versionText(rec.version)} · from a file, not checked by BEAM Campfire` }),
      ),
      h('span', { class: 'pill', text: 'Open' }),
    );
  }

  /** An installed row with its Remove button beside it (a button cannot hold another). */
  const withRemove = (row, name, onRemove, guid) =>
    h('div', { class: 'dapp-item' }, row, h('button', { class: 'icon-btn dapp-remove', 'aria-label': `Remove ${name}`, 'data-testid': `dapp-remove-${guid}`, onclick: onRemove }, icon('trash')));

  function renderList() {
    if (destroyed) return;
    if (!ready) return put(listBox, h('div', { class: 'card dapp-loading' }, h('div', { class: 'spinner small' }), h('span', { class: 'small', text: 'Loading your dApps…' })));
    if (loadFailed) {
      return put(
        listBox,
        h('div', { 'data-testid': 'dapp-load-failed' }, notice('error', "BEAM Campfire couldn't read your installed dApps. Nothing was changed. Try again; if it keeps happening, reload BEAM Campfire.")),
        h('button', { class: 'btn btn-primary', onclick: () => ((ready = false), renderList(), refresh()) }, 'Try again'),
      );
    }
    const items = [
      ...files.map((rec) => ({ name: rec.name, el: withRemove(fileRow(rec), rec.name, () => removeSheet(fileEntry(rec)), rec.guid) })),
      ...CATALOGUE.filter((e) => cached.get(e.guid)).map((e) => ({ name: e.name, el: withRemove(catalogueRow(e), e.name, () => removeSheet(e), e.guid) })),
    ].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const available = CATALOGUE.filter((e) => !cached.get(e.guid));
    put(
      listBox,
      items.length ? h('p', { class: 'section-title', text: 'Installed' }) : null,
      items.length ? h('div', { class: 'card list dapp-list', 'data-testid': 'dapp-installed' }, ...items.map((i) => i.el)) : null,
      h('p', { class: 'section-title', text: 'Available' }),
      available.length
        ? h('div', { class: 'card list dapp-list', 'data-testid': 'dapp-available' }, ...available.map(catalogueRow))
        : h('p', { class: 'small', 'data-testid': 'dapp-available-none', text: "Every one of BEAM's dApps is downloaded. You can still add another one from a .dapp file below." }),
      h(
        'div',
        { class: 'dapp-file-block' },
        h('p', { class: 'small', text: "Have a .dapp file from a dApp's publisher?" }),
        chooseFile('btn-secondary', 'Install from file', 'dapp-install-file'),
      ),
    );
  }

  function renderNote(s) {
    const parts = [];
    if (!canRun) parts.push(notice('warn', 'dApps run only in the installed BEAM Campfire (the copy checked against its release signature). Open BEAM Campfire from its home screen icon or its web address and try again.'));
    else if (s.sync.state !== 'synced') parts.push(notice('info', `The wallet is ${s.sync.title.toLowerCase().replace(/[.…]+$/, '')}. dApps can open now; what they read from the network waits until it has caught up.`));
    put(topNote, ...parts);
  }

  async function refresh() {
    for (const e of CATALOGUE) cached.set(e.guid, await isCached(e).catch(() => false));
    try {
      files = await installed.list();
      loadFailed = false;
    } catch {
      loadFailed = true;
    }
    ready = true;
    renderList();
  }

  // ---------------------------------------------------------------- installing from a file
  async function picked(file) {
    app.touch();
    if (installing || !canRun) return;
    installing = true;
    // Most files are read at once; a large one shows that something is happening.
    let checking = null;
    const slow = setTimeout(() => {
      checking = openSheet(() => [h('div', { class: 'dapp-progress', 'data-testid': 'dapp-checking' }, h('p', { class: 'lead', text: 'Checking the file…' }), progressBar(null))], { dismissable: false, label: 'Checking the file' });
    }, 400);
    const done = () => {
      clearTimeout(slow);
      if (checking) checking.close();
    };
    try {
      if (file.size > DEFAULT_LIMITS.maxPackageBytes) throw new InstallError('tooLarge', `package is ${file.size} bytes`);
      let bytes;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        throw new InstallError('cantOpenFile', 'the file could not be read');
      }
      const pkg = await readFilePackage(bytes);
      const same = catalogueEntryFor(pkg);
      done();
      if (destroyed) return;
      if (same) {
        // BEAM's own package, byte for byte: the same as downloading it.
        if (!(await keepPackage(same, bytes))) throw new InstallError('storage', 'the package cache refused it');
        cached.set(same.guid, true);
        renderList();
        toast(`${same.name} is installed: this file is BEAM's own package, checked against its fingerprint.`, 5000);
        return;
      }
      const existing = await installed.get(pkg.manifest.guid);
      confirmInstall(pkg, bytes, existing, catalogueNameCopiedBy(pkg.manifest));
    } catch (err) {
      done();
      if (!destroyed) installProblem(err, 'this dApp');
    } finally {
      installing = false;
    }
  }

  function confirmInstall(pkg, bytes, existing, copies) {
    const m = pkg.manifest;
    const preview = fileEntry({ guid: m.guid, name: m.name, origins: [], icon: iconDataUrl(pkg.files, m.iconPath) });
    openSheet(
      (close) => [
        h('div', { class: 'dapp-sheet-head' }, dappIcon(preview, 'dapp-icon big'), h('h2', { 'data-testid': 'dapp-install-title', text: `Install ${m.name}?` })),
        h('p', { class: 'small', 'data-testid': 'dapp-install-meta', text: `${versionText(m.version)} · ${publisherText(m.publisher)}` }),
        existing
          ? h('p', { class: 'small', 'data-testid': 'dapp-install-replaces', text: `Replaces the installed version ${existing.version || '(no version)'}.${existing.origins.length ? ` It keeps the servers you let it reach: ${existing.origins.map(hostOf).join(', ')}.` : ''}` })
          : null,
        copies ? h('div', { 'data-testid': 'dapp-install-copies' }, notice('warn', `Its name matches ${copies}, one of the dApps BEAM Campfire checks, but it is a different app.`)) : null,
        h(
          'div',
          { 'data-testid': 'dapp-install-unchecked' },
          notice(
            copies ? 'info' : 'warn',
            "BEAM Campfire did not check this dApp: it is not one of BEAM's own dApps. Install it only if you trust where it came from. Payments, contract calls and signatures it asks for still come to BEAM Campfire for your approval, but it can read some wallet details without asking, and what you approve can't be undone.",
          ),
        ),
        h(
          'div',
          { class: 'sheet-actions' },
          h('button', { class: 'btn btn-primary', 'data-testid': 'dapp-install-go', onclick: () => (close(true), saveInstall(pkg, bytes, existing)) }, `${existing ? 'Replace' : 'Install'} ${m.name}`),
          h('button', { class: 'btn btn-text', 'data-testid': 'dapp-install-cancel', onclick: () => close(false) }, 'Cancel'),
        ),
      ],
      { label: `Install ${m.name}` },
    );
  }

  async function saveInstall(pkg, bytes, existing) {
    const name = pkg.manifest.name;
    try {
      await installed.install(pkg, bytes, { replace: Boolean(existing) });
      files = await installed.list();
      renderList();
      toast(`${name} is installed. Tap it to open.`, 4000);
    } catch (err) {
      if (!destroyed) installProblem(err, name, err instanceof InstallError && err.code === 'storage' ? () => saveInstall(pkg, bytes, existing) : null);
    }
  }

  function installProblem(err, name, retry = null) {
    openSheet(
      (close) => [
        h('h2', { text: 'Nothing was installed' }),
        h('div', { 'data-testid': 'dapp-install-error', 'data-code': err && err.code ? err.code : null }, notice('error', installErrorText(err, name))),
        h(
          'div',
          { class: 'sheet-actions' },
          retry
            ? h('button', { class: 'btn btn-primary', 'data-testid': 'dapp-install-retry', onclick: () => (close(), retry()) }, 'Try again')
            : (() => {
                const l = chooseFile('btn-primary', 'Choose another file', 'dapp-install-another');
                l.addEventListener('click', () => close());
                return l;
              })(),
          h('button', { class: 'btn btn-text', 'data-testid': 'dapp-install-close', onclick: () => close() }, 'Close'),
        ),
      ],
      { label: 'Nothing was installed' },
    );
  }

  // ---------------------------------------------------------------- removing
  function removeSheet(e) {
    openSheet(
      (close) => [
        h('h2', { 'data-testid': 'dapp-remove-title', text: `Remove ${e.name}?` }),
        h('p', { class: 'lead', text: 'Its files and the data it saved on this device are deleted. Your funds and transactions are not affected.' }),
        h(
          'div',
          { class: 'sheet-actions' },
          h('button', { class: 'btn btn-danger', 'data-testid': 'dapp-remove-confirm', onclick: () => (close(), remove(e)) }, `Remove ${e.name}`),
          h('button', { class: 'btn btn-text', onclick: () => close() }, 'Cancel'),
        ),
      ],
      { label: `Remove ${e.name}` },
    );
  }

  async function remove(e) {
    if (cur && cur.e.guid === e.guid) closeRunner();
    try {
      if (e.file) await installed.remove(e.guid);
      else await forgetPackage(e);
    } catch {
      toast(`BEAM Campfire couldn't remove ${e.name}. Nothing was changed. Try again.`, 5000);
      return;
    }
    if (!e.file) cached.set(e.guid, false);
    files = await installed.list().catch(() => files.filter((r) => r.guid !== e.guid));
    renderList();
    toast(`${e.name} is removed.`);
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
        h('div', { class: 'dapp-sheet-head' }, dappIcon(e, 'dapp-icon big'), h('h2', { text: e.name })),
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

  /**
   * Opens a dApp: a catalogue one is downloaded (the first time) or loaded from the kept copy
   * and verified; a file one is read from this wallet's storage and checked again. carry: what
   * the person already said about hosts in this run (kept across the reload an Allow makes).
   */
  async function start(e, carry = null) {
    app.touch();
    const status = { text: '', fraction: null, error: null };
    let sheet = null;
    const show = () => {
      if (!sheet || sheet.closed) return;
      sheet.rerender();
    };
    sheet = openSheet(
      (close) => [
        h('div', { class: 'dapp-sheet-head' }, dappIcon(e, 'dapp-icon big'), h('h2', { text: e.name })),
        status.error
          ? notice('error', status.error)
          : h('div', { class: 'dapp-progress', 'data-testid': 'dapp-progress' }, h('p', { class: 'lead', text: status.text }), progressBar(status.fraction)),
        status.error ? h('button', { class: 'btn btn-primary', 'data-testid': 'dapp-retry', onclick: () => { close(); start(e); } }, 'Try again') : null,
        h('button', { class: 'btn btn-text', 'data-testid': 'dapp-cancel', onclick: () => { if (downloadCtl) downloadCtl.abort(); close(); } }, status.error ? 'Back to dApps' : 'Cancel'),
      ],
      { dismissable: false, label: `Opening ${e.name}` },
    );
    try {
      let unpacked;
      let manifest;
      if (e.file) {
        status.text = `Checking ${e.name}…`;
        show();
        const { rec, pkg } = await installed.open(e.guid);
        e = fileEntry(rec);
        unpacked = pkg.files;
        manifest = { name: rec.name, guid: rec.guid, startPath: pkg.manifest.startPath, version: pkg.manifest.version, apiVersion: pkg.manifest.apiVersion, minApiVersion: pkg.manifest.minApiVersion };
      } else {
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
        ({ files: unpacked, manifest } = await openPackage(e, bytes));
      }
      if (destroyed || sheet.closed) return;
      status.text = 'Connecting it to your wallet…';
      show();
      const appApi = await connect(manifest, e);
      if (destroyed || sheet.closed) {
        appApi.close();
        return;
      }
      sheet.close();
      run(e, unpacked, manifest, appApi, carry);
    } catch (err) {
      downloadCtl = null;
      if (sheet.closed || destroyed) return;
      if (err instanceof PackageError && err.code === 'aborted') return sheet.close();
      status.error = plainError(e, err);
      show();
    }
  }

  function plainError(e, err) {
    if (err instanceof InstallError) return `${e.name} could not be opened: BEAM Campfire couldn't read the copy saved on this device. Remove ${e.name}, then install its file again.`;
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
   * requests is signed, with the dApp's name on it (and, from a file, that
   * BEAM Campfire did not check it).
   */
  function connect(manifest, e) {
    if (e.file) return openApp({ appName: manifest.name, appUrl: `campfire-pwa:dapp-file/${e.guid}/${manifest.startPath}`, unchecked: true });
    return openApp({ appName: manifest.name, appUrl: `campfire-pwa:dapp/${e.guid}/${manifest.startPath}` });
  }

  // ---------------------------------------------------------------- running
  function run(e, unpacked, manifest, appApi, carry) {
    const pref = dappPrefs(app)[e.guid] || {};
    // Catalogue: its listed hosts when the person turned them on. File: the hosts the person allowed.
    const remoteOrigins = e.file || pref.remote === true ? [...e.remoteOrigins] : [];
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
      h('button', { class: 'icon-btn', 'aria-label': `Close ${manifest.name}`, 'data-testid': 'dapp-close', 'data-back': '1', onclick: () => closeRunner() }, icon('close')),
      dappIcon(e, 'dapp-bar-icon'),
      h('h1', { text: manifest.name }),
      h('button', { class: 'icon-btn', 'aria-label': 'More', 'data-testid': 'dapp-more', onclick: () => moreSheet(e, manifest) }, icon('more')),
    );
    put(layer, bar, busyBar, wideHint, stage, cover);
    layer.classList.remove('hidden');
    document.body.classList.add('dapp-open');
    let busy = 0;
    let busyTimer = null;
    cur = { e, declined: carry ? carry.declined : new Set(), queue: [], asking: null };
    runner = new DappRunner({
      entry: e,
      manifest,
      files: unpacked,
      appApi,
      remoteOrigins,
      confirmSign: (req) => presentSign(req, e.file === true),
      onActivity: () => app.touch(),
      onOpenLink: (url) => presentLink(manifest.name, url),
      onLayout: ({ width, viewport }) => {
        if (viewport > 0 && width > viewport * 1.2) wideHint.classList.remove('hidden');
      },
      onRefused: (why) => toast(why, 6000),
      onBlocked: (b) => blocked(b.origin),
      onBusy: (d) => {
        busy += d;
        clearTimeout(busyTimer);
        if (busy > 0) busyTimer = setTimeout(() => busyBar.classList.remove('hidden'), 800);
        else busyBar.classList.add('hidden');
      },
      onState: ({ kind, message }) => {
        if (kind === 'running') cover.classList.add('hidden');
        if (kind === 'failed' || kind === 'gone') showStopped(e, manifest, message);
      },
    });
    runner.mount(stage);
  }

  function showStopped(e, manifest, message) {
    const layerCover = h(
      'div',
      { class: 'dapp-cover', 'data-testid': 'dapp-stopped' },
      notice('warn', message || `${manifest.name} stopped.`),
      h('button', { class: 'btn btn-primary', 'data-testid': 'dapp-reopen', onclick: () => { closeRunner(); start(e); } }, `Open ${manifest.name} again`),
      h('button', { class: 'btn btn-text', onclick: () => closeRunner() }, 'Back to dApps'),
    );
    layer.appendChild(layerCover);
  }

  function reopen(e, carry = null) {
    closeRunner();
    start(e, carry);
  }

  function moreSheet(e, manifest) {
    if (e.file) return fileMoreSheet(e, manifest);
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
              reopen(e);
            },
          }, pref.remote === true ? `Turn off price lookups (${remoteHosts(e)})` : `Turn on price lookups (${remoteHosts(e)} see your IP address)`)
        : null,
      h('button', { class: 'btn btn-secondary', onclick: () => { close(); reopen(e); } }, 'Reload'),
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

  function fileMoreSheet(e, manifest) {
    const rec = e.rec;
    openSheet((close) => [
      h('div', { class: 'dapp-sheet-head' }, dappIcon(e, 'dapp-icon big'), h('h2', { text: manifest.name })),
      h('p', { class: 'small', 'data-testid': 'dapp-more-meta', text: `${versionText(rec.version)} · ${publisherText(rec.publisher)} · ${NOT_CHECKED}.` }),
      h('p', { class: 'section-title', text: 'Servers it can reach' }),
      e.remoteOrigins.length
        ? h(
            'div',
            { class: 'card list dapp-hosts', 'data-testid': 'dapp-hosts' },
            ...e.remoteOrigins.map((o) =>
              h(
                'div',
                { class: 'row dapp-host' },
                h('span', { class: 'ico' }, icon('globe')),
                h(
                  'span',
                  { class: 'main' },
                  h('div', { class: 't', text: hostOf(o) }),
                  h('div', { class: 's', text: 'Sees your IP address and what it is asked' }),
                  h('button', { class: 'btn btn-text btn-small', 'data-testid': 'dapp-host-revoke', 'data-host': hostOf(o), onclick: () => (close(), revoke(e, o)) }, 'Remove access'),
                ),
              ),
            ),
          )
        : h('p', { class: 'small', 'data-testid': 'dapp-hosts-none', text: `None. When ${manifest.name} tries to reach a server, BEAM Campfire asks you first.` }),
      h('button', { class: 'btn btn-secondary', 'data-testid': 'dapp-reload', onclick: () => (close(), reopen(e)) }, 'Reload'),
      h('button', { class: 'btn btn-text danger', 'data-testid': 'dapp-remove-file', onclick: () => (close(), removeSheet(e)) }, `Remove ${manifest.name}`),
    ], { label: manifest.name });
  }

  async function revoke(e, origin) {
    let rec;
    try {
      rec = await installed.revoke(e.guid, origin);
    } catch {
      toast(`BEAM Campfire couldn't change what ${e.name} may reach. Nothing was changed. Try again.`, 5000);
      return;
    }
    toast(`${e.name} can no longer reach ${hostOf(origin)}. Reloading it…`, 4000);
    reopen(fileEntry(rec));
  }

  // ---------------------------------------------------------------- network permission
  /**
   * The frame's policy refused a request: a dApp from a file starts with no servers, and the
   * person is asked once per host, one host at a time, whether this dApp may reach it.
   * Catalogue dApps keep their fixed hosts and are never asked about.
   */
  function blocked(origin) {
    const run = cur;
    if (!run || !run.e.file || remoteOriginFor(origin) !== origin) return;
    if (run.e.remoteOrigins.includes(origin) || run.declined.has(origin) || run.queue.includes(origin) || run.asking === origin) return;
    run.queue.push(origin);
    askNext(run);
  }

  function askNext(run) {
    if (run !== cur || run.asking || !run.queue.length) return;
    const origin = run.queue.shift();
    run.asking = origin;
    const host = hostOf(origin);
    const name = run.e.name;
    const s = openSheet(
      (close) => [
        h('div', { class: 'dapp-sheet-head' }, h('span', { class: 'dapp-icon big file none' }, icon('globe')), h('h2', { 'data-testid': 'dapp-host-title', text: `Let ${name} connect to ${host}?` })),
        h('p', { class: 'lead', text: `${host} will see your IP address and everything ${name} asks it.` }),
        h('p', { class: 'small', text: `Allow it only if you trust ${name} and that server: BEAM Campfire checked neither. ${name} could also tell the server what it can read from your wallet without asking, such as your balance. You can take this back in More (⋯) at any time.` }),
        h(
          'div',
          { class: 'sheet-actions' },
          h('button', { class: 'btn btn-primary', 'data-testid': 'dapp-host-allow', onclick: () => close('allow') }, 'Allow'),
          h('button', { class: 'btn btn-text', 'data-testid': 'dapp-host-later', onclick: () => close('later') }, 'Not now'),
        ),
      ],
      { label: `Let ${name} connect to ${host}` },
    );
    s.then(async (answer) => {
      if (run !== cur) return;
      run.asking = null;
      if (answer !== 'allow') {
        run.declined.add(origin);
        return askNext(run);
      }
      let rec;
      try {
        rec = await installed.allow(run.e.guid, origin);
      } catch {
        toast(`BEAM Campfire couldn't save that. ${name} still can't reach ${host}; it will ask again next time.`, 5000);
        return askNext(run);
      }
      if (run !== cur) return;
      toast(`${name} can now reach ${host}. Reloading it…`, 4000);
      reopen(fileEntry(rec), { declined: run.declined });
    });
  }

  function closeRunner() {
    if (runner) runner.close();
    runner = null;
    cur = null;
    layer.classList.add('hidden');
    put(layer);
    document.body.classList.remove('dapp-open');
    document.querySelectorAll('.overlay').forEach((o) => o.remove());
  }

  // ---------------------------------------------------------------- asking
  function presentSign(req, unchecked) {
    return new Promise((resolve) => {
      const s = openSheet(
        (close) => [
          h('h2', { 'data-testid': 'dapp-sign', text: `${req.appName} asks you to sign a message` }),
          unchecked ? h('p', { class: 'tag unchecked', text: 'Installed from a file · not checked by BEAM Campfire' }) : null,
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
  refresh();

  const el = screen(
    { title: 'dApps', back: () => app.back('home') },
    h('p', { class: 'lead', text: "BEAM's own dApps, and any you install from a file. Each runs walled off from your wallet: nothing leaves it without your OK." }),
    topNote,
    listBox,
    layer,
  );
  el.appendChild(fileInput);

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
