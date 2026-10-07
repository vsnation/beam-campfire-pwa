// Shared screen furniture: top bar, tab bar, sheets, toasts.
import { h, clear } from './dom.js';
import { icon } from './icons.js';

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
