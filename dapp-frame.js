/* BEAM Campfire dApp frame bootstrap.
 *
 * The service worker serves this file, inlined under a nonce, as the whole
 * document of a dApp frame (lib/dapps/frame_policy.js). The frame is
 * sandboxed without allow-same-origin, so this code and the dApp's run in an
 * opaque origin: no access to the wallet's storage, cookies, service worker,
 * engine or DOM, and the frame's own CSP blocks every request to the
 * wallet's origin and to any host the dApp was not granted.
 *
 * It waits for the wallet to hand over a MessagePort (once, from the parent
 * window only), receives the dApp's verified files over it, and then:
 *   - turns every file into a blob: URL, rewriting the start page's
 *     script/link/img references and the url()s in CSS to them, and maps
 *     the dApp's own relative fetch/XHR/src/href requests (it fetches its
 *     app shader, e.g. ./app.wasm) to its files;
 *   - provides the wallet shapes BEAM dApps look for (the same three as the
 *     desktop's bridge): mobile window.BEAM, the Qt WebChannel stand-in, and
 *     the web-extension handshake (create_beam_api -> window.BeamApi). The
 *     shape a dApp picks follows navigator.userAgent, which the wallet sets;
 *   - gives the dApp in-memory localStorage/sessionStorage (an opaque origin
 *     has none) and sends https links it opens to the wallet, which asks;
 *   - writes the dApp's start page into this document.
 * Every request from the dApp leaves through the port as a JSON-RPC string.
 * Nothing here can execute a wallet call: the wallet checks every request.
 */
