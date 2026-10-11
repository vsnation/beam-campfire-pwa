/* BEAM's DApp Store: the store, a dApp's page, a publisher's page, and the publishers you show
 * (issues #45, #47). Data: lib/dapps/store.js (read from the chain); install: lib/dapps/store_install.js.
 *
 * dappStore
 * Spec: ONE job: find a dApp from a BEAM community publisher.
 *       Primary CTA: a dApp's row (its page has Install). Search and category chips on top.
 *       Taps from app open: 3 (Home > dApps > DApp Store), 4 to a dApp's page.
 * Exit-intent reasons and answers:
 *   - "Who made this? Is it a scam?" -> every row says "by <publisher>" from the chain, and a row
 *     whose name reads like a dApp of BEAM Campfire's, or that another publisher also uses, is marked.
 *   - "Too much junk" -> hide a publisher from its page; the Publishers list shows them back.
 *   - "It doesn't load" -> what failed and Try again; the dApps you have stay under dApps.
 *
 * dappStoreItem
 * Spec: ONE job: decide whether to install this dApp, then install it.
 *       Primary CTA: Install (Update for this publisher's newer version, Open once installed).
 *       Taps from app open: 4, then 1 to install.
 * Exit-intent reasons and answers:
 *   - "Is it safe?" -> who published it (their page one tap away), when, the warnings that apply,
 *     and what installing checks: the file must hash to the publisher's on-chain record, and it runs
 *     walled off from the wallet, asking before anything leaves it.
 *   - "Where does it download from?" -> said under the button: BEAM Campfire's own copy, at this app's address.
 *   - "It isn't in the copy" -> said plainly, with the way on: its .dapp file, Install from a file.
 *
 * dappPublisher
 * Spec: ONE job: see who a publisher is and what they publish.
 *       Primary CTA: one of their dApps; Hide this publisher (secondary).
 */
import { h, put, fmtDate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, notice, primary, secondary, textButton, toast, copyText, progressBar } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { nativeApp } from '../lib/contracts.js';
import { loadShader } from '../lib/shaders.js';
import { readStore, visibleDapps, listedPublishers, CATEGORIES, categoryName, flagText, shortKey } from '../lib/dapps/store.js';
import { installFromStore, storeState, storeInstallErrorText, StoreInstallError } from '../lib/dapps/store_install.js';
import { installed } from '../lib/dapps/installed.js';
import { installErrorText, InstallError } from '../lib/dapps/file_package.js';

// ---------------------------------------------------------------- the store, read once a session

let cache = null; // {session, promise}
/** The store, read from the chain once per wallet run (force: again). */
export function storeData({ force = false } = {}) {
  if (!force && cache && cache.session === wallet.session) return cache.promise;
  const promise = (async () => {
    if (!wallet.session) throw new Error('The wallet is still starting.');
    const [app, shader] = await Promise.all([nativeApp(), loadShader('dappsStore')]);
    return readStore((args) => app.view(args, shader, { timeoutMs: 60000 }));
  })();
  cache = { session: wallet.session, promise };
  promise.catch(() => {
    if (cache && cache.promise === promise) cache = null;
  });
  return promise;
}

const hiddenSet = (app) => new Set(Array.isArray(app.prefs && app.prefs.hiddenPublishers) ? app.prefs.hiddenPublishers : []);
async function setHidden(app, key, hide) {
  const s = hiddenSet(app);
  if (hide) s.add(key);
  else s.delete(key);
  await app.setPrefs({ hiddenPublishers: [...s] });
}

function storeIcon(d, cls = 'dapp-icon') {
  if (d.icon) return h('span', { class: `${cls} file` }, h('img', { src: d.icon, alt: '' }));
  const letter = (d.name.match(/\p{L}|\p{N}/u) || ['?'])[0].toUpperCase();
  return h('span', { class: `${cls} file none letter`, 'aria-hidden': 'true', text: letter });
}

const dateText = (ts) => (ts ? fmtDate(ts) : 'unknown date');
const loading = (text) => h('div', { class: 'card dapp-loading', 'data-testid': 'store-loading' }, h('div', { class: 'spinner small' }), h('span', { class: 'small', text }));
const failed = (e, retry) =>
  h('div', { 'data-testid': 'store-failed' }, notice('error', `BEAM's DApp Store couldn't be read just now (${(e && e.message) || e}). Your installed dApps are under dApps as before.`), secondary('Try again', retry, { 'data-testid': 'store-retry' }));

// ---------------------------------------------------------------- dappStore

