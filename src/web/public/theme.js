// Site-wide light/dark theme toggle. Loaded synchronously in <head>, so it applies
// the saved (or system) theme before the body paints — no flash. Then it injects a
// sun/moon icon button into any [data-theme-toggle] slot, or a floating top-right button if
// the page has no header slot. Choice is remembered in localStorage.
(function () {
  var KEY = 'vr-theme';
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function store(t) { try { localStorage.setItem(KEY, t); } catch (e) { /* private mode */ } }
  function systemLight() {
    try { return window.matchMedia('(prefers-color-scheme: light)').matches; } catch (e) { return false; }
  }
  var theme = saved() || (systemLight() ? 'light' : 'dark');
  function apply(t) { document.documentElement.setAttribute('data-theme', t); }
  apply(theme); // runs immediately, before <body> renders

  // UI-STRICTURES.md §6: no icon may be a text character and no emoji appears in
  // the product UI, so these are Lucide sun/moon paths at 16px, stroke 1.75.
  var SUN = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/>'
    + '<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2'
    + 'M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
  var MOON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
  function targetIcon(t) { return t === 'light' ? MOON : SUN; } // shows what a click switches TO
  var buttons = [];
  function refresh() { buttons.forEach(function (b) { b.innerHTML = targetIcon(theme); }); }
  function toggle() { theme = (theme === 'light' ? 'dark' : 'light'); apply(theme); store(theme); refresh(); }
  function makeBtn() {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-toggle';
    b.setAttribute('aria-label', 'Toggle light or dark theme');
    b.title = 'Light / dark theme';
    b.innerHTML = targetIcon(theme);
    b.addEventListener('click', toggle);
    buttons.push(b);
    return b;
  }
  function init() {
    var st = document.createElement('style');
    st.textContent = '.theme-toggle{background:transparent;border:1px solid var(--line-default);'
      + 'color:var(--text-secondary);opacity:.75;border-radius:var(--r-control);min-height:36px;'
      + 'padding:0 var(--sp-2);cursor:pointer;display:inline-flex;align-items:center;'
      + 'justify-content:center;vertical-align:middle}'
      + '.theme-toggle:hover{opacity:1;background:var(--surface-sunken);color:var(--text-primary)}'
      + '.theme-toggle-fixed{position:fixed;top:var(--sp-3);right:var(--sp-4);z-index:60}';
    document.head.appendChild(st);
    var slots = document.querySelectorAll('[data-theme-toggle]');
    if (slots.length) { slots.forEach(function (s) { s.appendChild(makeBtn()); }); }
    else { var b = makeBtn(); b.classList.add('theme-toggle-fixed'); document.body.appendChild(b); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
