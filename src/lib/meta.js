// Meta Pixel + Conversions API (CAPI) — platform-level, adapted from Assess360's
// meta stack. Fail-soft everywhere: inert until a pixel id + CAPI token are set in
// the super-admin console; any network error is logged and swallowed so it can
// never break a page or a conversion flow.
//
// Dedup contract: send the SAME event_id from the browser pixel (fbq(..,{eventID}))
// and from CAPI for the SAME event_name, and Meta merges them (48h window) — so an
// ad-blocker dropping the pixel never loses the conversion, and a delivered pixel is
// not double-counted.
import crypto from 'node:crypto';
import { getConfigValue, setConfigValue, query } from '../db.js';
import { encrypt, decrypt } from './secrets.js';

export const DEFAULT_GRAPH_API_VERSION = 'v21.0';

// ---------- hashing (SHA-256 hex of normalized PII) ----------
export function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}
const clean = (v) => { if (v == null) return null; const t = String(v).trim(); return t || null; };
export function hashEmail(v) { const c = clean(v); return c ? sha256Hex(c.toLowerCase()) : null; }
export function hashPhone(v) { const c = clean(v); if (!c) return null; const d = c.replace(/\D+/g, ''); return d ? sha256Hex(d) : null; }
export function hashName(v) { const c = clean(v); return c ? sha256Hex(c.toLowerCase()) : null; }
export function hashCityState(v) { const c = clean(v); if (!c) return null; const n = c.toLowerCase().replace(/[^a-z]/g, ''); return n ? sha256Hex(n) : null; }
export function hashCountry(v) { const c = clean(v); if (!c) return null; const n = c.toLowerCase().replace(/[^a-z]/g, '').slice(0, 2); return n.length === 2 ? sha256Hex(n) : null; }
export function hashZip(v) { const c = clean(v); if (!c) return null; const n = c.toLowerCase().replace(/\s+/g, ''); return n ? sha256Hex(n) : null; }

// fbc from the ad-click fbclid: fb.1.<creationMs>.<fbclid>. This is what lets Meta
// ATTRIBUTE a server event to the ad click (email alone is received, not attributed).
export function fbcFromFbclid(fbclid, creationMs = Date.now()) {
  if (!fbclid || typeof fbclid !== 'string') return null;
  return `fb.1.${Math.floor(creationMs)}.${fbclid}`;
}

// ---------- pure event builder (no I/O, unit-testable) ----------
function buildUserData(u = {}) {
  const out = {};
  const em = hashEmail(u.email); if (em) out.em = [em];
  const ph = hashPhone(u.phone); if (ph) out.ph = [ph];
  const fn = hashName(u.firstName); if (fn) out.fn = [fn];
  const ln = hashName(u.lastName); if (ln) out.ln = [ln];
  if (u.clientIpAddress) out.client_ip_address = u.clientIpAddress;
  if (u.clientUserAgent) out.client_user_agent = u.clientUserAgent;
  if (u.fbp) out.fbp = u.fbp;
  if (u.fbc) out.fbc = u.fbc;
  const ct = hashCityState(u.city); if (ct) out.ct = [ct];
  const st = hashCityState(u.state); if (st) out.st = [st];
  const country = hashCountry(u.country); if (country) out.country = [country];
  const zp = hashZip(u.zip); if (zp) out.zp = [zp];
  return out;
}

export function buildCapiEvent(input) {
  const payload = {
    event_name: input.eventName,
    event_time: Math.floor((input.eventTimeMs || Date.now()) / 1000),
    event_id: input.eventId,
    action_source: 'website',
    user_data: buildUserData(input.user),
  };
  if (input.eventSourceUrl) payload.event_source_url = input.eventSourceUrl;
  if (input.customData && Object.keys(input.customData).length > 0) payload.custom_data = input.customData;
  return payload;
}

// Pure config resolution: null = inert (must have BOTH a token and a dataset/pixel).
export function resolveCapiConfig(raw) {
  const accessToken = raw.accessToken || null;
  const datasetId = raw.datasetId || raw.pixelId || null;
  if (!accessToken || !datasetId) return null;
  return {
    accessToken,
    datasetId,
    version: raw.version || DEFAULT_GRAPH_API_VERSION,
    testEventCode: raw.testEventCode || null,
  };
}

// ---------- config (platform-level, stored in app_config) ----------
export async function getMetaConfig() {
  const pixelId = (await getConfigValue('meta_pixel_id')) || '';
  const capiToken = decrypt((await getConfigValue('meta_capi_token')) || '') || '';
  const testEventCode = (await getConfigValue('meta_test_event_code')) || '';
  return { pixelId, capiToken, testEventCode };
}

export async function setMetaConfig({ pixelId, capiToken, testEventCode }) {
  if (pixelId !== undefined) await setConfigValue('meta_pixel_id', String(pixelId).trim());
  if (testEventCode !== undefined) await setConfigValue('meta_test_event_code', String(testEventCode).trim());
  // Only overwrite the token when a non-blank value is provided (keeps it on blank save).
  if (capiToken) await setConfigValue('meta_capi_token', encrypt(String(capiToken).trim()));
}

async function loadConfig() {
  const m = await getMetaConfig();
  return resolveCapiConfig({ accessToken: m.capiToken, datasetId: m.pixelId, pixelId: m.pixelId, testEventCode: m.testEventCode });
}