export function dappStore(app, params = {}) {
  const box = h('div', { class: 'stack', 'data-testid': 'store-list' });
  let query = params.q || '';
  let category = params.category || 'all';
  let store = null;
  let installedById = new Map();
  let alive = true;

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search dApps and publishers', 'aria-label': 'Search the DApp Store', autocomplete: 'off', 'data-testid': 'store-search' });
  search.value = query;
  search.addEventListener('input', () => {
    query = search.value;
    render();
  });
  const chips = h('div', { class: 'store-chips', role: 'radiogroup', 'aria-label': 'Category' });

  function renderChips() {
    const all = [{ id: 'all', name: 'All' }, ...CATEGORIES];
    put(
      chips,
      ...all.map((c) =>
        h('button', { class: `choice${c.id === category ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(c.id === category), 'data-testid': `store-cat-${c.id}`, onclick: () => ((category = c.id), renderChips(), render()) }, c.name),
      ),
    );
  }

  function row(d) {
    const p = store.publishers.get(d.publisher);
    const flags = store.flags.dapp.get(d.id) || [];
    const mine = installedById.get(d.id);
    const st = storeState(d, mine);
    return h(
      'button',
      { class: 'row dapp-row', type: 'button', onclick: () => app.go('dappStoreItem', { id: d.id }), 'data-testid': 'store-row', 'data-id': d.id, 'data-name': d.name },
      storeIcon(d),
      h(
        'span',
        { class: 'main' },
        h('div', { class: 't', text: d.name }),
        h('div', { class: 's', text: `by ${p ? p.name : shortKey(d.publisher)}` }),
        flags.length ? h('div', { class: 's meta warn-text', 'data-testid': 'store-row-flag', text: flags.some((f) => f.code === 'bundledName' || f.code === 'bundledId') ? 'Name or id like a dApp of BEAM Campfire’s' : 'Another publisher uses this name' }) : null,
      ),
      h('span', { class: 'pill', text: st.action === 'open' ? 'Installed' : st.action === 'update' ? 'Update' : 'View' }),
    );
  }

  function render() {
    if (!alive) return;
    if (!store) return;
    const hidden = hiddenSet(app);
    const list = visibleDapps(store, { hidden, category, query });
    const hiddenCount = [...hidden].filter((k) => store.publishers.has(k)).length;
    put(
      box,
      list.length
        ? h('div', { class: 'card list dapp-list', 'data-testid': 'store-results' }, ...list.map(row))
        : h(
            'div',
            { class: 'card empty', 'data-testid': 'store-empty' },
            h('p', { text: query || category !== 'all' ? 'No dApp matches.' : 'Nothing to show.' }),
            query || category !== 'all' ? textButton('Show every dApp', () => ((query = ''), (search.value = ''), (category = 'all'), renderChips(), render()), { 'data-testid': 'store-clear' }) : null,
          ),
      h(
        'button',
        { class: 'card row', type: 'button', onclick: () => app.go('dappPublishers'), 'data-testid': 'store-publishers' },
        h('span', { class: 'ico' }, icon('person')),
        h('span', { class: 'main' }, h('div', { class: 't', text: 'Publishers' }), h('div', { class: 's', text: hiddenCount ? `${listedPublishers(store).length} · ${hiddenCount} hidden` : `${listedPublishers(store).length}, all shown` })),
        h('span', { class: 'chev' }, icon('chevron')),
      ),
      h('p', { class: 'small settings-note', text: "Anyone can publish in BEAM's DApp Store: BEAM Campfire shows who published each dApp, checks every download against the publisher's record on the chain, and runs it walled off from your wallet." }),
    );
  }

  async function load(force = false) {
    put(box, loading("Reading BEAM's DApp Store from the chain…"));
    try {
      const [s, list] = await Promise.all([storeData({ force }), installed.list().catch(() => [])]);
      if (!alive) return;
      store = s;
      installedById = new Map(list.map((r) => [r.guid, r]));
      render();
    } catch (e) {
      if (alive) put(box, failed(e, () => load(true)));
    }
  }

  renderChips();
  load();
  const el = screen({ title: "BEAM's DApp Store", back: () => app.back('dapps') }, search, chips, box);
  return { el, destroy: () => (alive = false) };
}

// ---------------------------------------------------------------- dappStoreItem

export function dappStoreItem(app, params = {}) {
  const box = h('div', { class: 'stack' });
  let alive = true;
  let busy = null; // AbortController while installing

  async function render() {
    let store;
    try {
      store = await storeData();
    } catch (e) {
      return alive && put(box, failed(e, () => (put(box, loading('Reading the store…')), storeData({ force: true }).then(render, render))));
    }
    if (!alive) return;
    const d = store.dapps.find((x) => x.id === params.id);
    if (!d) return put(box, notice('warn', 'This dApp is no longer in the store.'), secondary('Back to the store', () => app.go('dappStore')));
    const p = store.publishers.get(d.publisher);
    const flags = store.flags.dapp.get(d.id) || [];
    const pubFlags = store.flags.publisher.get(d.publisher) || [];
    const rec = await installed.get(d.id).catch(() => null);
    const st = storeState(d, rec);
    const msg = h('div', { 'data-testid': 'store-item-msg' });
    const bar = h('div', { class: 'hidden', 'data-testid': 'store-item-progress' });

    async function act() {
      if (st.action === 'open') return app.go('dapps', { open: d.id });
      if (busy) return;
      busy = new AbortController();
      btn.disabled = true;
      btn.textContent = st.action === 'update' ? 'Updating…' : 'Installing…';
      put(msg);
      bar.classList.remove('hidden');
      put(bar, progressBar(null));
      try {
        await installFromStore(d, p, {
          signal: busy.signal,
          onProgress: (n, total) => put(bar, progressBar(total ? n / total : null), h('p', { class: 'small', text: `${(n / 1e6).toFixed(1)} MB${total ? ` of ${(total / 1e6).toFixed(1)} MB` : ''}` })),
        });
        toast(st.action === 'update' ? `${d.name} is updated` : `${d.name} is installed`, 3000);
        if (alive) app.go('dapps', { open: d.id });
      } catch (e) {
        const text = storeInstallErrorText(e, d.name) || (e instanceof InstallError ? installErrorText(e, d.name) : `${d.name} wasn't installed: ${(e && e.message) || e}. Nothing on your device changed.`);
        if (alive) {
          put(msg, notice(e && e.code === 'notMirrored' ? 'info' : 'error', text), e && e.code === 'notMirrored' ? secondary('Install from a file', () => app.go('dapps'), { 'data-testid': 'store-item-from-file' }) : null);
          btn.disabled = false;
          btn.textContent = label;
        }
      } finally {
        busy = null;
        bar.classList.add('hidden');
      }
    }

    const blocked = st.action === 'blocked' || !d.servedApi || flags.some((f) => f.code === 'bundledId');
    const label = st.action === 'open' ? 'Open' : st.action === 'update' ? `Update to ${d.versionText}` : `Install ${d.name}`;
    const btn = primary(label, act, { 'data-testid': 'store-item-cta', disabled: blocked });
    const why = blocked
      ? h('p', { class: 'small', 'data-testid': 'store-item-blocked', text: st.action === 'blocked' ? storeInstallErrorText(new StoreInstallError(st.code, ''), d.name) || '' : !d.servedApi ? `${d.name} needs a newer wallet than this version of BEAM Campfire.` : flagText(flags.find((f) => f.code === 'bundledId')) })
      : null;
    put(
      box,
      h('div', { class: 'store-head' }, storeIcon(d, 'dapp-icon big'), h('div', {}, h('h2', { 'data-testid': 'store-item-name', text: d.name }), h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'store-item-publisher', onclick: () => app.go('dappPublisher', { key: d.publisher }) }, `by ${p ? p.name : shortKey(d.publisher)}`))),
      ...flags.map((f) => h('div', { 'data-testid': 'store-item-flag', 'data-code': f.code }, notice('warn', flagText(f)))),
      ...pubFlags.map((f) => h('div', { 'data-testid': 'store-item-pubflag' }, notice('warn', flagText(f)))),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Version' }), h('span', { class: 'v', 'data-testid': 'store-item-version', text: d.versionText })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Published' }), h('span', { class: 'v', text: dateText(d.timestamp) })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Category' }), h('span', { class: 'v', text: categoryName(d.category) })),
        rec ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'On this device' }), h('span', { class: 'v', 'data-testid': 'store-item-installed', text: rec.store ? `Version ${rec.version || '?'}` : 'Another dApp with this id, from a file' })) : null,
      ),
      d.description ? h('p', { class: 'store-desc', 'data-testid': 'store-item-desc', text: d.description }) : null,
      msg,
      bar,
      btn,
      why,
      h('p', { class: 'small settings-note', 'data-testid': 'store-item-note', text: `Downloaded from BEAM Campfire's copy of the store at this app's address, and installed only if it is exactly the file ${p ? p.name : 'its publisher'} recorded on the chain (IPFS ${d.cid.slice(0, 10)}…). It runs walled off from your wallet and asks before anything leaves it.` }),
    );
  }

  put(box, loading('Reading the store…'));
  render();
  const el = screen({ title: 'DApp Store', back: () => app.back('dappStore') }, box);
  return {
    el,
    destroy: () => {
      alive = false;
      if (busy) busy.abort();
    },
  };
}

