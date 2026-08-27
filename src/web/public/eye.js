// Adds a show/hide eye toggle to every password field on the page.
// Dependency-free and self-initialising — safe to include on auth pages and the
// dashboard alike. Preserves the input element (id, name, listeners) by wrapping
// it in place rather than replacing it.
(function () {
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
    btn.textContent = '👁';
    btn.addEventListener('click', function () {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.classList.toggle('on', show);
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
