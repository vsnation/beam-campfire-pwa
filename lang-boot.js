// Settings -> Appearance -> Language, before the first paint: <html lang> is the language the app will
// show (Chinese and Japanese characters are drawn by it, from the start screen on), and the splash in
// index.html says "Starting…" in it when its translation was kept from the last time (lib/i18n.js
// writes those few texts under campfire-lang-early). The rest is lib/i18n.js, which uses the same key
// and the same reading of the device's languages: test/unit/i18n.test.mjs checks they agree.
(function () {
  var LANGS = ['en', 'ru', 'zh-Hans', 'ja'];
  function device() {
    var list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']) || [];
    for (var i = 0; i < list.length; i++) {
      var base = String(list[i] || '').toLowerCase().split(/[-_]/)[0];
      if (base === 'en') return 'en';
      if (base === 'ru') return 'ru';
      if (base === 'zh') return 'zh-Hans';
      if (base === 'ja') return 'ja';
    }
    return 'en';
  }
  var lang = null;
  try {
    var c = localStorage.getItem('campfire-lang');
    if (LANGS.indexOf(c) >= 0) lang = c;
  } catch (e) {
    /* storage blocked: like this device */
  }
  if (!lang) lang = device();
  document.documentElement.setAttribute('lang', lang);
  if (lang === 'en') return;
  var early = null;
  try {
    early = JSON.parse(localStorage.getItem('campfire-lang-early') || 'null');
  } catch (e) {
    early = null;
  }
  if (!early || early.lang !== lang || !early.s || typeof early.s !== 'object') return;
  function tr(text) {
    var v = Object.prototype.hasOwnProperty.call(early.s, text) ? early.s[text] : null;
    return typeof v === 'string' && v ? v : text;
  }
  // Text only (textContent, an attribute): nothing kept here can become markup.
  document.addEventListener('DOMContentLoaded', function () {
    var p = document.querySelector('#app .splash .hero p');
    if (p) p.textContent = tr('Starting BEAM Campfire…');
    var bar = document.querySelector('#app .splash [role="progressbar"]');
    if (bar) bar.setAttribute('aria-label', tr('Starting'));
  });
})();
