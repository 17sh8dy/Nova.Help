/* Nova i18n - pre-paint boot. Loaded synchronously in <head> (a separate file, not inline, so it
   works under a strict Content-Security-Policy). It only does one thing: if the visitor is going
   to see a non-English page, mark <html> before the first paint so the page can wait for its
   catalog instead of flashing English. The runtime does the real work. Keep the language list in
   step with LANGS in nova-i18n.js. */
(function () {
  try {
    var d = document.documentElement, ok = ['es', 'fr', 'de', 'pt'], l = null, s = null;
    var q = /[?&]lang=([a-z]{2})/.exec(location.search);
    if (q && ok.indexOf(q[1]) > -1) l = q[1];
    try { s = localStorage.getItem('nova.lang'); } catch (e) {}
    if (!l && s && ok.indexOf(s) > -1) l = s;
    if (!l && !s) {
      var p = navigator.languages || [navigator.language];
      for (var i = 0; i < p.length; i++) {
        var c = String(p[i] || '').toLowerCase().split('-')[0];
        if (ok.indexOf(c) > -1) { l = c; break; }
      }
    }
    if (l) { d.setAttribute('lang', l); d.classList.add('i18n-pending'); }
  } catch (e) {}
})();
