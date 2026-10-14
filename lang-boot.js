// Settings -> Appearance -> Language, before the first paint: <html lang> is the language the app will
// show (Chinese and Japanese characters are drawn by it, from the start screen on), and the splash in
// index.html says "Starting…" in it. Its two texts per language live in this signed file (equal to the
// catalogs: test/unit/i18n.test.mjs), never in storage (release audit 0.2.17): only the language choice is
// read from there. The rest is lib/i18n.js, which uses the same key and the same reading of the device's
// languages: test/unit/i18n.test.mjs checks they agree.
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
  var TEXTS = {"ru": {"Starting BEAM Campfire…": "Запуск BEAM Campfire…", "Starting": "Запуск"}, "zh-Hans": {"Starting BEAM Campfire…": "正在启动 BEAM Campfire…", "Starting": "正在启动"}, "ja": {"Starting BEAM Campfire…": "BEAM Campfireを起動しています…", "Starting": "起動中"}};
  var words = TEXTS[lang];
  if (!words) return;
  function tr(text) {
    return Object.prototype.hasOwnProperty.call(words, text) ? words[text] : text;
  }
  // Text only (textContent, an attribute): nothing kept here can become markup.
  document.addEventListener('DOMContentLoaded', function () {
    var p = document.querySelector('#app .splash .hero p');
    if (p) p.textContent = tr('Starting BEAM Campfire…');
    var bar = document.querySelector('#app .splash [role="progressbar"]');
    if (bar) bar.setAttribute('aria-label', tr('Starting'));
  });
})();
