// Shared screen furniture: top bar, tab bar, sheets, toasts.
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { badgeText } from './meta.js';

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

/** Opens a bottom sheet. build(close) returns its children. */
export function openSheet(build, { dismissable = true, label = 'Dialog' } = {}) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  let closed = false;
  let onClose = null;
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': label });
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
 * An asset's round badge: BEAM's logo for BEAM, otherwise its first letters on
 * a colour picked by its id (never by the asset's own metadata).
 */
export function assetBadge(label, { size = '' } = {}) {
  if (Number(label.id) === 0) return h('span', { class: `asset-badge beam ${size}`.trim(), 'aria-hidden': 'true' }, h('img', { src: 'img/beam.svg', alt: '' }));
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
