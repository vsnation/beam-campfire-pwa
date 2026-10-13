// Settings -> Appearance, set before the first paint so the start screen is already light or dark
// and in the colours chosen (index.html loads this before the stylesheets). The rest is
// lib/theme.js, which uses the same keys and bar colours: test/unit/theme.test.mjs checks they agree.
(function () {
  try {
    var t = localStorage.getItem('campfire-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    if (localStorage.getItem('campfire-skin') === 'beam') {
      document.documentElement.setAttribute('data-skin', 'beam');
      // The browser bar in BEAM's colours too (index.html's metas carry Campfire's).
      var bars = { light: '#eef5fa', dark: '#042548' };
      var m = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < m.length; i++) {
        var own = /dark/.test(m[i].getAttribute('media') || '') ? 'dark' : 'light';
        m[i].setAttribute('content', bars[t === 'light' || t === 'dark' ? t : own]);
      }
    }
  } catch (e) {
    /* storage blocked: the device's own light or dark, in Campfire red */
  }
})();
