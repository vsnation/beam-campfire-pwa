// Shared screen furniture: top bar, tab bar, sheets, toasts.
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { badgeText, assetLabel, frameInset, genericIcon } from './meta.js';

export function topbar({ title, back, brand = false, right = null }) {
  return h(
    'header',
    { class: 'topbar' },
    back ? h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: back }, icon('back')) : null,
    brand ? h('div', { class: 'brand' }, h('img', { src: 'img/logo.svg', alt: '' }), h('span', { text: 'BEAM Campfire' })) : h('h1', { text: title || '' }),
    right,
  );
}

export function tabbar(app, active) {
  const tab = (name, label, ico) =>
    h('button', { class: `tab${active === name ? ' on' : ''}`, 'aria-current': active === name ? 'page' : null, onclick: () => app.go(name) }, icon(ico), h('span', { text: label }));
  return h('nav', { class: 'tabbar', 'aria-label': 'Main' }, h('div', { class: 'inner' }, tab('home', 'Wallet', 'home'), tab('activity', 'Activity', 'activity'), tab('settings', 'Settings', 'settings')));
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
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast', role: 'status', text: message });
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

/**
 * Whether the app may put the caret in a field by itself: only on a computer (a mouse and a
 * keyboard). On a phone the browser focuses the field without opening the keyboard (iOS opens it
 * only for a tap), and a tap on that already-focused field then offers Paste instead of the
 * keyboard: the person could not type their password. There they tap the field themselves.
 */
export function canAutofocus(win = globalThis) {
  return typeof win.matchMedia === 'function' && win.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/** Focuses `el` once it is on screen, on a computer only (canAutofocus). */
export function focusSoon(el, delay = 50) {
  if (!el || !canAutofocus()) return;
  setTimeout(() => el.isConnected && el.focus(), delay);
}

/** Opens a bottom sheet. build(close) returns its children. */
export function openSheet(build, { dismissable = true, label = 'Dialog' } = {}) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
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

export async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
    return true;
  } catch {
    toast("Couldn't copy. Press and hold the text to copy it.");
    return false;
  }
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
