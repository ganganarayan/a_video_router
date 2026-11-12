// Adds a show/hide eye toggle, and a copy-to-clipboard button, to every password
// field on the page. The copy button lets a secret be copied without ever
// revealing it on screen; the eye stays a separate, deliberate action.
// Dependency-free and self-initialising, safe to include on auth pages and the
// dashboard alike. Preserves the input element (id, name, listeners) by wrapping
// it in place rather than replacing it.
(function () {
  // UI-STRICTURES.md §6: no emoji in the product UI. These are the Lucide eye,
  // eye-off, copy and check paths, inlined rather than taken from app.js so this
  // file keeps working whatever the script order on a page.
  var EYE = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M10.7 5.1A7 7 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-2.2 3.1"/>'
    + '<path d="M6.6 6.6A18 18 0 0 0 2 12s3.6 7 10 7a9 9 0 0 0 3.9-.9"/>'
    + '<path d="m2 2 20 20"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  var COPY = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'
    + '<rect x="9" y="9" width="12" height="12" rx="2"/>'
    + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var CHECK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M20 6 9 17l-5-5"/></svg>';

  // Copy text to the clipboard without revealing the field. Falls back to a
  // hidden textarea + execCommand where the async Clipboard API is unavailable
  // (e.g. an insecure context), so this works on auth pages too.
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('copy failed'));
      } catch (err) { reject(err); }
    });
  }

  function attach(input) {
    if (input.dataset.eye) return;
    input.dataset.eye = '1';
    const wrap = document.createElement('span');
    wrap.className = 'pw-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    // Copy button: copies the current value without changing input.type, so the
    // secret never appears on screen.
    const cp = document.createElement('button');
    cp.type = 'button';
    cp.className = 'pw-copy';
    cp.setAttribute('aria-label', 'Copy to clipboard');
    cp.setAttribute('title', 'Copy to clipboard');
    cp.innerHTML = COPY;
    let cpTimer = null;
    cp.addEventListener('click', function () {
      const val = input.value;
      if (!val) { return; }
      copyText(val).then(function () {
        cp.classList.add('ok');
        cp.innerHTML = CHECK;
        cp.setAttribute('aria-label', 'Copied');
        if (cpTimer) clearTimeout(cpTimer);
        cpTimer = setTimeout(function () {
          cp.classList.remove('ok');
          cp.innerHTML = COPY;
          cp.setAttribute('aria-label', 'Copy to clipboard');
        }, 1500);
      }).catch(function () { /* clipboard blocked, nothing to show */ });
    });
    wrap.appendChild(cp);

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
