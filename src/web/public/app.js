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

// ---------- icons (UI-STRICTURES.md §6) ----------
// Lucide paths, 16px in controls and 20px in nav rows, stroke 1.75. No icon is a
// text character and no emoji appears in the UI, so every tick, cross, arrow and
// eye in the product comes from here.
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'external-link': '<path d="M15 3h6v6"/><path d="M10 14 21 3"/>'
    + '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M10.7 5.1A7 7 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-2.2 3.1"/>'
    + '<path d="M6.6 6.6A18 18 0 0 0 2 12s3.6 7 10 7a9 9 0 0 0 3.9-.9"/>'
    + '<path d="m2 2 20 20"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/>'
    + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/>'
    + '<path d="M5.4 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.4-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.8 1.1Z"/>',
  'alert-triangle': '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>'
    + '<path d="M12 9v4"/><path d="M12 17h.01"/>',
};
// `name` must be a key above; `cls` adds sizing such as 'icon-20'.
function icon(name, cls) {
  const d = ICONS[name];
  if (!d) return '';
  return `<svg class="icon${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
}
// A tick or dash for a boolean table cell, with a label for screen readers.
function boolCell(on, labels) {
  const [yes, no] = labels || ['yes', 'no'];
  return on
    ? `<span class="ok-mark" title="${esc(yes)}">${icon('check')}<span class="sr-only">${esc(yes)}</span></span>`
    : `<span class="meta" title="${esc(no)}">—</span>`;
}

// ---------- dates ----------
// Everything a person reads is DD-MM-YYYY (plus HH:MM, 24-hour, when the time
// matters) in IST, computed from a fixed +05:30 offset. The browser's locale and
// timezone are never trusted: toLocaleString() with no locale renders US order
// for most visitors and on the server. Machine-facing fields stay ISO-8601 UTC.
const IST_OFFSET_MIN = 330;
function istParts(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const t = new Date(d.getTime() + IST_OFFSET_MIN * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    dd: p(t.getUTCDate()), mm: p(t.getUTCMonth() + 1), yyyy: t.getUTCFullYear(),
    hh: p(t.getUTCHours()), mi: p(t.getUTCMinutes()),
  };
}
function fmtDate(iso) {
  if (!iso) return '—';
  const p = istParts(iso);
  return p ? `${p.dd}-${p.mm}-${p.yyyy} ${p.hh}:${p.mi}` : '—';
}
function fmtDateOnly(iso) {
  if (!iso) return '—';
  const p = istParts(iso);
  return p ? `${p.dd}-${p.mm}-${p.yyyy}` : '—';
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
