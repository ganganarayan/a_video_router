// Adds a show/hide eye toggle to every password field on the page.
// Dependency-free and self-initialising — safe to include on auth pages and the
// dashboard alike. Preserves the input element (id, name, listeners) by wrapping
// it in place rather than replacing it.
(function () {
  // UI-STRICTURES.md §6: no emoji in the product UI. These are the Lucide eye and
  // eye-off paths, inlined rather than taken from app.js so this file keeps
  // working whatever the script order on a page.
  var EYE = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M10.7 5.1A7 7 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-2.2 3.1"/>'
    + '<path d="M6.6 6.6A18 18 0 0 0 2 12s3.6 7 10 7a9 9 0 0 0 3.9-.9"/>'
    + '<path d="m2 2 20 20"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  function attach(input) {
    if (input.dataset.eye) return;
    input.dataset.eye = '1';
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye';
    btn.setAttribute('aria-label', 'Show password');
    btn.innerHTML = EYE;
    btn.addEventListener('click', function () {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.classList.toggle('on', show);
      btn.innerHTML = show ? EYE_OFF : EYE;
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    wrap.appendChild(btn);
  }
  function init() {
    document.querySelectorAll('input[type="password"]').forEach(attach);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
