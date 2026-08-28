// Site-wide light/dark theme toggle. Loaded synchronously in <head>, so it applies
// the saved (or system) theme before the body paints — no flash. Then it injects a
// ☀/🌙 button into any [data-theme-toggle] slot, or a floating top-right button if
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

  function targetIcon(t) { return t === 'light' ? '🌙' : '☀'; } // the icon shows what a click switches TO
  var buttons = [];
  function refresh() { buttons.forEach(function (b) { b.textContent = targetIcon(theme); }); }
  function toggle() { theme = (theme === 'light' ? 'dark' : 'light'); apply(theme); store(theme); refresh(); }
  function makeBtn() {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-toggle';
    b.setAttribute('aria-label', 'Toggle light or dark theme');
    b.title = 'Light / dark theme';
    b.textContent = targetIcon(theme);
    b.addEventListener('click', toggle);
    buttons.push(b);
    return b;
  }
  function init() {
    var st = document.createElement('style');
    st.textContent = '.theme-toggle{background:transparent;border:1px solid currentColor;color:inherit;opacity:.6;'
      + 'border-radius:8px;padding:4px 9px;cursor:pointer;font-size:15px;line-height:1;vertical-align:middle}'
      + '.theme-toggle:hover{opacity:1}'
      + '.theme-toggle-fixed{position:fixed;top:12px;right:14px;z-index:60}';
    document.head.appendChild(st);
    var slots = document.querySelectorAll('[data-theme-toggle]');
    if (slots.length) { slots.forEach(function (s) { s.appendChild(makeBtn()); }); }
    else { var b = makeBtn(); b.classList.add('theme-toggle-fixed'); document.body.appendChild(b); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