export async function isCapiConfigured() {
  return (await loadConfig()) !== null;
}

// Cached pixel id (60s) so public pages don't hit the DB on every render.
let pixelCache = { id: '', at: 0 };
export async function getCachedPixelId() {
  if (Date.now() - pixelCache.at < 60000) return pixelCache.id;
  const id = (await getConfigValue('meta_pixel_id')) || '';
  pixelCache = { id, at: Date.now() };
  return id;
}

// The Meta Pixel <head> snippet (base code + PageView). Empty when no pixel is set.
export function pixelHeadHtml(pixelId) {
  if (!pixelId) return '';
  const id = String(pixelId).replace(/[^0-9]/g, '');
  if (!id) return '';
  return `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?`
    + `n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;`
    + `n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;`
    + `t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}`
    + `(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');`
    + `fbq('init','${id}');fbq('track','PageView');</script>`
    + `<noscript><img height="1" width="1" style="display:none" `
    + `src="https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1"/></noscript>`;
}

// ---------- CAPI event log (for the conversions stats panel) ----------
async function logCapiEvent(row) {
  try {
    await query(
      `INSERT INTO capi_events (event_name, event_id, source, http_status, ok, visitor_id, value_paise, currency, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.eventName, row.eventId || null, row.source || 'capi', row.httpStatus ?? null,
        row.ok ?? null, row.visitorId || null, row.valuePaise ?? null, row.currency || null,
        row.error ? String(row.error).slice(0, 400) : null],
    );
  } catch { /* logging is best-effort */ }
}

// ---------- network sender ----------
async function post(cfg, dataEvent, extra = {}) {
  const url = `https://graph.facebook.com/${cfg.version}/${cfg.datasetId}/events?access_token=${encodeURIComponent(cfg.accessToken)}`;
  const body = JSON.stringify({ data: [dataEvent], ...extra });
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
    signal: AbortSignal.timeout(6000),
  });
  return res;
}

// Fire-and-forget production conversion (no test code). Logs to capi_events.
export async function sendCapiEvent(input, meta = {}) {
  const cfg = await loadConfig();
  if (!cfg) return; // inert until configured
  try {
    const res = await post(cfg, buildCapiEvent(input));
    if (!res.ok) console.error(`[meta-capi] ${input.eventName} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    await logCapiEvent({ eventName: input.eventName, eventId: input.eventId, source: 'capi', httpStatus: res.status, ok: res.ok, visitorId: meta.visitorId, valuePaise: meta.valuePaise, currency: input.customData?.currency });
  } catch (e) {
    console.error(`[meta-capi] ${input.eventName} error:`, e.message);
    await logCapiEvent({ eventName: input.eventName, eventId: input.eventId, source: 'capi', ok: false, visitorId: meta.visitorId, error: e.message });
  }
}

// Build the CAPI user-data request context (ip/ua/fbp/fbc) from an Express request.
// Raises match quality + attributes the server event to the ad click via fbc.
export function metaContextFromReq(req) {
  const c = req.cookies || {};
  let fbc = c._fbc || null;
  const fbclid = req.query?.fbclid || null;
  if (!fbc && fbclid) fbc = fbcFromFbclid(String(fbclid));
  const xff = req.headers['x-forwarded-for'];
  const ip = xff ? String(xff).split(',')[0].trim() : (req.ip || null);
  return {
    clientIpAddress: ip || null,
    clientUserAgent: req.headers['user-agent'] || null,
    fbp: c._fbp || null,
    fbc,
  };
}

// Fire the signup conversions server-side (CAPI): CompleteRegistration + Lead.
// eventId is the dedup key shared with the browser pixel (email signup passes it;
// Google OAuth has no pixel at the callback, so CAPI alone carries the conversion).
export async function fireSignupConversions(req, { email, name, eventId, sourceUrl }) {
  const ctx = metaContextFromReq(req);
  const [firstName, ...rest] = String(name || '').trim().split(/\s+/);
  const user = { email, firstName: firstName || null, lastName: rest.join(' ') || null, ...ctx };
  const base = eventId || crypto.randomUUID();
  await sendCapiEvent({ eventName: 'CompleteRegistration', eventId: base, eventTimeMs: Date.now(), eventSourceUrl: sourceUrl, user });
  await sendCapiEvent({ eventName: 'Lead', eventId: `lead-${base}`, eventTimeMs: Date.now(), eventSourceUrl: sourceUrl, user });
}

// Diagnostic: send a real test event and RETURN Meta's actual response (Test Events tab).
export async function testCapi(testEventCode) {
  const cfg = await loadConfig();
  if (!cfg) return { ok: false, error: 'Meta CAPI is not configured — set the Pixel ID and CAPI token first.' };
  const code = (testEventCode && String(testEventCode).trim()) || cfg.testEventCode;
  try {
    const res = await post(cfg,
      buildCapiEvent({ eventName: 'PageView', eventId: `capitest-${Math.floor(Date.now() / 1000)}`, eventTimeMs: Date.now(), user: { email: 'capi-test@avideorouter.local' } }),
      code ? { test_event_code: code } : {});
    return { ok: res.ok, datasetId: cfg.datasetId, status: res.status, response: (await res.text()).slice(0, 800) };
  } catch (e) {
    return { ok: false, datasetId: cfg.datasetId, error: e.message };
  }
}