(function () {
  'use strict';
  var parentWin = window.parent;
  var port = null;
  var started = false;
  // This document's script nonce: the import map written below needs it.
  var NONCE = (document.currentScript && document.currentScript.nonce) || '';

  var N = {
    URL: URL,
    fetch: window.fetch,
    xhrOpen: XMLHttpRequest.prototype.open,
    setAttribute: Element.prototype.setAttribute,
    setAttributeNS: Element.prototype.setAttributeNS,
    postMessage: window.postMessage,
    addEventListener: window.addEventListener,
    createObjectURL: URL.createObjectURL,
  };

  function send(msg) {
    if (port) port.postMessage(msg);
  }

  N.addEventListener.call(window, 'message', function onPort(e) {
    if (port || e.source !== parentWin || !e.data || e.data.t !== 'campfire-port' || !e.ports || e.ports.length !== 1) return;
    port = e.ports[0];
    port.onmessage = onWallet;
    send({ t: 'ready' });
  });

  function onWallet(e) {
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'start' && !started) {
      started = true;
      try {
        start(m);
      } catch (err) {
        send({ t: 'failed', message: String((err && err.message) || err) });
      }
    } else if (m.t === 'deliver' && typeof m.json === 'string') deliver(m.json);
    else if (m.t === 'handshake') handshake(m.ok === true);
    else if (m.t === 'ping') send({ t: 'pong', n: m.n });
  }

  // ------------------------------------------------------------ bridge
  var callback = null;
  var qtListeners = [];
  function request(json) {
    send({ t: 'rpc', json: typeof json === 'string' ? json : JSON.stringify(json) });
  }
  function deliver(json) {
    // Each Qt listener gets the result even when another one throws (as Qt signals do).
    if (qtListeners.length)
      qtListeners.slice().forEach(function (f) {
        try {
          f(json);
        } catch (err) {
          setTimeout(function () { throw err; }, 0);
        }
      });
    else if (callback) callback(json);
    else document.dispatchEvent(new CustomEvent('onCallWalletApiResult', { detail: json }));
  }
  function handshake(ok) {
    if (ok) {
      window.BeamApi = {
        callWalletApi: function (id, method, params) {
          request({ jsonrpc: '2.0', id: id, method: method, params: params });
        },
        callWalletApiResult: function (f) {
          callback = f;
          return Promise.resolve();
        },
      };
    }
    window.postMessage(ok ? 'apiInjected' : 'rejected', '*');
  }
  function installBridge(style) {
    // Mobile shape.
    window.BEAM = {
      style: style,
      callWalletApi: request,
      callWalletApiResult: function (f) { callback = f; },
    };
    // Qt shape.
    var qtApi = {
      callWalletApi: request,
      callWalletApiResult: {
        connect: function (f) { if (qtListeners.indexOf(f) < 0) qtListeners.push(f); },
        disconnect: function (f) { var i = qtListeners.indexOf(f); if (i >= 0) qtListeners.splice(i, 1); },
      },
    };
    if (!window.qt) window.qt = { webChannelTransport: {} };
    window.QWebChannel = function (transport, init) {
      var channel = this;
      channel.objects = { BEAM: { style: style, api: qtApi } };
      setTimeout(function () { if (typeof init === 'function') init(channel); }, 0);
    };
  }
  function listenForHandshake() {
    // Web-extension shape. Re-added after document.open(), which drops window listeners.
    N.addEventListener.call(window, 'message', function (ev) {
      var d = ev.data;
      if (ev.source !== window || !d || typeof d !== 'object' || d.type !== 'create_beam_api') return;
      send({
        t: 'hello',
        apiver: typeof d.apiver === 'string' ? d.apiver : null,
        apivermin: typeof d.apivermin === 'string' ? d.apivermin : null,
        appname: typeof d.appname === 'string' ? d.appname : null,
      });
    });
  }

  // ------------------------------------------------------------ files
  var files = Object.create(null); // path -> {type, bytes}
  var blobs = Object.create(null); // path -> blob URL
  var virtualOf = Object.create(null); // blob URL -> virtual URL
  var ROOT = '';
  var QRC = 'qrc:///qtwebchannel/qwebchannel.js';
  var emptyScript = null;

  function pathOf(url) {
    // The package path an absolute or relative URL names, or null.
    if (typeof url !== 'string' || url === '' || url.charAt(0) === '#' || /^(blob|data|about|javascript|mailto):/i.test(url)) return null;
    var abs;
    try {
      abs = new URL(url, document.baseURI).href;
    } catch (e) {
      return null;
    }
    if (abs.indexOf(ROOT) !== 0) return null;
    var rest = abs.slice(ROOT.length).split('#')[0].split('?')[0];
    try {
      rest = decodeURIComponent(rest);
    } catch (e) {
      return null;
    }
    return files[rest] ? rest : null;
  }

  function blobFor(path) {
    if (blobs[path]) return blobs[path];
    var f = files[path];
    var body = f.bytes;
    if (/\.css$/i.test(path)) body = rewriteCss(new TextDecoder().decode(f.bytes), ROOT + path);
    var u = N.createObjectURL.call(URL, new Blob([body], { type: f.type }));
    blobs[path] = u;
    virtualOf[u] = ROOT + path.split('/').map(encodeURIComponent).join('/');
    return u;
  }

  function mapUrl(url, base) {
    if (url === QRC) return emptyScript;
    var p;
    if (base) {
      try {
        p = pathOf(new URL(url, base).href);
      } catch (e) {
        p = null;
      }
    } else p = pathOf(url);
    return p ? blobFor(p) : url;
  }

  function rewriteCss(text, base) {
    return text
      .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (all, q, u) {
        var m = mapUrl(u.trim(), base);
        return m === u.trim() ? all : 'url("' + m + '")';
      })
      .replace(/@import\s+(['"])([^'"]+)\1/g, function (all, q, u) {
        var m = mapUrl(u, base);
        return m === u ? all : '@import "' + m + '"';
      });
  }

  function rewriteSrcset(v) {
    return String(v)
      .split(',')
      .map(function (part) {
        var bits = part.trim().split(/\s+/);
        if (bits[0]) bits[0] = mapUrl(bits[0]);
        return bits.join(' ');
      })
      .join(', ');
  }

  var URL_ATTRS = { src: 1, href: 1, poster: 1, 'xlink:href': 1 };
  var NAVIGATES = { A: 1, AREA: 1 };
  function rewriteAttr(el, name, value) {
    var n = String(name).toLowerCase();
    if (value == null) return value;
    // A link's href is where it goes, not something to load: links are handled on click.
    if (n === 'href' && el && NAVIGATES[el.tagName]) return value;
    if (URL_ATTRS[n]) return mapUrl(String(value));
    if (n === 'srcset') return rewriteSrcset(value);
    if (n === 'style') return rewriteCss(String(value));
    return value;
  }

  // ES modules (dao-core-app): a module's relative imports resolve against
  // its own address, which for a blob: is not a path. Each module's relative
  // specifiers are rewritten to the module's package address, and an import
  // map sends those addresses to the modules' blob: URLs.
  var IMPORT_RES = [
    /(\b(?:import|export)\s[^'"`;]*?\bfrom\s*)(['"])([^'"]+)\2/g,
    /(\bimport\s*)(['"])([^'"]+)\2/g,
    /(\bimport\(\s*)(['"])([^'"]+)\2/g,
  ];
  var moduleBlobs = Object.create(null);
  var importMap = Object.create(null);
  function virtualUrl(path) {
    return ROOT + path.split('/').map(encodeURIComponent).join('/');
  }
  function moduleBlob(path) {
    if (moduleBlobs[path]) return moduleBlobs[path];
    moduleBlobs[path] = 'pending';
    var base = virtualUrl(path);
    var deps = [];
    var text = new TextDecoder().decode(files[path].bytes);
    IMPORT_RES.forEach(function (re) {
      text = text.replace(re, function (all, head, q, spec) {
        if (!/^(\.{1,2}\/|\/)/.test(spec)) return all;
        var abs;
        try {
          abs = new URL(spec, base).href;
        } catch (e) {
          return all;
        }
        var dep = pathOf(abs);
        if (!dep) return all;
        deps.push(dep);
        return head + q + virtualUrl(dep) + q;
      });
    });
    var u = N.createObjectURL.call(URL, new Blob([text], { type: 'text/javascript' }));
    moduleBlobs[path] = u;
    importMap[virtualUrl(path)] = u;
    deps.forEach(function (d) {
      if (!moduleBlobs[d]) moduleBlob(d);
    });
    return u;
  }

  // ------------------------------------------------------------ patches
  function patchProperty(proto, prop, attr) {
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set || !d.configurable) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: function () {
        var v = d.get.call(this);
        // webpack derives its public path from document.currentScript.src.
        if (attr === 'script' && virtualOf[v]) return virtualOf[v];
        return v;
      },
      set: function (v) {
        d.set.call(this, mapUrl(String(v)));
      },
    });
  }

  function installPatches(shape, ua) {
    if (ua) {
      try {
        Object.defineProperty(Navigator.prototype, 'userAgent', { configurable: true, get: function () { return ua; } });
      } catch (e) {
        /* keeps the real one */
      }
    }
    // An opaque origin's window.origin is "null", which postMessage rejects as a target.
    window.postMessage = function (msg, target, transfer) {
      if (target && typeof target === 'object') {
        if (target.targetOrigin === 'null') target = Object.assign({}, target, { targetOrigin: '*' });
        return N.postMessage.call(window, msg, target);
      }
      if (target === 'null' || target === undefined) target = '*';
      return transfer ? N.postMessage.call(window, msg, target, transfer) : N.postMessage.call(window, msg, target);
    };
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      var p = pathOf(url);
      if (p) return Promise.resolve(new Response(files[p].bytes.slice(0), { status: 200, headers: { 'Content-Type': files[p].type } }));
      return N.fetch.apply(window, arguments);
    };
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = mapUrl(String(url));
      return N.xhrOpen.apply(this, args);
    };
    Element.prototype.setAttribute = function (name, value) {
      return N.setAttribute.call(this, name, rewriteAttr(this, name, value));
    };
    Element.prototype.setAttributeNS = function (ns, name, value) {
      return N.setAttributeNS.call(this, ns, name, rewriteAttr(this, name, value));
    };
    patchProperty(HTMLScriptElement.prototype, 'src', 'script');
    patchProperty(HTMLImageElement.prototype, 'src');
    patchProperty(HTMLLinkElement.prototype, 'href');
    patchProperty(HTMLSourceElement.prototype, 'src');
    patchProperty(HTMLMediaElement.prototype, 'src');
    var ins = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function (rule, index) {
      return ins.call(this, rewriteCss(String(rule)), index);
    };
    var setProp = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (name, value, prio) {
      return setProp.call(this, name, value == null ? value : rewriteCss(String(value)), prio);
    };
    ['background', 'backgroundImage', 'maskImage', 'listStyleImage', 'borderImage', 'borderImageSource', 'content'].forEach(function (k) {
      var d = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, k);
      if (!d || !d.set || !d.configurable) return;
      Object.defineProperty(CSSStyleDeclaration.prototype, k, {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function (v) { d.set.call(this, v == null ? v : rewriteCss(String(v))); },
      });
    });
    // Storage: an opaque origin has none, and reading it throws. In memory, for this session.
    ['localStorage', 'sessionStorage'].forEach(function (name) {
      var data = new Map();
      var store = {
        get length() { return data.size; },
        key: function (i) { return Array.from(data.keys())[i] === undefined ? null : Array.from(data.keys())[i]; },
        getItem: function (k) { k = String(k); return data.has(k) ? data.get(k) : null; },
        setItem: function (k, v) { data.set(String(k), String(v)); },
        removeItem: function (k) { data.delete(String(k)); },
        clear: function () { data.clear(); },
      };
      try {
        Object.defineProperty(window, name, { configurable: true, get: function () { return store; } });
      } catch (e) {
        /* left as the browser has it */
      }
    });
    try {
      var cookie = '';
      Object.defineProperty(document, 'cookie', { configurable: true, get: function () { return cookie; }, set: function () {} });
    } catch (e) {
      /* left as the browser has it */
    }
    // Popups are off in the sandbox; the wallet asks before opening a link.
    window.open = function (url) {
      var abs = null;
      try {
        abs = new URL(String(url), document.baseURI).href;
      } catch (e) {
        abs = null;
      }
      if (abs && /^https:/i.test(abs)) send({ t: 'open-link', url: abs });
      return null;
    };
    emptyScript = N.createObjectURL.call(URL, new Blob(['/* qwebchannel.js: the bridge defines QWebChannel */'], { type: 'text/javascript' }));
  }

  function watchLinksAndActivity() {
    document.addEventListener(
      'click',
      function (e) {
        var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        var href = a.getAttribute('href');
        if (!href || href.charAt(0) === '#') return;
        var abs;
        try {
          abs = new URL(href, document.baseURI).href;
        } catch (err) {
          return;
        }
        if (abs.indexOf(ROOT) === 0) return;
        e.preventDefault();
        if (/^https:/i.test(abs)) send({ t: 'open-link', url: abs });
      },
      true,
    );
    var last = 0;
    var touched = function () {
      var now = Date.now();
      if (now - last > 10000) {
        last = now;
        send({ t: 'activity' });
      }
    };
    document.addEventListener('pointerdown', touched, true);
    document.addEventListener('keydown', touched, true);
  }

  // A request the frame's policy refused: the wallet hears its https origin once (16 at most) and,
  // for a dApp installed from a file, may ask the person whether this dApp may reach it.
  var blockedSeen = Object.create(null);
  var blockedCount = 0;
  function watchBlocked() {
    document.addEventListener(
      'securitypolicyviolation',
      function (e) {
        if (!e.isTrusted) return;
        var d = String(e.effectiveDirective || e.violatedDirective || '').split(' ')[0];
        if (d !== 'connect-src' && d !== 'img-src') return;
        var origin;
        try {
          var u = new N.URL(String(e.blockedURI));
          if (u.protocol !== 'https:') return;
          origin = u.origin;
        } catch (err) {
          return;
        }
        if (blockedSeen[origin] || blockedCount >= 16) return;
        blockedSeen[origin] = 1;
        blockedCount++;
        send({ t: 'blocked', origin: origin, directive: d });
      },
      true,
    );
  }

  function watchMutations() {
    // A safety net for what the patches above cannot see (markup set with
    // innerHTML, style elements filled with text): rewritten after the fact.
    var fix = function (el) {
      if (!el || el.nodeType !== 1) return;
      ['src', 'href', 'poster', 'srcset', 'style', 'xlink:href'].forEach(function (a) {
        var v = el.getAttribute(a);
        if (v == null) return;
        var w = rewriteAttr(el, a, v);
        if (w !== v) N.setAttribute.call(el, a, w);
      });
      if (el.tagName === 'STYLE' && el.textContent && /url\(|@import/.test(el.textContent)) {
        var t = rewriteCss(el.textContent);
        if (t !== el.textContent) el.textContent = t;
      }
    };
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        if (r.type === 'attributes') fix(r.target);
        else if (r.type === 'characterData') fix(r.target.parentNode);
        else
          r.addedNodes.forEach(function (n) {
            if (n.nodeType === 3) fix(n.parentNode);
            else if (n.nodeType === 1) {
              fix(n);
              if (n.querySelectorAll) Array.prototype.forEach.call(n.querySelectorAll('[src],[href],[srcset],[style],[poster],style'), fix);
            }
          });
      });
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'href', 'srcset', 'style', 'poster'] });
  }

  // ------------------------------------------------------------ start
  function start(m) {
    if (!Array.isArray(m.files) || typeof m.start !== 'string') throw new Error('bad start message');
    m.files.forEach(function (f) {
      files[f.path] = { type: f.type || 'application/octet-stream', bytes: new Uint8Array(f.buf) };
    });
    if (!files[m.start]) throw new Error('the start page is missing');
    var here = location.href.split('#')[0].split('?')[0];
    var encodedStart = m.start.split('/').map(encodeURIComponent).join('/');
    if (here.slice(-encodedStart.length - 1) !== '/' + encodedStart) throw new Error('unexpected frame address');
    ROOT = here.slice(0, here.length - encodedStart.length);

    installPatches(m.shape, typeof m.ua === 'string' ? m.ua : null);
    installBridge(m.style && typeof m.style === 'object' ? m.style : {});

    var html = new TextDecoder().decode(files[m.start].bytes);
    var doc = new DOMParser().parseFromString(html, 'text/html');
    Array.prototype.forEach.call(doc.querySelectorAll('script[type="module"][src]'), function (el) {
      var p = pathOf(new URL(el.getAttribute('src'), document.baseURI).href);
      if (p) N.setAttribute.call(el, 'src', moduleBlob(p));
    });
    Array.prototype.forEach.call(doc.querySelectorAll('[src],[href],[srcset],[poster],[style]'), function (el) {
      if (el.tagName === 'SCRIPT' && el.getAttribute('type') === 'module') return;
      ['src', 'href', 'srcset', 'poster', 'style'].forEach(function (a) {
        var v = el.getAttribute(a);
        if (v != null) N.setAttribute.call(el, a, rewriteAttr(el, a, v));
      });
    });
    Array.prototype.forEach.call(doc.querySelectorAll('style'), function (el) {
      el.textContent = rewriteCss(el.textContent);
    });
    // Nothing in the page may move its own base or navigate the frame by itself.
    Array.prototype.forEach.call(doc.querySelectorAll('base, meta[http-equiv="refresh" i]'), function (el) {
      el.remove();
    });
    if (typeof m.hostCss === 'string' && m.hostCss) {
      var link = doc.createElement('link');
      N.setAttribute.call(link, 'rel', 'stylesheet');
      N.setAttribute.call(link, 'href', N.createObjectURL.call(URL, new Blob([m.hostCss], { type: 'text/css' })));
      doc.head.insertBefore(link, doc.head.firstChild);
    }
    if (Object.keys(importMap).length) {
      var map = doc.createElement('script');
      N.setAttribute.call(map, 'type', 'importmap');
      if (NONCE) N.setAttribute.call(map, 'nonce', NONCE);
      map.textContent = JSON.stringify({ imports: importMap });
      doc.head.insertBefore(map, doc.head.firstChild);
    }
    // The wallet's own helper scripts (an in-memory IndexedDB) run before any of the dApp's.
    (Array.isArray(m.shims) ? m.shims : []).slice().reverse().forEach(function (text) {
      if (typeof text !== 'string') return;
      var s = doc.createElement('script');
      N.setAttribute.call(s, 'src', N.createObjectURL.call(URL, new Blob([text], { type: 'text/javascript' })));
      doc.head.insertBefore(s, doc.head.firstChild);
    });
    var out = '<!doctype html>' + doc.documentElement.outerHTML;
    document.open();
    // document.open() drops window and document listeners: these come back first.
    listenForHandshake();
    watchLinksAndActivity();
    watchBlocked();
    watchMutations();
    document.write(out);
    document.close();
    send({ t: 'started' });
    // Some dApps are laid out for a desktop window; the wallet tells the person to swipe.
    setTimeout(function () {
      var d = document.documentElement;
      if (d) send({ t: 'layout', width: d.scrollWidth, viewport: d.clientWidth });
    }, 4000);
  }
})();
