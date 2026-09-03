// Shared dashboard helpers
async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(message, kind = 'ok') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = kind;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 6000);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function statusBadge(status) {
  const ok = ['uploaded', 'lms_pushed', 'deleted', 'connected'];
  const warn = ['skipped_no_route', 'skipped_no_matching_view', 'unverified', 'pending', 'disconnected',
    'discovered', 'downloading', 'uploading', 'deleting'];
  const cls = ok.includes(status) ? 'ok' : (warn.includes(status) ? 'warn' : 'err');
  return `<span class="badge ${cls}">${esc(status || 'n/a')}</span>`;
}

function fmtBytes(n) {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + units[i];
}

// A small copy-to-clipboard icon button. Renders "copied" for 2s when clicked.
function copyBtn(text) {
  if (!text) return '';
  return `<button class="copy" data-copy="${esc(text)}" title="Copy to clipboard">⧉</button>`;
}

// A link shown with a copy icon beside it.
function linkWithCopy(url, label) {
  if (!url) return '—';
  return `<a href="${esc(url)}" target="_blank">${esc(label || url)}</a> ${copyBtn(url)}`;
}

// Context bar: shows the super-admin Admin link, an impersonation banner, or a
// staff-access note. Runs on every authenticated page.
async function initCtx() {
  try {
    const w = await api('/whoami');
    window.__me = w; // stashed for the upsell Checkout (email prefill)
    const bar = document.getElementById('ctxbar');
    const adminLink = document.getElementById('nav-admin');
    if (w.isSuperAdmin && adminLink) adminLink.style.display = '';
    // Super-admin global analytics tabs (visible whether or not impersonating).
    if (w.isSuperAdmin) {
      ['nav-visitors', 'nav-traffic'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.style.display = '';
      });
    }

    // Super admin NOT impersonating: tenant pages are inaccessible — hide their tabs
    // and point to the Admin console.
    if (w.isSuperAdmin && !w.impersonating) {
      const keep = ['nav-admin', 'nav-visitors', 'nav-traffic', 'nav-kb'];
      document.querySelectorAll('nav a.tab').forEach((a) => {
        if (!keep.includes(a.id)) a.style.display = 'none';
      });
      if (bar) {
        bar.className = 'ctxbar staff';
        bar.innerHTML = 'You are the <b>super admin</b>. Pick a tenant on the '
          + '<a href="/admin">Admin</a> page to open its workspace.';
      }
      return;
    }

    // Front-door gating: mark paid nav items with a $ and pop an upsell on click
    // instead of navigating. (The server still enforces the gate on save.) Staff
    // don't manage these, so only gate for owners / impersonating super admins.
    if (!w.isStaff) {
      gateNavItem('a.tab[href="/schedules"]', w.alwaysOn, 'scheduler');
      gateNavItem('#nav-team', w.staffAccess, 'staff');
    }

    if (!bar) return;
    if (w.impersonating) {
      bar.className = 'ctxbar on';
      bar.innerHTML = `Viewing tenant <b>${esc(w.impersonating.name)}</b> (${esc(w.impersonating.slug)}) as super admin · `
        + `<a href="#" id="ctx-exit">Exit to Admin</a>`;
      document.getElementById('ctx-exit').onclick = async (e) => {
        e.preventDefault();
        try { await api('/impersonate/stop', { method: 'POST' }); } catch {}
        location.href = '/admin';
      };
    } else if (w.isStaff) {
      bar.className = 'ctxbar staff';
      bar.textContent = `Staff access — ${w.staffPermission === 'view' ? 'read-only' : 'edit'}`;
      // staff cannot manage the team or billing
      const team = document.getElementById('nav-team');
      if (team) team.style.display = 'none';
      const bill = document.getElementById('nav-billing');
      if (bill) bill.style.display = 'none';
    }
  } catch { /* not authenticated or whoami unavailable */ }
}
document.addEventListener('DOMContentLoaded', initCtx);

// Mark a paid nav tab with a $ and intercept its click to show an upsell modal.
function gateNavItem(selector, eligible, feature) {
  const a = document.querySelector(selector);
  if (!a || eligible) return;
  a.dataset.gated = feature;
  if (!a.querySelector('.navlock')) {
    const s = document.createElement('span');
    s.className = 'navlock';
    s.textContent = '$';
    s.title = 'Paid feature';
    a.appendChild(s);
  }
  a.addEventListener('click', (e) => {
    if (a.dataset.gated) { e.preventDefault(); showUpsell(a.dataset.gated); }
  });
}

