// The tripwire's first watch (lib/loader.js watchLoader is the rest), loaded by index.html before
// anything else and before every module of the app.
//
// A loader (sw-<hash>.js) never changes its bytes under its name: the name is their hash. Other
// bytes there mean the web address serves code BEAM Campfire did not sign, and the browser installs
// them without asking anyone. Such a worker can take over a page that is still starting; every
// module the page has not loaded yet then comes from it, so the app's own watch, which starts
// after its last module, would never run. This script runs first and records, from the start:
// the loader that served this page, every change of the loader controlling it, and every new
// loader installing (window.__campfireLoaderWatch; watchLoader replays it and follows it).
//
// One case needs no knowledge of this release: the loader at the very address that served this
// page installs again or takes over. If that happens before the app has started its own watch,
// this script stops the page at once and says why, in plain DOM (nothing else of the page may
// load: it would come from that code). Once the app watches, the app decides and shows its own
// screen (screens/problem.js, the same words). Best effort: a takeover that lands before this file
// was fetched serves this file too.
(function () {
  'use strict';
  var sw = navigator.serviceWorker;
  if (!sw || window.__campfireLoaderWatch) return;
  var initial = sw.controller ? sw.controller.scriptURL : null;
  var events = [];
  var subscribers = [];
  var stopped = false;

  var WARNING = "This app's web address is serving code BEAM Campfire did not sign. Don't enter your password here.";

  // Its words in each language the app ships, inside this signed file: nothing else of the page may
  // load once this stops it, and words kept in storage could be rewritten by any script that ever ran on
  // this address (release audit 0.2.17). Only the language name comes from storage, checked against
  // these. test/unit/i18n_tripwire.test.mjs keeps this table equal to the catalogs.
  var TEXTS = {
    "ru": {
      "Stop: unsigned code": "Стоп: неподписанный код",
      "This app's web address is serving code BEAM Campfire did not sign. Don't enter your password here.": "По веб-адресу этого приложения отдаётся код, который BEAM Campfire не подписывал. Не вводите здесь пароль.",
      "BEAM Campfire stopped before opening.": "BEAM Campfire остановился, не открывшись.",
      "Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.": "Ваши монеты — в блокчейне BEAM, а не в этом приложении. Откройте их в BEAM Campfire для компьютера или в другом кошельке BEAM — с помощью ваших 12 слов или экспортированного файла wallet.db и его пароля.",
      "Close this app now. Do not reopen it from the same address or enter any password or words in it.": "Закройте это приложение сейчас. Не открывайте его снова с того же адреса и не вводите в нём никаких паролей или слов."
    },
    "zh-Hans": {
      "Stop: unsigned code": "停止：未签名的代码",
      "This app's web address is serving code BEAM Campfire did not sign. Don't enter your password here.": "此应用的网址正在提供 BEAM Campfire 未签名的代码。不要在这里输入你的密码。",
      "BEAM Campfire stopped before opening.": "BEAM Campfire 在打开前已停止。",
      "Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.": "你的币在 BEAM 区块链上，而不在这个应用里。可以在 BEAM Campfire 桌面版或其他 BEAM 钱包中打开它们，使用你的 12 个助记词，或使用你导出的 wallet.db 文件及其密码。",
      "Close this app now. Do not reopen it from the same address or enter any password or words in it.": "请立即关闭此应用。不要从同一地址重新打开它，也不要在其中输入任何密码或助记词。"
    },
    "ja": {
      "Stop: unsigned code": "停止：署名のないコード",
      "This app's web address is serving code BEAM Campfire did not sign. Don't enter your password here.": "このアプリのウェブアドレスから、BEAM Campfireが署名していないコードが配信されています。ここにパスワードを入力しないでください。",
      "BEAM Campfire stopped before opening.": "BEAM Campfireは開く前に停止しました。",
      "Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.": "コインはこのアプリの中ではなく、BEAMブロックチェーン上にあります。BEAM Campfireデスクトップ版または他のBEAMウォレットで、12個の単語、またはエクスポートしたwallet.dbファイルとそのパスワードを使って開いてください。",
      "Close this app now. Do not reopen it from the same address or enter any password or words in it.": "今すぐこのアプリを閉じてください。同じアドレスから開き直したり、パスワードや単語を入力したりしないでください。"
    }
  };
  var lang = null;
  try {
    var kept = JSON.parse(window.localStorage.getItem('campfire-lang-early') || 'null');
    lang = kept && typeof kept.lang === 'string' && Object.prototype.hasOwnProperty.call(TEXTS, kept.lang) ? kept.lang : null;
  } catch (e) {
    lang = null; // storage blocked, or none kept: English
  }
  var words = lang ? TEXTS[lang] : null;
  function tr(text) {
    var v = words && Object.prototype.hasOwnProperty.call(words, text) ? words[text] : null;
    return typeof v === 'string' && v ? v : text;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function stopPage() {
    if (stopped) return;
    stopped = true;
    try {
      window.stop(); // no further file of this page: it would come from the new code
    } catch (e) {
      /* already loaded */
    }
    var body = document.body || document.documentElement.appendChild(document.createElement('body'));
    var main = el('main', 'screen tripwire');
    main.setAttribute('data-testid', 'tripwire-early');
    if (lang) main.setAttribute('lang', lang);
    var content = el('div', 'content');
    content.appendChild(el('h2', 'title', tr('Stop: unsigned code')));
    var n = el('div', 'notice error');
    n.setAttribute('role', 'alert');
    var g = el('div', 'grow');
    g.appendChild(el('strong', null, tr(WARNING)));
    g.appendChild(document.createTextNode(' ' + tr('BEAM Campfire stopped before opening.')));
    n.appendChild(g);
    content.appendChild(n);
    content.appendChild(el('p', 'lead', tr('Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.')));
    content.appendChild(el('p', 'small', tr('Close this app now. Do not reopen it from the same address or enter any password or words in it.')));
    main.appendChild(content);
    while (body.firstChild) body.removeChild(body.firstChild);
    body.appendChild(main);
  }

  function emit(type, url) {
    var ev = { type: type, url: url || null, at: Date.now() };
    events.push(ev);
    // Not yet watched by the app: an unmistakable takeover stops the page here.
    if (!subscribers.length && initial && ev.url === initial) stopPage();
    for (var i = 0; i < subscribers.length; i++) {
      try {
        subscribers[i](ev);
      } catch (e) {
        /* one watcher's error is not this one's */
      }
    }
  }

  sw.addEventListener('controllerchange', function () {
    emit('controllerchange', sw.controller ? sw.controller.scriptURL : null);
  });
  sw.getRegistration().then(
    function (reg) {
      if (!reg) return;
      if (reg.installing) emit('installing', reg.installing.scriptURL);
      if (reg.waiting) emit('waiting', reg.waiting.scriptURL);
      reg.addEventListener('updatefound', function () {
        if (reg.installing) emit('updatefound', reg.installing.scriptURL);
      });
    },
    function () {},
  );

  Object.defineProperty(window, '__campfireLoaderWatch', {
    value: Object.freeze({
      // The loader that served this page (null: the page came from the network).
      initial: initial,
      // Whether this script already stopped the page.
      stopped: function () {
        return stopped;
      },
      // fn(event) for every event so far, then for each new one: {type, url, at}.
      subscribe: function (fn) {
        for (var i = 0; i < events.length; i++) fn(events[i]);
        subscribers.push(fn);
      },
    }),
  });
})();
