// Settings -> Appearance -> Language, before the first paint: <html lang> is the language the app will
// show (Chinese and Japanese characters are drawn by it, from the start screen on), and the splash in
// index.html says "Starting…" in it. Its two texts per language live in this signed file (equal to the
// catalogs: test/unit/i18n.test.mjs), never in storage (release audit 0.2.17): only the language choice is
// read from there. The rest is lib/i18n.js, which uses the same key and the same reading of the device's
// languages: test/unit/i18n.test.mjs checks they agree.
(function () {
  var LANGS = ['en', 'es', 'pt-BR', 'fr', 'de', 'tr', 'ru', 'zh-Hans', 'ja', 'ko', 'vi'];
  // A device language's first part -> the app's language (lib/i18n.js DEVICE_BASES).
  var BASES = { en: 'en', es: 'es', pt: 'pt-BR', fr: 'fr', de: 'de', tr: 'tr', ru: 'ru', zh: 'zh-Hans', ja: 'ja', ko: 'ko', vi: 'vi' };
  function device() {
    var list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']) || [];
    for (var i = 0; i < list.length; i++) {
      var base = String(list[i] || '').toLowerCase().split(/[-_]/)[0];
      if (Object.prototype.hasOwnProperty.call(BASES, base)) return BASES[base];
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
  var TEXTS = {
    "es": {
      "Starting Beam PWA…": "Iniciando Beam PWA…",
      "Starting": "Iniciando"
    },
    "pt-BR": {
      "Starting Beam PWA…": "Iniciando o Beam PWA…",
      "Starting": "Iniciando"
    },
    "fr": {
      "Starting Beam PWA…": "Démarrage de Beam PWA…",
      "Starting": "Démarrage"
    },
    "de": {
      "Starting Beam PWA…": "Beam PWA startet…",
      "Starting": "Startet"
    },
    "tr": {
      "Starting Beam PWA…": "Beam PWA başlatılıyor…",
      "Starting": "Başlatılıyor"
    },
    "ru": {
      "Starting Beam PWA…": "Запуск Beam PWA…",
      "Starting": "Запуск"
    },
    "zh-Hans": {
      "Starting Beam PWA…": "正在启动 Beam PWA…",
      "Starting": "正在启动"
    },
    "ja": {
      "Starting Beam PWA…": "Beam PWAを起動しています…",
      "Starting": "起動中"
    },
    "ko": {
      "Starting Beam PWA…": "Beam PWA 시작 중…",
      "Starting": "시작 중"
    },
    "vi": {
      "Starting Beam PWA…": "Đang khởi động Beam PWA…",
      "Starting": "Đang khởi động"
    }
  };
  var words = TEXTS[lang];
  if (!words) return;
  function tr(text) {
    return Object.prototype.hasOwnProperty.call(words, text) ? words[text] : text;
  }
  // Text only (textContent, an attribute): nothing kept here can become markup.
  document.addEventListener('DOMContentLoaded', function () {
    var p = document.querySelector('#app .splash .hero p');
    if (p) p.textContent = tr('Starting Beam PWA…');
    var bar = document.querySelector('#app .splash [role="progressbar"]');
    if (bar) bar.setAttribute('aria-label', tr('Starting'));
  });
})();
