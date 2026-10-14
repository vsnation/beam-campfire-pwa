// Shared screen furniture: top bar, tab bar, sheets, toasts.
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { badgeText, assetLabel, frameInset, genericIcon } from './meta.js';
import { APP_VERSION, BUILT } from './version.js';
import { t, tn } from './i18n.js';

export function topbar({ title, back, brand = false, right = null }) {
  return h(
    'header',
    { class: 'topbar' },
    back ? h('button', { class: 'icon-btn', 'aria-label': t('Back'), onclick: back }, icon('back')) : null,
    // brand: true for the app's name, or an element of its own (Home: the open wallet's name).
    brand instanceof Node ? brand : brand ? h('div', { class: 'brand' }, h('img', { src: 'img/logo.svg', alt: '' }), h('span', { text: 'BEAM Campfire' })) : h('h1', { text: title || '' }), // i18n-ignore: the app's name
    right,
  );
}

export function tabbar(app, active) {
  const tab = (name, label, ico) =>
    h('button', { class: `tab${active === name ? ' on' : ''}`, 'aria-current': active === name ? 'page' : null, onclick: () => app.go(name) }, icon(ico), h('span', { text: label }));
  return h('nav', { class: 'tabbar', 'aria-label': t('Main') }, h('div', { class: 'inner' }, tab('home', t('Wallet'), 'home'), tab('activity', t('Activity'), 'activity'), tab('settings', t('Settings'), 'settings')));
}

export function screen(opts, ...body) {
  const { tabs = null, app = null, actions = null, cls = '' } = opts;
  const el = h(
    'main',
    { class: `screen${tabs ? ' has-tabs' : ''} ${cls}` },
    opts.topbar === false ? null : topbar(opts),
    h('div', { class: 'content' }, ...body),
    actions ? h('div', { class: 'actions' }, ...[].concat(actions)) : null,
  );
  if (tabs && app) el.appendChild(tabbar(app, tabs));
  return el;
}

/**
 * "Version 0.2.14", in small print where a screen comes before any wallet is open (issue #82):
 * which release a copy of the app serves, without making a wallet first. null in an unbuilt tree
 * or for anything that is not a plain release number.
 */
export function versionText(version = APP_VERSION, built = BUILT) {
  return built && typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? t('Version {version}', { version }) : null;
}

/** The line itself, last on its screen (css .version keeps it at the bottom), or null. */
export function versionLine(version = APP_VERSION, built = BUILT) {
  const text = versionText(version, built);
  return text ? h('p', { class: 'version', 'data-testid': 'app-version', text }) : null;
}

export function notice(kind, ...content) {
  const ico = { warn: 'alert', error: 'alert', info: 'info', success: 'check' }[kind] || 'info';
  return h('div', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : null }, icon(ico), h('div', { class: 'grow' }, ...content));
}

export function primary(label, onclick, extra = {}) {
  return h('button', { class: 'btn btn-primary', onclick, ...extra }, label);
}
export function secondary(label, onclick, extra = {}) {
  return h('button', { class: 'btn btn-secondary', onclick, ...extra }, label);
}
export function textButton(label, onclick, extra = {}) {
  return h('button', { class: 'btn btn-text', onclick, ...extra }, label);
}

let toastTimer = null;
export function toast(message, ms = 2600) {
  document.querySelectorAll('.toast').forEach((el) => el.remove());
  const box = h('div', { class: 'toast', role: 'status', text: message });
  document.body.appendChild(box);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.remove(), ms);
}

/**
 * Whether the app may put the caret in a field by itself: only on a computer (a mouse and a
 * keyboard). On a phone the browser focuses the field without opening the keyboard (iOS opens it
 * only for a tap), and a tap on that already-focused field then offers Paste instead of the
 * keyboard: the person could not type their password. There they tap the field themselves.
 */
export function canAutofocus(win = globalThis) {
  return typeof win.matchMedia === 'function' && win.matchMedia('(hover: hover) and (pointer: fine)').matches; // i18n-ignore: a CSS media query
}

/** Focuses `el` once it is on screen, on a computer only (canAutofocus). */
export function focusSoon(el, delay = 50) {
  if (!el || !canAutofocus()) return;
  setTimeout(() => el.isConnected && el.focus(), delay);
}

/** Opens a bottom sheet. build(close) returns its children. */
export function openSheet(build, { dismissable = true, label = t('Dialog') } = {}) {
  document.querySelectorAll('.toast').forEach((el) => el.remove());
  let closed = false;
  let onClose = null;
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': label, 'data-dismissable': dismissable ? '1' : '0' });
  const sheet = h('div', { class: 'sheet' });
  overlay.appendChild(sheet);
  const close = (v) => {
    if (closed) return;
    closed = true;
    overlay.remove();
    if (onClose) onClose(v);
  };
  if (dismissable)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(undefined);
    });
  // app.go() removes every overlay: whoever waits on this sheet hears "closed".
  overlay.addEventListener('campfire:dismiss', () => close(undefined));
  const render = () => {
    clear(sheet);
    sheet.appendChild(h('div', { class: 'grab' }));
    for (const c of [].concat(build(close, render))) if (c) sheet.appendChild(c);
  };
  render();
  document.body.appendChild(overlay);
  return {
    close,
    rerender: render,
    get closed() {
      return closed;
    },
    then(fn) {
      onClose = fn;
    },
  };
}

