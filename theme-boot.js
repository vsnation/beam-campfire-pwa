// Settings -> Appearance, set before the first paint so the start screen is already in the colours
// and the light or dark chosen (index.html loads this before the stylesheets, and carries the
// default: BEAM, dark). The rest is lib/theme.js, which uses the same keys, defaults and bar colours:
// test/unit/theme.test.mjs checks they agree.
(function () {
  try {
    var skin = localStorage.getItem('campfire-skin') === 'campfire' ? 'campfire' : 'beam';
    var t = localStorage.getItem('campfire-theme');
    // 0.2.19 and older saved Dark with this flag when BEAM was chosen: no theme was picked.
    if (t === 'dark' && localStorage.getItem('campfire-theme-auto') === '1') t = null;
    if (t !== 'system' && t !== 'light' && t !== 'dark') t = skin === 'campfire' ? 'system' : 'dark';
    var root = document.documentElement;
    if (t === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', t);
    if (skin === 'beam') root.setAttribute('data-skin', 'beam');
    else root.removeAttribute('data-skin');
    var bars = skin === 'beam' ? { light: '#e0ebf4', dark: '#04325a' } : { light: '#fff1f1', dark: '#1c1d22' };
    var m = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < m.length; i++) {
      var own = /dark/.test(m[i].getAttribute('media') || '') ? 'dark' : 'light';
      m[i].setAttribute('content', bars[t === 'system' ? own : t]);
    }
    var cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute('content', t === 'system' ? 'light dark' : t);
  } catch (e) {
    /* storage blocked: index.html's own look, BEAM dark */
  }
})();
