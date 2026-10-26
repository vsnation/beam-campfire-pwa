// The tripwire's first watch (lib/loader.js watchLoader is the rest), loaded by index.html before
// anything else and before every module of the app.
//
// A loader (sw-<hash>.js) never changes its bytes under its name: the name is their hash. Other
// bytes there mean the web address serves code Beam PWA did not sign, and the browser installs
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

  var WARNING = "This app's web address is serving code Beam PWA did not sign. Don't enter your password here.";

  // Its words in each language the app ships, inside this signed file: nothing else of the page may
  // load once this stops it, and words kept in storage could be rewritten by any script that ever ran on
  // this address (release audit 0.2.17). Only the language name comes from storage, checked against
  // these. test/unit/i18n_tripwire.test.mjs keeps this table equal to the catalogs.
  var TEXTS = {
    "es": {
      "Stop: unsigned code": "Alto: código sin firmar",
      "This app's web address is serving code Beam PWA did not sign. Don't enter your password here.": "La dirección web de esta app está sirviendo código que Beam PWA no firmó. No ingreses tu contraseña aquí.",
      "Beam PWA stopped before opening.": "Beam PWA se detuvo antes de abrirse.",
      "Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.": "Tus monedas están en la blockchain de BEAM, no en esta app. Ábrelas en BEAM Campfire para escritorio o en otra billetera BEAM, con tus 12 palabras o con tu archivo wallet.db exportado y su contraseña.",
      "Close this app now. Do not reopen it from the same address or enter any password or words in it.": "Cierra esta app ahora. No la vuelvas a abrir desde la misma dirección ni ingreses en ella ninguna contraseña ni palabras."
    },
    "pt-BR": {
      "Stop: unsigned code": "Pare: código não assinado",
      "This app's web address is serving code Beam PWA did not sign. Don't enter your password here.": "O endereço web deste app está servindo código que o Beam PWA não assinou. Não digite sua senha aqui.",
      "Beam PWA stopped before opening.": "O Beam PWA parou antes de abrir.",
      "Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.": "Suas moedas estão na blockchain BEAM, não neste app. Abra-as no BEAM Campfire para desktop ou em outra carteira BEAM, com suas 12 palavras ou com o arquivo wallet.db exportado e a senha dele.",
      "Close this app now. Do not reopen it from the same address or enter any password or words in it.": "Feche este app agora. Não o abra de novo pelo mesmo endereço nem digite nenhuma senha ou palavra nele."
    },
    "fr": {
      "Stop: unsigned code": "Arrêt : code non signé",
      "This app's web address is serving code Beam PWA did not sign. Don't enter your password here.": "L'adresse web de cette app sert du code que Beam PWA n'a pas signé. Ne saisissez pas votre mot de passe ici.",
      "Beam PWA stopped before opening.": "Beam PWA s'est arrêtée avant de s'ouvrir.",
      "Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.": "Vos fonds sont sur la blockchain BEAM, pas dans cette app. Ouvrez-les dans BEAM Campfire pour ordinateur ou dans un autre portefeuille BEAM, avec vos 12 mots ou avec votre fichier wallet.db exporté et son mot de passe.",
      "Close this app now. Do not reopen it from the same address or enter any password or words in it.": "Fermez cette app maintenant. Ne la rouvrez pas depuis la même adresse et n'y saisissez aucun mot de passe ni aucun mot."
    },
    "de": {
      "Stop: unsigned code": "Stopp: unsignierter Code",
      "This app's web address is serving code Beam PWA did not sign. Don't enter your password here.": "Die Webadresse dieser App liefert Code, den Beam PWA nicht signiert hat. Gib hier nicht dein Passwort ein.",
      "Beam PWA stopped before opening.": "Beam PWA wurde vor dem Öffnen gestoppt.",
      "Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.": "Deine Coins sind auf der BEAM-Blockchain, nicht in dieser App. Öffne sie in BEAM Campfire für den Desktop oder in einem anderen BEAM-Wallet, mit deinen 12 Wörtern oder mit deiner exportierten wallet.db-Datei und ihrem Passwort.",
      "Close this app now. Do not reopen it from the same address or enter any password or words in it.": "Schließ diese App jetzt. Öffne sie nicht erneut unter derselben Adresse und gib darin kein Passwort und keine Wörter ein."
    },
    "tr": {
      "Stop: unsigned code": "Dur: imzasız kod",
      "This app's web address is serving code Beam PWA did not sign. Don't enter your password here.": "Bu uygulamanın web adresi, Beam PWA'nın imzalamadığı kod sunuyor. Şifrenizi buraya girmeyin.",
      "Beam PWA stopped before opening.": "Beam PWA açılmadan önce durdu.",
      "Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.": "Coinleriniz bu uygulamada değil, BEAM blokzincirinde. 12 kelimenizle ya da dışa aktardığınız wallet.db dosyası ve şifresiyle onları BEAM Campfire masaüstünde veya başka bir BEAM cüzdanında açın.",
      "Close this app now. Do not reopen it from the same address or enter any password or words in it.": "Bu uygulamayı şimdi kapatın. Aynı adresten yeniden açmayın ve içine hiçbir şifre veya kelime girmeyin."
    },
    "ru": {
      "Stop: unsigned code": "Стоп: неподписанный код",
      "This app's web address is serving code Beam PWA did not sign. Don't enter your password here.": "По веб-адресу этого приложения отдаётся код, который Beam PWA не подписывал. Не вводите здесь пароль.",
      "Beam PWA stopped before opening.": "Beam PWA остановился, не открывшись.",
      "Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.": "Ваши монеты — в блокчейне BEAM, а не в этом приложении. Откройте их в BEAM Campfire для компьютера или в другом кошельке BEAM — с помощью ваших 12 слов или экспортированного файла wallet.db и его пароля.",
      "Close this app now. Do not reopen it from the same address or enter any password or words in it.": "Закройте это приложение сейчас. Не открывайте его снова с того же адреса и не вводите в нём никаких паролей или слов."
    },
    "zh-Hans": {
      "Stop: unsigned code": "停止：未签名的代码",
      "This app's web address is serving code Beam PWA did not sign. Don't enter your password here.": "此应用的网址正在提供 Beam PWA 未签名的代码。不要在这里输入你的密码。",
      "Beam PWA stopped before opening.": "Beam PWA 在打开前已停止。",
      "Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.": "你的币在 BEAM 区块链上，而不在这个应用里。可以在 BEAM Campfire 桌面版或其他 BEAM 钱包中打开它们，使用你的 12 个助记词，或使用你导出的 wallet.db 文件及其密码。",
      "Close this app now. Do not reopen it from the same address or enter any password or words in it.": "请立即关闭此应用。不要从同一地址重新打开它，也不要在其中输入任何密码或助记词。"
    },
    "ja": {
      "Stop: unsigned code": "停止：署名のないコード",
      "This app's web address is serving code Beam PWA did not sign. Don't enter your password here.": "このアプリのウェブアドレスから、Beam PWAが署名していないコードが配信されています。ここにパスワードを入力しないでください。",
      "Beam PWA stopped before opening.": "Beam PWAは開く前に停止しました。",
      "Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.": "コインはこのアプリの中ではなく、BEAMブロックチェーン上にあります。BEAM Campfireデスクトップ版または他のBEAMウォレットで、12個の単語、またはエクスポートしたwallet.dbファイルとそのパスワードを使って開いてください。",
      "Close this app now. Do not reopen it from the same address or enter any password or words in it.": "今すぐこのアプリを閉じてください。同じアドレスから開き直したり、パスワードや単語を入力したりしないでください。"
    },
    "ko": {
      "Stop: unsigned code": "중지: 서명되지 않은 코드",
      "This app's web address is serving code Beam PWA did not sign. Don't enter your password here.": "이 앱의 웹 주소에서 Beam PWA가 서명하지 않은 코드를 제공하고 있어요. 여기에 비밀번호를 입력하지 마세요.",
      "Beam PWA stopped before opening.": "Beam PWA가 열리기 전에 멈췄어요.",
      "Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.": "코인은 이 앱이 아니라 BEAM 블록체인에 있어요. BEAM Campfire 데스크톱이나 다른 BEAM 지갑에서 12개 단어로, 또는 내보낸 wallet.db 파일과 그 비밀번호로 여세요.",
      "Close this app now. Do not reopen it from the same address or enter any password or words in it.": "지금 이 앱을 닫으세요. 같은 주소에서 다시 열거나, 여기에 비밀번호나 복구 단어를 입력하지 마세요."
    },
    "vi": {
      "Stop: unsigned code": "Dừng lại: mã chưa được ký",
      "This app's web address is serving code Beam PWA did not sign. Don't enter your password here.": "Địa chỉ web của ứng dụng này đang phục vụ mã mà Beam PWA không ký. Đừng nhập mật khẩu của bạn ở đây.",
      "Beam PWA stopped before opening.": "Beam PWA đã dừng trước khi mở.",
      "Your coins are on the BEAM blockchain, not in this app. Open them in BEAM Campfire desktop or another BEAM wallet, with your 12 words or with your exported wallet.db file and its password.": "Coin của bạn nằm trên blockchain BEAM, không phải trong ứng dụng này. Hãy mở chúng trong BEAM Campfire bản máy tính hoặc một ví BEAM khác, bằng 12 từ khôi phục của bạn hoặc bằng tệp wallet.db đã xuất cùng mật khẩu của nó.",
      "Close this app now. Do not reopen it from the same address or enter any password or words in it.": "Hãy đóng ứng dụng này ngay. Đừng mở lại nó từ cùng địa chỉ, và đừng nhập bất kỳ mật khẩu hay từ khôi phục nào vào đó."
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
    g.appendChild(document.createTextNode(' ' + tr('Beam PWA stopped before opening.')));
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