export function sheetPromise(build, opts) {
  return new Promise((resolve) => {
    const s = openSheet(build, opts);
    s.then(resolve);
  });
}

export function progressBar(fraction) {
  const bar = h('div');
  const el = h('div', { class: 'progress' + (fraction == null ? ' indeterminate' : '') }, bar);
  if (fraction != null) bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  return el;
}

/**
 * fn() whenever the page goes out of sight: the app switcher, another app or tab, the screen
 * turning off (visibilitychange to hidden), or the page being left (pagehide). The system takes a
 * picture of the last screen for the app switcher at that moment: a screen showing a secret hides
 * it here first. Returns the unsubscribe.
 */
export function onHidden(fn, doc = globalThis.document, win = globalThis.window) {
  const vis = () => doc.visibilityState === 'hidden' && fn();
  doc.addEventListener('visibilitychange', vis);
  if (win) win.addEventListener('pagehide', fn);
  return () => {
    doc.removeEventListener('visibilitychange', vis);
    if (win) win.removeEventListener('pagehide', fn);
  };
}

/** fn() whenever the page is in sight again (a screen that hid something shows it again). Returns the unsubscribe. */
export function onShown(fn, doc = globalThis.document) {
  const vis = () => doc.visibilityState === 'visible' && fn();
  doc.addEventListener('visibilitychange', vis);
  return () => doc.removeEventListener('visibilitychange', vis);
}

/**
 * Copies something that is not a secret (an address, a hash). It takes the place of a secret
 * copied before (copySecret): that one's wipe is cancelled, or it would empty this later (release
 * audit BM-5). nav, say: for the tests.
 */
export async function copyText(text, what = t('Copied'), { nav = globalThis.navigator, say = toast } = {}) {
  try {
    await nav.clipboard.writeText(text);
  } catch {
    say(t("Couldn't copy. Press and hold the text to copy it."));
    return false;
  }
  if (pendingSecret) {
    pendingSecret.stop();
    pendingSecret = null;
  }
  say(what);
  return true;
}

// ---------------------------------------------------------------- secrets on the clipboard
// A key or a code copied to the system clipboard stays there for any app to read (desktop
// programs, the keyboard's clipboard history, Windows' Win+V with its cloud sync, Universal
// Clipboard), and a page cannot mark it sensitive the way an Android app can. So a secret is taken
// out again after SECRET_CLIPBOARD_MS, and at the lock. Only what BEAM Campfire put there: where the
// browser lets the page read the clipboard without asking, it checks first; elsewhere the clipboard
// is emptied (the toast said it would be). A browser lets a page write only while it is in front
// (Chrome) or right after a tap (Safari, Firefox), so the clear also runs when the page is back in
// front and at the next tap. No copy of the secret is kept for that: only its SHA-256. The 12 words
// have no copy button at all. (Ported from the Firo wallet.)
export const SECRET_CLIPBOARD_MS = 60000;
let pendingSecret = null; // { hash, due, compare, stop }

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether a secret BEAM Campfire copied is still waiting to be cleared (for the tests). */
export const secretOnClipboard = () => Boolean(pendingSecret);

/**
 * Empties the clipboard if it still holds the secret BEAM Campfire copied (force: now, not only once
 * it is due: the lock). Resolves true once done or nothing is waiting.
 */
export function clearSecretClipboard({ force = false, nav = globalThis.navigator } = {}) {
  const p = pendingSecret;
  if (!p) return Promise.resolve(true);
  if (!force && Date.now() < p.due) return Promise.resolve(false);
  const done = () => {
    if (pendingSecret === p) {
      pendingSecret = null;
      p.stop();
    }
    return true;
  };
  // No read-back possible: write now, in this very turn, so a tap still counts as one. A lock out of
  // sight is refused (not in front): then the next return or tap clears it, without the wait.
  const write = () =>
    nav.clipboard.writeText('').then(done, () => {
      if (force) p.due = 0;
      return false;
    });
  if (!p.compare) return write();
  return nav.clipboard.readText().then(
    (now) => sha256Hex(now).then((h) => (h === p.hash ? write() : done())),
    () => write(),
  );
}

/**
 * Copies a secret: a toast that says the clipboard is emptied after a minute, then it is (see
 * above). app: also emptied when the wallet locks. say: the toast (the tests pass their own).
 */