// ---------------------------------------------------------------- dappPublisher

export function dappPublisher(app, params = {}) {
  const box = h('div', { class: 'stack' });
  let alive = true;

  async function render() {
    let store;
    try {
      store = await storeData();
    } catch (e) {
      return alive && put(box, failed(e, () => storeData({ force: true }).then(render, render)));
    }
    if (!alive) return;
    const p = store.publishers.get(params.key);
    if (!p) return put(box, notice('warn', 'This publisher is not in the store.'), secondary('Back to the store', () => app.go('dappStore')));
    const flags = store.flags.publisher.get(p.key) || [];
    const hidden = hiddenSet(app).has(p.key);
    const link = (url, text, testid) => h('a', { class: 'row', href: url, target: '_blank', rel: 'noopener noreferrer', 'data-testid': testid }, h('span', { class: 'ico' }, icon('external')), h('span', { class: 'main' }, h('div', { class: 't', text })), null);
    put(
      box,
      h('h2', { 'data-testid': 'publisher-name', text: p.name }),
      p.title ? h('p', { class: 'lead', text: p.title }) : null,
      ...flags.map((f) => h('div', { 'data-testid': 'publisher-flag' }, notice('warn', flagText(f)))),
      p.about ? h('p', { class: 'store-desc', 'data-testid': 'publisher-about', text: p.about }) : null,
      p.website || p.socials.length
        ? h(
            'div',
            { class: 'card list', 'data-testid': 'publisher-links' },
            p.website ? link(p.website, p.website.replace(/^https:\/\//, '').replace(/\/$/, ''), 'publisher-website') : null,
            ...p.socials.map((s) => (s.url ? link(s.url, `${s.label}: ${s.text}`, `publisher-${s.kind}`) : h('div', { class: 'row', 'data-testid': `publisher-${s.kind}` }, h('span', { class: 'main' }, h('div', { class: 't', text: `${s.label}: ${s.text}` }))))),
          )
        : null,
      p.website || p.socials.some((s) => s.url) ? h('p', { class: 'small', text: 'Links open outside BEAM Campfire; the site sees your IP address.' }) : null,
      h('p', { class: 'section-title', text: `dApps (${p.dapps.length})` }),
      p.dapps.length
        ? h(
            'div',
            { class: 'card list dapp-list', 'data-testid': 'publisher-dapps' },
            ...p.dapps.map((d) => h('button', { class: 'row dapp-row', type: 'button', onclick: () => app.go('dappStoreItem', { id: d.id }), 'data-testid': 'publisher-dapp' }, storeIcon(d), h('span', { class: 'main' }, h('div', { class: 't', text: d.name }), h('div', { class: 's', text: `Version ${d.versionText} · ${categoryName(d.category)}` })), h('span', { class: 'chev' }, icon('chevron')))),
          )
        : h('p', { class: 'small', text: 'None listed.' }),
      h('div', { class: 'card' }, h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Publisher key' }), h('button', { class: 'v mono btn-text', type: 'button', 'data-testid': 'publisher-key', onclick: () => copyText(p.key, 'Publisher key copied'), text: shortKey(p.key) }))),
      h('p', { class: 'small', text: 'The key is what identifies a publisher: names are not unique. Only the holder of this key can publish under it.' }),
      secondary(hidden ? 'Show this publisher' : 'Hide this publisher', async () => {
        await setHidden(app, p.key, !hidden);
        toast(hidden ? `${p.name} is shown in the store` : `${p.name} is hidden from the store`, 3000);
        render();
      }, { 'data-testid': 'publisher-hide' }),
    );
  }

  put(box, loading('Reading the store…'));
  render();
  const el = screen({ title: 'Publisher', back: () => app.back('dappStore') }, box);
  return { el, destroy: () => (alive = false) };
}

// ---------------------------------------------------------------- dappPublishers

export function dappPublishers(app) {
  const box = h('div', { class: 'stack' });
  let alive = true;
  async function render() {
    let store;
    try {
      store = await storeData();
    } catch (e) {
      return alive && put(box, failed(e, () => storeData({ force: true }).then(render, render)));
    }
    if (!alive) return;
    const hidden = hiddenSet(app);
    const row = (p) => {
      const sw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': `Show ${p.name}`, 'data-testid': 'publishers-switch', 'data-key': p.key, checked: !hidden.has(p.key) });
      sw.addEventListener('change', () => setHidden(app, p.key, !sw.checked));
      return h(
        'div',
        { class: 'row' },
        h('button', { class: 'main row-link', type: 'button', 'data-testid': 'publishers-open', onclick: () => app.go('dappPublisher', { key: p.key }) }, h('div', { class: 't', text: p.name }), h('div', { class: 's', text: `${p.dapps.length === 1 ? '1 dApp' : `${p.dapps.length} dApps`} · ${shortKey(p.key)}` })),
        sw,
      );
    };
    put(box, h('p', { class: 'lead', text: 'Publishers with dApps in the store. Turn one off to hide its dApps from the store on this device.' }), h('div', { class: 'card list', 'data-testid': 'publishers-list' }, ...listedPublishers(store).map(row)));
  }
  put(box, loading('Reading the store…'));
  render();
  const el = screen({ title: 'Publishers', back: () => app.back('dappStore') }, box);
  return { el, destroy: () => (alive = false) };
}

