// Visitor & traffic capture middleware.
//
// Runs on every request but records ONLY anonymous public traffic: any request
// carrying a session cookie (a logged-in user) is skipped entirely, as are
// assets and API/plumbing paths. Recording is fire-and-forget on response
// 'finish' so tracking can never delay or break a page.
import crypto from 'node:crypto';
import { query } from '../db.js';
import { logError } from '../lib/logger.js';

const VID_COOKIE = 'vr_vid';
const VID_MAXAGE = 2 * 365 * 24 * 3600 * 1000; // 2 years

// Requests never logged: static assets, health checks, and API/oauth/dbadmin plumbing.
const SKIP_PREFIXES = ['/public/', '/api/', '/oauth/', '/oauth', '/dbadmin', '/health', '/favicon'];

const str = (v) => {
  if (v == null) return null;
  const s = String(v).slice(0, 512);
  return s || null;
};

// Marketing/public sections, grouped in the order the Traffic view lists them.
// NOTE: the KB prefixes are forward-looking (public KB ships in help-kb-plan
// phases 2–3); classification already routes them so no change is needed then.
export function classifySection(path) {
  if (path === '/') return 'landing';
  if (/^\/(kb|help|guide|video-analytics-guide)(\/|$)/i.test(path)) return 'kb';
  if (/^\/(privacy|terms|refund|shipping|contact)(\/|$)/i.test(path)) return 'legal';
  if (/^\/embed\//i.test(path)) return 'embed';
  return 'other';
}

const BOT_UA = /(bot|crawl|spider|slurp|bing|google|yandex|baidu|duckduck|semrush|ahrefs|mj12|dotbot|petal|facebookexternalhit|curl|wget|python-requests|python-httpx|go-http|java\/|libwww|scrapy|headless|phantom|masscan|zgrab|nmap)/i;
const SCANNER_PATH = /(\.env|\.git|\.aws|\.ssh|\.DS_Store|_profiler|wp-|phpmyadmin|\.php(\?|$)|xmlrpc|\/config(\b|\.)|credentials|id_rsa)/i;

function classifyBot(ua, path) {
  if (SCANNER_PATH.test(path)) return { isBot: true, kind: 'scanner' };
  if (!ua) return { isBot: true, kind: 'ua' };
  if (BOT_UA.test(ua)) return { isBot: true, kind: 'crawler' };
  return { isBot: false, kind: null };
}

function parseUA(ua) {
  ua = ua || '';
  let browser = 'Other', os = 'Other', device = 'desktop';
  if (/mobile|iphone|android.*mobile/i.test(ua)) device = 'mobile';
  else if (/ipad|tablet|android/i.test(ua)) device = 'tablet';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera';
  else if (/chrome\//i.test(ua)) browser = 'Chrome';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';
  else if (/safari\//i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari';
  if (/windows/i.test(ua)) os = 'Windows';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ios/i.test(ua)) os = 'iOS';
  else if (/linux/i.test(ua)) os = 'Linux';
  return { browser, os, device };
}

// --- geo: edge headers first (zero cost), cached external lookup as fallback ---
const HEADER_COUNTRY = ['cf-ipcountry', 'x-vercel-ip-country', 'x-country-code', 'x-appengine-country'];
const HEADER_CITY = ['x-vercel-ip-city', 'cf-ipcity', 'x-appengine-city'];

function headerGeo(req) {
  let country = null, city = null;
  for (const h of HEADER_COUNTRY) {
    const v = req.headers[h];
    if (v && v !== 'XX') { country = String(v).toUpperCase().slice(0, 2); break; }
  }
  for (const h of HEADER_CITY) {
    const v = req.headers[h];
    if (v) { try { city = decodeURIComponent(String(v)); } catch { city = String(v); } break; }
  }
  return { country, city };
}

const geoCache = new Map(); // ip -> { country, city }
const GEO_CACHE_MAX = 5000;
const PRIVATE_IP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd|169\.254\.)/i;

async function enrichGeo(ip, hitId, visitorId) {
  if (!ip || PRIVATE_IP.test(ip) || geoCache.has(ip)) return;
  try {
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode,city`,
      { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    if (j.status !== 'success') return;
    const geo = { country: j.countryCode || null, city: j.city || null };
    if (geoCache.size >= GEO_CACHE_MAX) geoCache.clear(); // bound memory under bot floods
    geoCache.set(ip, geo);
    if (geo.country) {
      await query('UPDATE page_hits SET country = COALESCE(country,$1), city = COALESCE(city,$2) WHERE id = $3',
        [geo.country, geo.city, hitId]);
      if (visitorId) {
        await query('UPDATE visitors SET country = COALESCE(country,$1), city = COALESCE(city,$2) WHERE visitor_id = $3',
          [geo.country, geo.city, visitorId]);
      }
    }
  } catch { /* geo is best-effort */ }
}

function cachedGeo(ip) {
  return (ip && geoCache.get(ip)) || null;
}

// Wake detection: Railway restarts the container on wake-from-sleep, so the first
// trackable request after boot is the one that woke the app.
let wakeCaptured = false;

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

function isTrackable(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false; // page views only
  const p = req.path || '';
  return !SKIP_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

export function trackMiddleware(sessionCookieName) {
  return (req, res, next) => {
    try {
      if (req.cookies?.[sessionCookieName]) return next(); // logged-in: never logged
      if (!isTrackable(req)) return next();
      setupHit(req, res);
    } catch (e) { logError('track:', e); }
    next();
  };
}

function setupHit(req, res) {
  const ua = req.headers['user-agent'] || '';
  const path = req.path;
  const section = classifySection(path);
  const { isBot, kind } = classifyBot(ua, path);
  const { browser, os, device } = parseUA(ua);
  const ip = clientIp(req);
  const geo = headerGeo(req);
  if (!geo.country) { const c = cachedGeo(ip); if (c) { geo.country = c.country; geo.city = geo.city || c.city; } }
  const q = req.query || {};
  const c = req.cookies || {};

  // Anonymous visitor cookie — humans only (bots don't retain cookies).
  let visitorId = c[VID_COOKIE] || null;
  if (!visitorId && !isBot) {
    visitorId = crypto.randomUUID();
    res.cookie(VID_COOKIE, visitorId, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: VID_MAXAGE });
  }

  const hit = {
    visitorId,
    path,
    method: req.method,
    section,
    isBot,
    kind,
    ip,
    ua,
    browser,
    os,
    device: isBot ? 'bot' : device,
    referrer: str(req.headers.referer || req.headers.referrer),
    country: geo.country,
    city: geo.city,
    utm_source: str(q.utm_source), utm_medium: str(q.utm_medium), utm_campaign: str(q.utm_campaign),
    utm_term: str(q.utm_term), utm_content: str(q.utm_content),
    fbclid: str(q.fbclid), gclid: str(q.gclid),
    fbc: str(c._fbc), fbp: str(c._fbp),
    isWake: !wakeCaptured,
  };
  if (hit.isWake) wakeCaptured = true;

  res.on('finish', () => {
    hit.status = res.statusCode;
    insertHit(hit).catch((e) => logError('track insert:', e));
  });
}

async function insertHit(h) {
  const { rows } = await query(
    `INSERT INTO page_hits
       (visitor_id, path, method, status, section, is_bot, bot_kind, is_wake, ip, ua_raw,
        browser, os, device_type, referrer, country, city,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content, fbclid, gclid, fbc, fbp)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     RETURNING id`,
    [h.visitorId, h.path, h.method, h.status, h.section, h.isBot, h.kind, h.isWake, h.ip, h.ua,
     h.browser, h.os, h.device, h.referrer, h.country, h.city,
     h.utm_source, h.utm_medium, h.utm_campaign, h.utm_term, h.utm_content, h.fbclid, h.gclid, h.fbc, h.fbp],
  );
  const hitId = rows[0].id;

  // First-touch attribution: fill visitor fields only if still NULL.
  if (h.visitorId && !h.isBot) {
    await query(
      `INSERT INTO visitors
         (visitor_id, first_seen, last_seen, hits, landing_path, referrer,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content, fbclid, gclid, fbc, fbp,
          ip, ua_raw, browser, os, device_type, country, city)
       VALUES ($1, now(), now(), 1, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (visitor_id) DO UPDATE SET
         last_seen = now(),
         hits = visitors.hits + 1,
         landing_path = COALESCE(visitors.landing_path, EXCLUDED.landing_path),
         referrer     = COALESCE(visitors.referrer, EXCLUDED.referrer),
         utm_source   = COALESCE(visitors.utm_source, EXCLUDED.utm_source),
         utm_medium   = COALESCE(visitors.utm_medium, EXCLUDED.utm_medium),
         utm_campaign = COALESCE(visitors.utm_campaign, EXCLUDED.utm_campaign),
         utm_term     = COALESCE(visitors.utm_term, EXCLUDED.utm_term),
         utm_content  = COALESCE(visitors.utm_content, EXCLUDED.utm_content),
         fbclid       = COALESCE(visitors.fbclid, EXCLUDED.fbclid),
         gclid        = COALESCE(visitors.gclid, EXCLUDED.gclid),
         fbc          = COALESCE(visitors.fbc, EXCLUDED.fbc),
         fbp          = COALESCE(visitors.fbp, EXCLUDED.fbp),
         country      = COALESCE(visitors.country, EXCLUDED.country),
         city         = COALESCE(visitors.city, EXCLUDED.city)`,
      [h.visitorId, h.path, h.referrer,
       h.utm_source, h.utm_medium, h.utm_campaign, h.utm_term, h.utm_content, h.fbclid, h.gclid, h.fbc, h.fbp,
       h.ip, h.ua, h.browser, h.os, h.device, h.country, h.city],
    );
  }

  if (h.isWake) {
    await query(
      `INSERT INTO wake_events (waker_path, ip, ua_raw, is_bot, bot_kind, country)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [h.path, h.ip, h.ua, h.isBot, h.kind, h.country],
    );
  }

  // No edge-header country and a public IP: resolve once, cache, backfill the row.
  if (!h.country && !h.isBot && h.ip) enrichGeo(h.ip, hitId, h.visitorId);
}

// Client beacon: confirms the visitor's most recent hit as definitely human and
// attaches viewport / timezone / Meta cookies. Called by the public POST /api/track.
export async function recordBeacon(req) {
  const vid = req.cookies?.[VID_COOKIE];
  if (!vid) return; // no visitor cookie → nothing to attach (bot, or cookies blocked)
  const b = req.body || {};
  const screen = str(b.screen);
  const tz = str(b.tz);
  const fbc = str(req.cookies?._fbc);
  const fbp = str(req.cookies?._fbp);
  await query(
    `UPDATE page_hits
        SET human_confirmed = true, is_bot = false, bot_kind = NULL,
            screen = COALESCE(screen, $2), tz = COALESCE(tz, $3),
            fbc = COALESCE(fbc, $4), fbp = COALESCE(fbp, $5)
      WHERE id = (SELECT id FROM page_hits WHERE visitor_id = $1 ORDER BY ts DESC LIMIT 1)`,
    [vid, screen, tz, fbc, fbp],
  );
  await query(
    `UPDATE visitors
        SET human_confirmed = true,
            screen = COALESCE(screen, $2), tz = COALESCE(tz, $3),
            fbc = COALESCE(fbc, $4), fbp = COALESCE(fbp, $5)
      WHERE visitor_id = $1`,
    [vid, screen, tz, fbc, fbp],
  );
}