// Lazily load Razorpay Checkout (only when an upsell is actually opened).
function loadRazorpay() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the payment library.'));
    document.head.appendChild(s);
  });
}

// Open the Always-On subscription Checkout inline (unlocks scheduler + staff).
// Reuses the same /billing/subscribe → confirm path as the Billing page.
async function startAlwaysOnCheckout(btn) {
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = 'Opening…';
  try {
    await loadRazorpay();
    const sub = await api('/billing/subscribe', { method: 'POST' });
    const rzp = new Razorpay({
      key: sub.keyId,
      subscription_id: sub.subscriptionId,
      name: 'AVideoRouter',
      description: 'Always-On subscription',
      prefill: { email: (window.__me && window.__me.email) || '' },
      handler: async (resp) => {
        try {
          await api('/billing/subscription/confirm', { method: 'POST', body: {
            subscription_id: resp.razorpay_subscription_id,
            payment_id: resp.razorpay_payment_id,
            signature: resp.razorpay_signature,
          } });
          toast('Always-On active — scheduler and staff unlocked.');
          const ov = document.getElementById('upsell-ov'); if (ov) ov.style.display = 'none';
          setTimeout(() => location.reload(), 900);
        } catch (e) { toast('Paid, but activation failed: ' + e.message + ' (it will reconcile via webhook).', 'err'); }
      },
      modal: { ondismiss: () => toast('Subscription not completed.', 'warn') },
    });
    rzp.on('payment.failed', (r) => toast('Payment failed: ' + (r.error?.description || 'unknown'), 'err'));
    rzp.open();
  } catch (e) {
    toast(e.message || 'Could not start checkout.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = prev;
  }
}

// Payment prompt shown when a gated nav item is clicked — pops Razorpay Checkout
// inline for the Always-On subscription (with a link to all billing options).
function showUpsell(feature) {
  const msg = feature === 'scheduler'
    ? 'The daily <b>scheduler</b> is an <b>Always-On</b> feature. Subscribe to run automatic transfers on a schedule.'
    : 'Adding <b>staff</b> is an <b>Always-On</b> feature (or unlock it with a ₹1,000+ top-up). Subscribe to add your team.';
  let ov = document.getElementById('upsell-ov');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'upsell-ov';
    ov.innerHTML = '<div class="upsell-box">'
      + '<h3 style="margin:0 0 10px">Unlock with Always-On</h3>'
      + '<div id="upsell-msg" class="muted"></div>'
      + '<div id="upsell-price" style="margin-top:8px; font-weight:600"></div>'
      + '<div style="margin-top:18px; display:flex; gap:8px; justify-content:flex-end; align-items:center">'
      + '<a href="/billing" style="margin-right:auto; font-size:13px">More billing options →</a>'
      + '<button id="upsell-cancel">Not now</button>'
      + '<button class="primary" id="upsell-go">Subscribe &amp; pay</button>'
      + '</div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.style.display = 'none'; });
    ov.querySelector('#upsell-cancel').onclick = () => { ov.style.display = 'none'; };
    ov.querySelector('#upsell-go').onclick = (e) => startAlwaysOnCheckout(e.currentTarget);
  }
  ov.querySelector('#upsell-msg').innerHTML = msg;
  ov.style.display = 'flex';
  // Fill the live price + availability from billing config.
  api('/billing').then((b) => {
    const priceEl = ov.querySelector('#upsell-price');
    const go = ov.querySelector('#upsell-go');
    if (priceEl && b.alwaysOnPricePaise != null) {
      priceEl.textContent = '₹' + (Number(b.alwaysOnPricePaise) / 100).toLocaleString('en-IN') + ' / month · cancel anytime';
    }
    if (go) {
      if (!b.alwaysOnAvailable) { go.disabled = true; go.textContent = 'Payments not enabled'; }
      else { go.disabled = false; go.textContent = 'Subscribe & pay'; }
    }
  }).catch(() => {});
}

// Delegated handler so re-rendered tables keep working. Copies data-copy and
// flashes "copied" on the clicked button for 2 seconds.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const text = btn.getAttribute('data-copy');
  const done = () => {
    const original = btn.innerHTML;
    btn.innerHTML = 'copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = original; btn.classList.remove('copied'); }, 2000);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
});

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('Copy failed', 'err'); }
  document.body.removeChild(ta);
}
