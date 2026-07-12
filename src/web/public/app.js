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
