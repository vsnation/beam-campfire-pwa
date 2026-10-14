// How the app looks: light or dark (like this device, the default, or always one of them), and its
// colours, Campfire red (the default) or BEAM's (issue #80). Settings -> Appearance.
//
// The colours are css/app.css: its dark palette applies under the system's dark mode unless
// <html data-theme="light">, and always under <html data-theme="dark">; <html data-skin="beam">
// swaps both palettes for BEAM's (docs/beam-brand-palette.json; the logo and the app icon stay Campfire's). Both choices
// are kept in this browser's localStorage (one per device, for every wallet), so they apply from the
// first screen, before any wallet is unlocked; with storage blocked the app simply follows the device
// in Campfire red.

export const THEMES = Object.freeze(['system', 'light', 'dark']);
export const THEME_WORDS = Object.freeze({ system: 'Like this device', light: 'Light', dark: 'Dark' });
export const SKINS = Object.freeze(['campfire', 'beam']);
export const SKIN_WORDS = Object.freeze({ campfire: 'Campfire red', beam: 'BEAM' });
const KEY = 'campfire-theme';
const SKIN_KEY = 'campfire-skin';
// The browser's bar colour: css/app.css --bg-top for each palette, the colour at the top of the page
// (Campfire's is its --bg; index.html carries Campfire's two, theme-boot.js the BEAM ones).
export const BARS = Object.freeze({
  campfire: Object.freeze({ light: '#fff1f1', dark: '#1c1d22' }),
  beam: Object.freeze({ light: '#e0ebf4', dark: '#04325a' }),
});

const read = (storage, key, allowed, fallback) => {
  try {
    const v = storage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
};

const write = (storage, key, value, isDefault) => {
  try {
    if (isDefault) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    /* this page only */
  }
};

/** The saved choice, 'system' when there is none or storage cannot be read. */
export function readTheme(storage = globalThis.localStorage) {
  return read(storage, KEY, THEMES, 'system');
}

/** The saved colours, 'campfire' when there is none or storage cannot be read. */
export function readSkin(storage = globalThis.localStorage) {
  return read(storage, SKIN_KEY, SKINS, 'campfire');
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

/** Saves and applies a choice (Settings). Saving can fail (storage blocked): it still applies now. */
export function setTheme(choice, { storage = globalThis.localStorage, doc = globalThis.document } = {}) {
  const c = THEMES.includes(choice) ? choice : 'system';
  write(storage, KEY, c, c === 'system');
  applyTheme(c, doc);
  return c;
}

/** Saves and applies the colours (Settings). Campfire red, the default, leaves nothing saved. */
export function setSkin(choice, { storage = globalThis.localStorage, doc = globalThis.document } = {}) {
  const c = SKINS.includes(choice) ? choice : 'campfire';
  write(storage, SKIN_KEY, c, c === 'campfire');
  applyLook({ skin: c }, doc);
  return c;
}
