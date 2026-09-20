/*! Nova i18n runtime - one file, no dependencies, shared by every Nova website.
 *
 * HOW IT WORKS
 *   Pages are written in English, as always. This script finds every piece of visible text (text
 *   runs, inline markup, and a fixed list of attributes such as title / alt / placeholder /
 *   aria-label plus <title> and the description / Open Graph meta tags), looks the English up in
 *   the current language's catalog, and swaps in the translation. A string with no translation
 *   simply stays English, so nothing can ever render blank or show a key.
 *
 *   The catalog is keyed by the English source text, normalized (see `keyOf`). That is what makes
 *   future text translatable without tagging: write the sentence, run `npm run i18n:extract`,
 *   translate what is missing, ship. Inline markup is protected as numbered placeholders, e.g.
 *     "Read the <1>terms</1> and <2>privacy policy</2>."
 *   so links, emphasis and their attributes are never touched by a translation.
 *
 *   The same `collect()` function drives both the browser and the extraction tool, so what the
 *   tool extracts is exactly what the runtime looks up.
 *
 * OPT OUT
 *   translate="no", class="notranslate" or data-i18n-skip on any element. <code>, <pre>, <kbd>,
 *   <svg>, <script>, <style> and form values are never translated.
 *
 * JS API
 *   NovaI18n.t("Welcome, {name}", { name })          interpolation
 *   NovaI18n.t("{count} clip|{count} clips", { count })   plural (one|other, per Intl.PluralRules)
 *   NovaI18n.setLanguage("es"), .getLanguage(), .languages, .onChange(fn), .ready (Promise)
 */