export async function copySecret(text, what, { app = null, clearMs = SECRET_CLIPBOARD_MS, nav = globalThis.navigator, doc = globalThis.document, win = globalThis.window, say = toast } = {}) {
  try {
    await nav.clipboard.writeText(text);
  } catch {
    say(t("Couldn't copy. Press and hold the text to copy it."));
    return false;
  }
  if (pendingSecret) pendingSecret.stop();
  let compare = false;
  try {
    const st = nav.permissions && (await nav.permissions.query({ name: 'clipboard-read' }));
    compare = Boolean(st && st.state === 'granted' && nav.clipboard.readText);
  } catch {
    /* this browser cannot say: it is emptied without a check */
  }
  const p = { hash: await sha256Hex(text), due: Date.now() + clearMs, compare };
  const tryClear = () => clearSecretClipboard({ nav });
  const onVisible = () => doc.visibilityState === 'visible' && tryClear();
  const onLock = () => clearSecretClipboard({ force: true, nav });
  const timer = setTimeout(tryClear, clearMs + 50);
  doc.addEventListener('visibilitychange', onVisible);
  if (win) for (const ev of ['focus', 'pointerdown', 'keydown']) win.addEventListener(ev, tryClear, true);
  if (app && app.lockHooks) app.lockHooks.add(onLock);
  p.stop = () => {
    clearTimeout(timer);
    doc.removeEventListener('visibilitychange', onVisible);
    if (win) for (const ev of ['focus', 'pointerdown', 'keydown']) win.removeEventListener(ev, tryClear, true);
    if (app && app.lockHooks) app.lockHooks.delete(onLock);
  };
  pendingSecret = p;
  const mins = Math.max(1, Math.round(clearMs / 60000));
  // what: the caller's own label, already in the person's language ('Owner key copied').
  say(tn({ one: '{what}. BEAM Campfire empties the clipboard in {n} minute (clipboard history apps may keep it).', other: '{what}. BEAM Campfire empties the clipboard in {n} minutes (clipboard history apps may keep it).' }, mins, { what }), 6000);
  return true;
}

/**
 * An asset's round icon, the same on every screen (the desktop's BeamAssetLogo):
 * BEAM's logo, a verified asset's bundled icon, otherwise the BEAM desktop
 * wallet's generic icon for its id; a DEX liquidity token shows its pool's two
 * icons. Every picture ships with the app (img/assets) and is chosen by the id
 * and the DEX's pool list, never by anything the asset's creator wrote; the name
 * and #id are written next to it. A label without an icon (an Ethereum token)
 * gets its first letters on a colour picked for it.
 */
export function assetBadge(label, { size = '' } = {}) {
  if (Number(label.id) === 0) return h('span', { class: `asset-badge beam ${size}`.trim(), 'aria-hidden': 'true' }, h('img', { src: 'img/beam.svg', alt: '' }));
  if (label.pool) return pairBadge(label.pool, size, 0);
  if (label.icon) return coin(label.icon, Number(label.id), size);
  return letterBadge(label, size);
}

/** One icon as a coin: clipped to a circle, on a neutral disc while it loads (and for good when it is not round). */
function coin(src, id, size) {
  const inset = frameInset(src);
  const el = h('span', { class: `asset-badge asset-icon${inset == null ? '' : ' framed'}${size ? ` ${size}` : ''}`, 'aria-hidden': 'true', 'data-icon': src });
  if (inset) el.style.setProperty('--inset', `${inset * 100}%`);
  const img = h('img', { src, alt: '', decoding: 'async', draggable: 'false', class: src.endsWith('.svg') ? 'contain' : 'cover' });
  // A bundled picture that cannot be read falls back to the generic icon for the id, never an empty hole.
  img.addEventListener('error', () => {
    const fallback = id >= 0 ? genericIcon(id) : null;
    if (fallback && !img.src.endsWith(fallback)) {
      el.classList.remove('framed');
      el.dataset.icon = fallback;
      img.className = 'contain';
      img.src = fallback;
    } else img.remove();
  });
  el.append(img);
  return el;
}

/** A DEX pool's two icons in one badge: the first top left, the second bottom right with a gap around it. */
function pairBadge(pool, size, depth) {
  const side = (aid) => {
    const l = assetLabel(aid);
    return l.pool && depth < 3 ? pairBadge(l.pool, '', depth + 1) : coin(l.icon, aid, '');
  };
  return h('span', { class: `asset-badge pair${size ? ` ${size}` : ''}`, 'aria-hidden': 'true', 'data-pair': `${pool.aid1}/${pool.aid2}` }, side(pool.aid1), side(pool.aid2));
}

function letterBadge(label, size) {
  const el = h('span', { class: `asset-badge ${size}`.trim(), 'aria-hidden': 'true', text: badgeText(label) });
  if (/^#[0-9a-f]{6}$/i.test(label.color || '')) {
    el.style.setProperty('--badge', label.color);
    el.style.setProperty('--badge-ink', inkFor(label.color));
    el.classList.add('tinted');
  }
  return el;
}

/** Dark or white letters, whichever reads on the badge colour. */
export function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.36 ? '#1c1d22' : '#ffffff';
}
