// How the app looks: its colours, BEAM's (the default, owner 2026-10-26) or Campfire red (issue #80),
// and light or dark: like this device, or always one of them. Settings -> Appearance.
//
// The colours are css/app.css: its dark palette applies under the system's dark mode unless
// <html data-theme="light">, and always under <html data-theme="dark">; <html data-skin="beam">
// swaps both palettes for BEAM's (docs/beam-brand-palette.json; the flame follows, lib/logo.js). Both choices
// are kept in this browser's localStorage (one per device, for every wallet), so they apply from the
// first screen, before any wallet is unlocked. A theme nobody picked follows the colours: BEAM is dark
// (owner, 2026-10-14), Campfire red is like this device. With storage blocked the app is BEAM, dark.
import { tk } from './i18n.js';

export const THEMES = Object.freeze(['system', 'light', 'dark']);
// Settings shows them with t(): they are read before any language is known.
export const THEME_WORDS = Object.freeze({ system: tk('Like this device'), light: tk('Light'), dark: tk('Dark') });
export const SKINS = Object.freeze(['beam', 'campfire']);
// 'BEAM' is the brand's own name: the same in every language.
export const SKIN_WORDS = Object.freeze({ beam: 'BEAM', campfire: tk('Campfire red') });
const KEY = 'campfire-theme';
const SKIN_KEY = 'campfire-skin';
// Before BEAM was the default (0.2.19 and older), choosing BEAM saved Dark with this flag set, so going
// back to Campfire red could undo it. That pair now reads as "no theme picked".
const AUTO_DARK_KEY = 'campfire-theme-auto';
// The browser's bar colour: css/app.css --bg-top for each palette, the colour at the top of the page
// (Campfire's is its --bg; theme-boot.js carries both, index.html BEAM's dark one).
export const BARS = Object.freeze({
  campfire: Object.freeze({ light: '#fff1f1', dark: '#1c1d22' }),
  beam: Object.freeze({ light: '#e0ebf4', dark: '#04325a' }),
});

/** The theme of colours nobody picked a theme for. */
export const defaultTheme = (skin) => (skin === 'campfire' ? 'system' : 'dark');

const get = (storage, key) => {
  try {
    return storage.getItem(key);
  } catch {
    return undefined; // unreadable
  }
};

const write = (storage, key, value) => {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    /* this page only */
  }
};

/** The saved colours: BEAM unless Campfire red was picked, or when storage cannot be read. */
export function readSkin(storage = globalThis.localStorage) {
  return get(storage, SKIN_KEY) === 'campfire' ? 'campfire' : 'beam';
}

/** The theme picked on purpose, or null when none was (or storage cannot be read). */
function pickedTheme(storage) {
  const v = get(storage, KEY);
  if (!THEMES.includes(v)) return null;
  if (v === 'dark' && get(storage, AUTO_DARK_KEY) === '1') return null;
  return v;
}

/** The theme on: the one picked, else the colours' own (BEAM: dark). */
export function readTheme(storage = globalThis.localStorage) {
  return pickedTheme(storage) ?? defaultTheme(readSkin(storage));
}

const themeOn = (doc) => (doc.documentElement.dataset.theme === 'light' || doc.documentElement.dataset.theme === 'dark' ? doc.documentElement.dataset.theme : 'system');
const skinOn = (doc) => (doc.documentElement.dataset.skin === 'beam' ? 'beam' : 'campfire');

/**
 * Puts a theme and colours on the page: the palette attributes, the native controls' scheme, the
 * browser bar's colour. Either may be left out to keep what the page has.
 */
export function applyLook({ theme = null, skin = null } = {}, doc = globalThis.document) {
  if (!doc || !doc.documentElement) return;
  const t = THEMES.includes(theme) ? theme : themeOn(doc);
  const k = SKINS.includes(skin) ? skin : skinOn(doc);
  const forced = t === 'light' || t === 'dark' ? t : null;
  if (forced) doc.documentElement.dataset.theme = forced;
  else delete doc.documentElement.dataset.theme;
  if (k === 'beam') doc.documentElement.dataset.skin = 'beam';
  else delete doc.documentElement.dataset.skin;
  for (const m of doc.querySelectorAll('meta[name="theme-color"]')) {
    const own = /dark/.test(m.getAttribute('media') || '') ? 'dark' : 'light';
    m.setAttribute('content', BARS[k][forced || own]);
  }
  const cs = doc.querySelector('meta[name="color-scheme"]');
  if (cs) cs.setAttribute('content', forced || 'light dark');
}

/** Light or dark on the page (the colours stay as they are). */
export function applyTheme(choice, doc = globalThis.document) {
  applyLook({ theme: THEMES.includes(choice) ? choice : 'system' }, doc);
}

// With storage blocked nothing is kept: whether a theme was picked on this page stands in for it.
let pickedOnPage = false;

/** Saves and applies a theme picked on purpose (Settings): kept whatever colours come later. */
export function setTheme(choice, { storage = globalThis.localStorage, doc = globalThis.document } = {}) {
  const c = THEMES.includes(choice) ? choice : 'system';
  write(storage, KEY, c);
  write(storage, AUTO_DARK_KEY, null);
  pickedOnPage = true;
  applyTheme(c, doc);
  return c;
}

/** Saves and applies the colours. BEAM, the default, leaves nothing saved. */
export function setSkin(choice, { storage = globalThis.localStorage, doc = globalThis.document } = {}) {
  const c = SKINS.includes(choice) ? choice : 'beam';
  write(storage, SKIN_KEY, c === 'beam' ? null : c);
  applyLook({ skin: c }, doc);
  return c;
}

/**
 * Settings' Colours row. A theme picked on purpose is never changed; otherwise the theme follows the
 * colours (BEAM dark, Campfire red like this device). Returns both, so the Theme row can show what is on.
 */
export function pickSkin(choice, { storage = globalThis.localStorage, doc = globalThis.document } = {}) {
  const skin = setSkin(choice, { storage, doc });
  const readable = get(storage, KEY) !== undefined;
  const picked = readable ? pickedTheme(storage) : pickedOnPage ? themeOn(doc) : null;
  if (picked) return { skin, theme: picked };
  write(storage, KEY, null);
  write(storage, AUTO_DARK_KEY, null);
  const theme = defaultTheme(skin);
  applyLook({ theme }, doc);
  return { skin, theme };
}

/** Back to how a new install looks (every wallet deleted): nothing saved, BEAM, dark. */
export function resetLook({ storage = globalThis.localStorage, doc = globalThis.document } = {}) {
  for (const k of [KEY, SKIN_KEY, AUTO_DARK_KEY]) write(storage, k, null);
  pickedOnPage = false;
  applyLook({ theme: defaultTheme('beam'), skin: 'beam' }, doc);
}