(function (global) {
  'use strict';
  if (global.NovaI18n) return;

  var doc = global.document;

  /* ── configuration ─────────────────────────────────────────────────────────────────────── */

  /* Adding a language = one row here + a catalog file (see README). Native names, never translated. */
  var LANGS = [
    { code: 'en', name: 'English', short: 'EN' },
    { code: 'es', name: 'Español', short: 'ES' },
    { code: 'fr', name: 'Français', short: 'FR' },
    { code: 'de', name: 'Deutsch', short: 'DE' },
    { code: 'pt', name: 'Português', short: 'PT' }
  ];
  var DEFAULT = 'en';
  var STORE_KEY = 'nova.lang';
  var COOKIE = 'nova_lang';

  var script = doc.currentScript;
  var BASE = (script && script.getAttribute('data-base')) || '/i18n/';
  var VERSION = (script && script.getAttribute('data-version')) || '';
  var ONLY = script && script.getAttribute('data-langs');
  if (ONLY) {
    var allow = ONLY.split(',');
    LANGS = LANGS.filter(function (l) { return allow.indexOf(l.code) !== -1; });
  }

  /* The selector's own words. Built in so it is correct before any catalog has loaded. */
  var UI = {
    en: { language: 'Language', partial: '', authoritative: '', showEnglish: 'Show in English' },
    es: { language: 'Idioma', partial: 'Parte de esta página aún no está traducida y se muestra en inglés.', authoritative: 'En los documentos legales prevalece la versión en inglés.', showEnglish: 'Ver en inglés' },
    fr: { language: 'Langue', partial: 'Une partie de cette page n’est pas encore traduite et s’affiche en anglais.', authoritative: 'Pour les documents juridiques, la version anglaise fait foi.', showEnglish: 'Afficher en anglais' },
    de: { language: 'Sprache', partial: 'Ein Teil dieser Seite ist noch nicht übersetzt und wird auf Englisch angezeigt.', authoritative: 'Bei Rechtsdokumenten ist die englische Fassung maßgeblich.', showEnglish: 'Auf Englisch anzeigen' },
    pt: { language: 'Idioma', partial: 'Parte desta página ainda não foi traduzida e é exibida em inglês.', authoritative: 'Nos documentos jurídicos, prevalece a versão em inglês.', showEnglish: 'Ver em inglês' }
  };

  /* ── segmentation (shared with the extraction tool) ────────────────────────────────────── */

  var SKIP = {
    script: 1, style: 1, noscript: 1, textarea: 1, code: 1, pre: 1, svg: 1, canvas: 1, iframe: 1,
    template: 1, kbd: 1, samp: 1, var: 1, head: 1, object: 1, video: 1, audio: 1, math: 1
  };
  var INLINE = {
    a: 1, abbr: 1, b: 1, bdi: 1, bdo: 1, br: 1, cite: 1, data: 1, del: 1, dfn: 1, em: 1, i: 1, ins: 1,
    mark: 1, q: 1, s: 1, small: 1, span: 1, strong: 1, sub: 1, sup: 1, time: 1, u: 1, wbr: 1, img: 1,
    code: 1, kbd: 1, samp: 1, var: 1, svg: 1
  };
  /* Never translated, but they sit INSIDE sentences, so they are placeholders rather than breaks. */
  var ATOMIC = { code: 1, kbd: 1, samp: 1, var: 1, svg: 1, img: 1, br: 1, wbr: 1 };
  var ATTRS = ['title', 'alt', 'placeholder', 'aria-label', 'aria-description', 'aria-placeholder'];
  var LETTER = /\p{L}/u;

  function skipped(el) {
    if (SKIP[el.localName]) return true;
    if (el.getAttribute('translate') === 'no') return true;
    if (el.hasAttribute('data-i18n-skip')) return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    if (el.isContentEditable) return true;
    return false;
  }

  /* An inline tag whose whole subtree is inline too. `<a class="card"><div>..</div></a>` is a block. */
  function isFlow(el) {
    if (!INLINE[el.localName]) return false;
    if (ATOMIC[el.localName]) return true;
    /* CSS decides what is a sentence and what is a card: a <span> styled display:block is its own
       string. inline-block / flex / grid are boxes, not words. */
    var d = global.getComputedStyle ? global.getComputedStyle(el).display : 'inline';
    if (d !== 'inline' && d !== 'none' && d !== 'contents' && d !== '') return false;
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (!isFlow(c)) return false;
    return true;
  }

  /* Symbols, arrows, icons, <br>: kept exactly as they are, never sent for translation. */
  function isOpaque(el) {
    if (ATOMIC[el.localName]) return true;
    return !LETTER.test(el.textContent || '') || skipped(el);
  }

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function unesc(s) { return s.replace(/&lt;/g, '<').replace(/&amp;/g, '&'); }

  /* Serialize a run of sibling nodes to the catalog key format. */
  function serialize(nodes) {
    var els = [];
    function ser(list) {
      var out = '';
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        if (n.nodeType === 3) out += esc(n.nodeValue);
        else if (n.nodeType === 1) {
          var idx = els.length + 1;
          els.push(n);
          out += isOpaque(n) ? '<' + idx + '/>' : '<' + idx + '>' + ser(n.childNodes) + '</' + idx + '>';
        }
      }
      return out;
    }
    var raw = ser(nodes);
    var lead = /^\s*/.exec(raw)[0], trail = /\s*$/.exec(raw)[0];
    var key = raw.replace(/\s+/g, ' ').trim();
    return { key: key, els: els, lead: lead ? ' ' : '', trail: trail && raw.trim() ? ' ' : '' };
  }

  function hasLetters(key) { return LETTER.test(key.replace(/<\/?\d+\/?>/g, '')); }

  /* Find every translatable run under `root`. */
  function collect(root) {
    /* A subtree scanned from below (e.g. after one attribute changed) still honours an opt-out on any ancestor. */
    if (root.nodeType === 1 && insideSkipped(root)) return { runs: [], attrs: [] };
    var runs = [];
    (function walk(el) {
      if (el.nodeType === 1 && skipped(el)) return;
      var run = [];
      function flush() {
        if (run.length) {
          var s = serialize(run);
          if (hasLetters(s.key)) runs.push({ nodes: run, parent: el, key: s.key, els: s.els, lead: s.lead, trail: s.trail });
        }
        run = [];
      }
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) run.push(c);
        else if (c.nodeType === 1) {
          if (skipped(c) && !INLINE[c.localName]) { flush(); continue; }
          if (isFlow(c)) run.push(c);
          else { flush(); walk(c); }
        } else if (c.nodeType === 8) flush();
      }
      flush();
    })(root.nodeType === 9 ? root.documentElement : root);

    var attrs = [];
    var scope = root.nodeType === 9 ? root.body || root.documentElement : root;
    var sel = ATTRS.map(function (a) { return '[' + a + ']'; }).join(',') + ',input[type=submit],input[type=button],input[type=reset]';
    var list = scope.querySelectorAll ? Array.prototype.slice.call(scope.querySelectorAll(sel)) : [];
    if (scope.matches && scope.matches(sel)) list.unshift(scope);
    list.forEach(function (el) {
      if (insideSkipped(el)) return;
      ATTRS.forEach(function (a) { if (el.hasAttribute(a)) attrs.push({ el: el, attr: a }); });
      if (el.localName === 'input' && /^(submit|button|reset)$/.test(el.type) && el.hasAttribute('value')) attrs.push({ el: el, attr: 'value' });
    });
    if (root.nodeType === 9) {
      if (doc.title) attrs.push({ el: doc, attr: 'title' });
      Array.prototype.forEach.call(doc.querySelectorAll('meta[name="description"],meta[property="og:title"],meta[property="og:description"],meta[name="twitter:title"],meta[name="twitter:description"]'), function (m) {
        attrs.push({ el: m, attr: 'content' });
      });
    }
    return { runs: runs, attrs: attrs };
  }

  function insideSkipped(el) {
    for (var p = el; p && p.nodeType === 1; p = p.parentNode) if (p !== doc.documentElement && skippedAttrOnly(p)) return true;
    return false;
  }
  /* For attributes, <code>/<kbd> ancestors do not matter - only explicit opt-outs. */
  function skippedAttrOnly(p) {
    return p.getAttribute('translate') === 'no' || p.hasAttribute('data-i18n-skip') || (p.classList && p.classList.contains('notranslate'));
  }

  /* ── state ─────────────────────────────────────────────────────────────────────────────── */

  var lang = DEFAULT;
  var catalogs = {};           // code -> { source: translation }
  var records = new WeakMap(); // node -> { key, els, lead, trail, nodes, applied }
  var attrRecs = new WeakMap(); // element -> { attr: { src, applied } }
  var listeners = [];
  var missing = {};
  var observer = null, applying = false, queue = [], scheduled = false;
  var debug = false;
  try { debug = /(^|[?&])i18n-debug/.test(global.location.search) || global.localStorage.getItem('nova.i18n.debug') === '1' || /^(localhost|127\.)/.test(global.location.hostname); } catch (e) {}

  function supported(code) { return LANGS.some(function (l) { return l.code === code; }); }

  /* Every miss is remembered (cheap, and what missingKeys() reports); it is only WARNED about in development. */
  function warnMissing(key) {
    if (lang === DEFAULT || missing[lang + '\u0000' + key]) return;
    missing[lang + '\u0000' + key] = 1;
    if (!debug) return;
    try { console.warn('Missing translation:\n' + key + '\nlocale: ' + lang + '\nfallback: en'); } catch (e) {}
  }

  function lookup(key) {
    if (lang === DEFAULT) return key;
    var cat = catalogs[lang];
    var v = cat && Object.prototype.hasOwnProperty.call(cat, key) ? cat[key] : undefined;
    if (typeof v !== 'string' || !v) { warnMissing(key); return key; }
    return v;
  }

  /* ── applying translations ─────────────────────────────────────────────────────────────── */

  function tagList(s) { return (s.match(/<\/?\d+\/?>/g) || []).sort().join(''); }

  function build(unit, str) {
    var frag = doc.createDocumentFragment();
    if (unit.lead) frag.appendChild(doc.createTextNode(' '));
    var stack = [frag];
    var re = /<(\/?)(\d+)(\/?)>/g, last = 0, m;
    function text(t) { if (t) stack[stack.length - 1].appendChild(doc.createTextNode(unesc(t))); }
    while ((m = re.exec(str))) {
      text(str.slice(last, m.index));
      last = re.lastIndex;
      var el = unit.els[Number(m[2]) - 1];
      if (m[1]) { stack.pop(); }
      else if (m[3]) { stack[stack.length - 1].appendChild(el); }
      else {
        while (el.firstChild) el.removeChild(el.firstChild);
        stack[stack.length - 1].appendChild(el);
        stack.push(el);
      }
    }
    text(str.slice(last));
    if (unit.trail) frag.appendChild(doc.createTextNode(' '));
    return frag;
  }

  function sameRun(rec, nodes) {
    if (!rec || rec.nodes.length !== nodes.length) return false;
    for (var i = 0; i < nodes.length; i++) if (rec.nodes[i] !== nodes[i]) return false;
    return true;
  }

  function applyRun(u) {
    var rec = records.get(u.nodes[0]);
    var unit = sameRun(rec, u.nodes) ? rec : u;
    var want = lookup(unit.key);
    if (want !== unit.key && tagList(want) !== tagList(unit.key)) {
      if (debug) try { console.warn('Translation changes the markup placeholders, using English:\n' + unit.key); } catch (e) {}
      want = unit.key;
    }
    var current = unit.applied === undefined ? unit.key : unit.applied;
    if (want === current) { if (unit !== rec) records.set(u.nodes[0], unit); return; }

    var marker = doc.createComment('');
    var first = unit.nodes[0], parent = first.parentNode;
    if (!parent) return;
    parent.insertBefore(marker, first);
    var frag = build(unit, want);
    var fresh = Array.prototype.slice.call(frag.childNodes);
    parent.insertBefore(frag, marker);
    unit.nodes.forEach(function (n) { if (n.parentNode === parent && fresh.indexOf(n) === -1) parent.removeChild(n); });
    parent.removeChild(marker);
    unit.nodes = fresh;
    unit.applied = want;
    fresh.forEach(function (n) { records.set(n, unit); });
  }

  function attrGet(el, attr) { return el === doc ? doc.title : el.getAttribute(attr); }
  function attrSet(el, attr, v) { if (el === doc) doc.title = v; else el.setAttribute(attr, v); }

  function applyAttr(a) {
    var cur = attrGet(a.el, a.attr);
    if (!cur) return;
    var recs = attrRecs.get(a.el);
    if (!recs) { recs = {}; attrRecs.set(a.el, recs); }
    var r = recs[a.attr];
    var src = r && r.applied === cur ? r.src : cur;
    if (!LETTER.test(src)) return;
    var key = src.replace(/\s+/g, ' ').trim();
    var want = lookup(key);
    if (want !== cur) attrSet(a.el, a.attr, want);
    recs[a.attr] = { src: src, applied: want };
  }

  function translateTree(root) {
    var found = collect(root);
    applying = true;
    try {
      found.runs.forEach(applyRun);
      found.attrs.forEach(applyAttr);
    } finally {
      applying = false;
      if (observer) observer.takeRecords();
    }
  }

  /* ── keeping up with text added later ──────────────────────────────────────────────────── */

  function flushQueue() {
    scheduled = false;
    var roots = queue; queue = [];
    var seen = [];
    roots.forEach(function (r) {
      if (!r || !r.isConnected) return;
      for (var i = 0; i < seen.length; i++) if (seen[i].contains(r)) return;
      seen = seen.filter(function (s) { return !r.contains(s); });
      seen.push(r);
    });
    seen.forEach(translateTree);
  }

  function enqueue(root) {
    queue.push(root);
    if (!scheduled) { scheduled = true; (global.requestAnimationFrame || global.setTimeout)(flushQueue); }
  }

  function startObserving() {
    if (observer || !global.MutationObserver) return;
    observer = new MutationObserver(function (muts) {
      if (applying) return;
      muts.forEach(function (m) {
        if (m.type === 'childList') {
          m.addedNodes.forEach(function (n) { if (n.nodeType === 1) enqueue(n); else if (n.nodeType === 3 && n.parentElement) enqueue(n.parentElement); });
          if (m.target.nodeType === 1) enqueue(m.target);
        } else if (m.type === 'characterData') {
          if (m.target.parentElement) enqueue(m.target.parentElement);
        } else if (m.type === 'attributes') {
          enqueue(m.target);
        }
      });
    });
    observer.observe(doc.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS.concat(['value', 'content'])
    });
  }

  /* ── loading + switching ───────────────────────────────────────────────────────────────── */

  /* A page opened straight from disk (file://) cannot fetch() its catalogs; browsers refuse. A
     <script> is allowed, so a site that ships <lang>.js beside <lang>.json (see tools/build.mjs,
     "scriptCatalogs") can still translate. The script registers itself on window.__novaI18n. */
  function loadScript(code, suffix) {
    return new Promise(function (resolve, reject) {
      var have = global.__novaI18n && global.__novaI18n[code];
      if (have) return resolve(have);
      var s = doc.createElement('script');
      s.src = BASE + code + '.js' + suffix;
      s.onload = function () { var c = global.__novaI18n && global.__novaI18n[code]; c ? resolve(c) : reject(new Error('empty script catalog')); };
      s.onerror = function () { reject(new Error('script not found')); };
      doc.head.appendChild(s);
    });
  }

  function load(code) {
    if (code === DEFAULT || catalogs[code]) return Promise.resolve();
    var suffix = VERSION ? '?v=' + encodeURIComponent(VERSION) : '';
    var url = BASE + code + '.json' + suffix;
    var request = global.location && global.location.protocol === 'file:'
      ? loadScript(code, suffix)
      : global.fetch(url, { credentials: 'same-origin' })
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
    return request
      .then(function (j) { catalogs[code] = j && j.strings ? j.strings : {}; })
      .catch(function (e) {
        catalogs[code] = {};
        try { console.warn('Nova i18n: could not load ' + url + ' (' + e.message + '); staying in English.'); } catch (x) {}
      });
  }

  function store(code) {
    try { global.localStorage.setItem(STORE_KEY, code); } catch (e) {}
    try { doc.cookie = COOKIE + '=' + code + '; Path=/; Max-Age=31536000; SameSite=Lax'; } catch (e) {}
  }

  function stored() {
    try { var v = global.localStorage.getItem(STORE_KEY); if (v && supported(v)) return v; } catch (e) {}
    return null;
  }

  function fromBrowser() {
    var prefs = global.navigator.languages || [global.navigator.language];
    for (var i = 0; i < prefs.length; i++) {
      var c = String(prefs[i] || '').toLowerCase().split('-')[0];
      if (supported(c)) return c;
    }
    return DEFAULT;
  }

  function initial() {
    var q = /(?:^|[?&])lang=([a-z]{2})/.exec(global.location.search);
    if (q && supported(q[1])) return { code: q[1], persist: true };
    var s = stored();
    if (s) return { code: s, persist: false };
    return { code: fromBrowser(), persist: false };
  }

  /* When a page is only partly translated, say so, and offer the original. Legal documents add that
     the English version governs (a page opts in with <meta name="nova-i18n-authoritative">). The
     notice vanishes by itself once a page has no untranslated text left. */
  function updateNotice() {
    var old = doc.querySelector('.ni-notice');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (lang === DEFAULT) return;
    var left = Object.keys(missing).filter(function (id) {
      return id.indexOf(lang + '\u0000') === 0 && /[A-Za-z]{3}/.test(id.slice(lang.length + 1).replace(/<\/?\d+\/?>/g, ''));
    }).length;
    var legal = !!doc.querySelector('meta[name="nova-i18n-authoritative"]');
    if (left < 4 && !(legal && left > 0)) return;
    var box = doc.createElement('div');
    box.className = 'ni-notice';
    box.setAttribute('role', 'status');
    box.setAttribute('translate', 'no');
    box.setAttribute('data-i18n-skip', '');
    var text = doc.createElement('span');
    text.textContent = ui('partial') + (legal ? ' ' + ui('authoritative') : '');
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'ni-notice__btn';
    btn.textContent = (UI[lang] || UI.en).showEnglish;
    btn.addEventListener('click', function () { setLanguage(DEFAULT); });
    box.appendChild(text);
    box.appendChild(btn);
    var host = doc.querySelector('main') || doc.body;
    host.insertBefore(box, host.firstChild);
  }

  function setLanguage(code, opts) {
    if (!supported(code)) code = DEFAULT;
    opts = opts || {};
    return load(code).then(function () {
      lang = code;
      doc.documentElement.setAttribute('lang', code);
      translateTree(doc);
      updateNotice();
      if (code === DEFAULT) { if (observer) { observer.disconnect(); observer = null; } }
      else startObserving();
      if (opts.persist !== false) store(code);
      doc.documentElement.classList.remove('i18n-pending');
      listeners.slice().forEach(function (fn) { try { fn(code); } catch (e) {} });
      /* Text changed width, so anything a page positioned by measuring it (a sliding nav highlight,
         a sticky offset) needs to measure again. Sites already listen for resize. */
      (global.requestAnimationFrame || global.setTimeout)(function () {
        try { global.dispatchEvent(new Event('resize')); doc.dispatchEvent(new CustomEvent('novai18n:change', { detail: { lang: code } })); } catch (e) {}
      });
    });
  }

  /* ── t(): for text built in JavaScript ─────────────────────────────────────────────────── */

  function t(source, vars) {
    var s = lookup(source);
    if (vars && vars.count !== undefined && s.indexOf('|') !== -1) {
      var forms = s.split('|');
      var rule = 'other';
      try { rule = new Intl.PluralRules(lang).select(vars.count); } catch (e) {}
      s = forms[rule === 'one' || forms.length === 1 ? 0 : Math.min(1, forms.length - 1)];
    }
    return vars ? s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] === undefined ? m : String(vars[k]); }) : s;
  }

  /* ── the selector ──────────────────────────────────────────────────────────────────────── */

  var GLOBE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3Z"/></svg>';
  var CARET = '<svg class="ni-caret" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

  function ui(key) { return (UI[lang] || UI.en)[key]; }

  function mount(slot) {
    var floating = !slot;
    var wrap = doc.createElement('div');
    wrap.className = 'ni-lang' + (floating ? ' ni-lang--float' : '');
    wrap.setAttribute('translate', 'no');
    wrap.setAttribute('data-i18n-skip', '');
    var uid = 'ni-lang-' + Math.random().toString(36).slice(2, 8);
    wrap.innerHTML =
      '<button class="ni-lang__btn" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="' + uid + '">' + GLOBE +
      '<span class="ni-lang__cur"></span><span class="ni-lang__short" aria-hidden="true"></span>' + CARET + '</button>' +
      '<ul class="ni-lang__menu" id="' + uid + '" role="listbox" tabindex="-1" hidden>' +
      LANGS.map(function (l) {
        return '<li class="ni-lang__opt" role="option" lang="' + l.code + '" data-code="' + l.code + '" id="' + uid + '-' + l.code + '">' +
          '<span>' + l.name + '</span><svg class="ni-check" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></li>';
      }).join('') + '</ul>';
    (slot || doc.body).appendChild(wrap);

    var btn = wrap.querySelector('.ni-lang__btn'), menu = wrap.querySelector('.ni-lang__menu');
    var opts = Array.prototype.slice.call(menu.children);
    var active = 0;

    function label() {
      var l = LANGS.filter(function (x) { return x.code === lang; })[0] || LANGS[0];
      wrap.querySelector('.ni-lang__cur').textContent = l.name;
      wrap.querySelector('.ni-lang__short').textContent = l.short;
      btn.setAttribute('aria-label', ui('language') + ': ' + l.name);
      menu.setAttribute('aria-label', ui('language'));
      opts.forEach(function (o) { o.setAttribute('aria-selected', String(o.getAttribute('data-code') === lang)); });
    }
    function focusOpt(i) {
      active = (i + opts.length) % opts.length;
      opts.forEach(function (o, n) { o.classList.toggle('is-active', n === active); });
      menu.setAttribute('aria-activedescendant', opts[active].id);
      opts[active].scrollIntoView && opts[active].scrollIntoView({ block: 'nearest' });
    }
    function open() {
      menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
      var cur = opts.map(function (o) { return o.getAttribute('data-code'); }).indexOf(lang);
      focusOpt(cur < 0 ? 0 : cur); menu.focus();
    }
    function close(refocus) {
      menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
      if (refocus) btn.focus();
    }
    function choose(i) { var code = opts[i].getAttribute('data-code'); close(true); setLanguage(code); }

    btn.addEventListener('click', function () { menu.hidden ? open() : close(true); });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
    });
    menu.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); focusOpt(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); focusOpt(active - 1); }
      else if (e.key === 'Home') { e.preventDefault(); focusOpt(0); }
      else if (e.key === 'End') { e.preventDefault(); focusOpt(opts.length - 1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') { close(false); }
      else if (e.key.length === 1) {
        var ch = e.key.toLowerCase();
        for (var k = 1; k <= opts.length; k++) {
          var i = (active + k) % opts.length;
          if (LANGS[i].name.toLowerCase().charAt(0) === ch) { focusOpt(i); break; }
        }
      }
    });
    menu.addEventListener('click', function (e) {
      var li = e.target.closest && e.target.closest('.ni-lang__opt');
      if (li) choose(opts.indexOf(li));
    });
    menu.addEventListener('mousemove', function (e) {
      var li = e.target.closest && e.target.closest('.ni-lang__opt');
      if (li) focusOpt(opts.indexOf(li));
    });
    doc.addEventListener('click', function (e) { if (!menu.hidden && !wrap.contains(e.target)) close(false); });
    wrap.addEventListener('focusout', function (e) { if (!menu.hidden && e.relatedTarget && !wrap.contains(e.relatedTarget)) close(false); });

    listeners.push(label);
    label();
    return wrap;
  }

  /* ── boot ──────────────────────────────────────────────────────────────────────────────── */

  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });

  function boot() {
    var slots = doc.querySelectorAll('[data-nova-lang-slot]');
    if (slots.length) Array.prototype.forEach.call(slots, function (s) { mount(s); });
    else mount(null);
    var start = initial();
    var pending = start.code === DEFAULT ? Promise.resolve().then(function () { lang = DEFAULT; doc.documentElement.classList.remove('i18n-pending'); if (start.persist) store(DEFAULT); })
                                         : setLanguage(start.code, { persist: start.persist });
    pending.then(readyResolve, readyResolve);
  }

  global.NovaI18n = {
    t: t,
    setLanguage: setLanguage,
    getLanguage: function () { return lang; },
    languages: LANGS,
    onChange: function (fn) { listeners.push(fn); },
    collect: collect,          // used by tools/extract.mjs
    missingKeys: function () { // English strings looked up in the current language with no translation
      var pre = lang + '\u0000';
      return Object.keys(missing).filter(function (id) { return id.indexOf(pre) === 0; }).map(function (id) { return id.slice(pre.length); });
    },
    keyOf: function (s) { return s.replace(/\s+/g, ' ').trim(); },
    ready: ready,
    mount: mount
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
