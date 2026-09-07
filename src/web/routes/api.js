import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import cron from 'node-cron';
import cronParser from 'cron-parser';
import {
  query, getTenants, getTenantById, getTenantSettings, setTenantSetting,
  getConfigValue, setConfigValue,
} from '../../db.js';
import { encrypt } from '../../lib/secrets.js';
import {
  requireApiAuth, resolveTenant, requireTenant, requireSuperAdmin, requireOwner,
  updateAccount, setSessionCookie, setImpersonation, clearImpersonation,
  listTenantUsers, createStaff, updateStaff, resetStaffPassword, deleteStaff, hashPassword,
} from '../auth.js';
import { runPipeline, isRunning } from '../../pipeline/run.js';
import { enqueuePush, getJobs } from '../../pipeline/manual.js';
import { ingestTempPath } from '../../pipeline/download.js';
import { reloadSchedules, getSchedules } from '../../scheduler.js';
import * as zoom from '../../providers/zoom.js';
import * as fathom from '../../providers/fathom.js';
import * as lms from '../../providers/lms.js';
import { getChannels, getChannelById, getVideoSnippet, updateVideoSnippet } from '../../providers/youtube.js';
import { canDeleteZoomSource } from '../../pipeline/states.js';
import { config } from '../../config.js';
import { log, logError } from '../../lib/logger.js';
import * as billing from '../../billing.js';
import * as meta from '../../lib/meta.js';
import * as mailer from '../../lib/mailer.js';

export const apiRouter = express.Router();
apiRouter.use(requireApiAuth, resolveTenant);

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ============================================================
// Super-admin endpoints (no tenant context required)
// ============================================================

apiRouter.get('/whoami', wrap(async (req, res) => {
  let impersonating = null;
  if (req.user.isSuperAdmin && req.tenantId) {
    const t = await getTenantById(req.tenantId);
    impersonating = t ? { id: t.id, slug: t.slug, name: t.name } : null;
  }
  // Feature eligibility for front-door gating of the nav (scheduler = Always-On;
  // staff = Always-On or a ₹1,000+ top-up). Only meaningful with a tenant context.
  const wallet = req.tenantId ? await billing.getWallet(req.tenantId) : null;
  const alwaysOn = billing.isAlwaysOn(wallet);
  const staffAccess = req.tenantId ? await billing.canUseStaff(req.tenantId) : false;
  res.json({
    email: req.user.email,
    role: req.user.role,
    isSuperAdmin: req.user.isSuperAdmin,
    isStaff: req.user.isStaff,
    staffPermission: req.user.staffPermission,
    tenantId: req.tenantId,
    impersonating,
    alwaysOn,       // scheduler eligibility
    staffAccess,    // staff-seat eligibility
  });
}));

// Super-admin dashboard — read-only across all tenants.
apiRouter.get('/tenants', requireSuperAdmin, wrap(async (_req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.slug, t.name, t.status, t.created_at,
            t.signup_utm_source, t.signup_utm_medium, t.signup_utm_campaign,
            t.signup_referrer, t.signup_landing_path, t.signup_ua, t.signup_ip,
            t.signup_browser, t.signup_os, t.signup_device,
            t.signup_country, t.signup_city,
            w.balance_paise, w.free_upload_used, w.unlimited,
            (SELECT COALESCE(SUM(wt.units), 0) FROM wallet_txns wt
               WHERE wt.tenant_id = t.id AND wt.type = 'deduction')::numeric AS used_units,
            (SELECT u.email FROM users u WHERE u.tenant_id = t.id AND u.staff_permission IS NULL
               AND u.deleted_at IS NULL ORDER BY u.id LIMIT 1) AS owner_email,
            (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.deleted_at IS NULL)::int AS users,
            (SELECT count(*) FROM processed_recordings p WHERE p.tenant_id = t.id AND p.youtube_video_id IS NOT NULL)::int AS uploaded,
            (SELECT COALESCE(SUM(p.file_size_bytes), 0) FROM processed_recordings p
               WHERE p.tenant_id = t.id AND p.youtube_video_id IS NOT NULL)::bigint AS uploaded_bytes,
            (SELECT count(*) FROM youtube_channels c WHERE c.tenant_id = t.id AND c.refresh_token IS NOT NULL)::int AS channels
     FROM tenants t
     LEFT JOIN wallets w ON w.tenant_id = t.id
     ORDER BY t.id`,
  );
  // Add the effective unit balance (credit + pending free upload) at the base rate.
  const cfg = await billing.getBillingConfig();
  res.json(rows.map((r) => ({
    ...r,
    units: billing.unitsBalance(r, cfg), // null = unmetered
  })));
}));

// READ-ONLY usage audit. The "Used" figure is SUM(wallet_txns.units) for
// deductions, but pre-017 rows stored whole-GB CEIL values (migration 016
// unmetered backfill, and old metered charges), so Used is inflated and the GB
// wallet was over-drained. This recomputes what each deduction SHOULD be from the
// linked recording's actual bytes and reports the per-tenant GB gap and the GB to
// restore to the wallet. This is GB-only — NO money is refunded; the credit just
// stays in the GB wallet. Nothing is written here; correction is a separate,
// explicitly-clicked action once these numbers are reviewed.
//
//   correctable row = a deduction whose recording's file_size_bytes is known.
//   Rows with unknown bytes are left unchanged (contribute zero delta).
//   GB to restore = old GB counted − actual GB (from bytes).
apiRouter.get('/admin/usage-audit', requireSuperAdmin, wrap(async (_req, res) => {
  const cfg = await billing.getBillingConfig();
  const { rows } = await query(
    `WITH d AS (
       SELECT wt.tenant_id,
              wt.units AS old_units,
              (p.file_size_bytes IS NOT NULL) AS has_bytes,
              CASE WHEN p.file_size_bytes IS NOT NULL
                   THEN p.file_size_bytes::numeric / $1
                   ELSE wt.units END AS actual_units
       FROM wallet_txns wt
       LEFT JOIN processed_recordings p ON p.id = wt.recording_id
       WHERE wt.type = 'deduction'
     )
     SELECT t.id, t.slug, t.name,
            COALESCE(w.unlimited, false) AS unlimited,
            w.balance_paise,
            count(d.*)::int                            AS deduction_rows,
            count(d.*) FILTER (WHERE d.has_bytes)::int AS correctable_rows,
            COALESCE(SUM(d.old_units), 0)::numeric     AS current_used_units,
            COALESCE(SUM(d.actual_units), 0)::numeric  AS actual_used_units
     FROM tenants t
     LEFT JOIN wallets w ON w.tenant_id = t.id
     LEFT JOIN d ON d.tenant_id = t.id
     GROUP BY t.id, t.slug, t.name, w.unlimited, w.balance_paise
     ORDER BY t.id`,
    [cfg.unitBytes],
  );
  // GB balance is derived from the wallet at the base ₹/GB rate. Restoring the
  // over-counted GB raises the remaining GB credit — no cash movement.
  const rate = cfg.pricePerUnitPaise;
  const tenants = rows.map((r) => {
    const currentUsed = Number(r.current_used_units);
    const actualUsed = Number(r.actual_used_units);
    const restoreGb = Math.max(0, currentUsed - actualUsed);
    const currentGb = r.unlimited ? null : Number(r.balance_paise || 0) / rate;
    return {
      id: r.id, slug: r.slug, name: r.name, unlimited: r.unlimited,
      deduction_rows: r.deduction_rows, correctable_rows: r.correctable_rows,
      current_used_units: currentUsed,
      actual_used_units: actualUsed,
      restore_units: restoreGb,
      current_balance_units: currentGb,
      proposed_balance_units: r.unlimited ? null : currentGb + restoreGb,
    };
  });
  res.json({
    unitBytes: cfg.unitBytes,
    totals: { restore_units: tenants.reduce((s, t) => s + t.restore_units, 0) },
    tenants,
  });
}));

// NOTE: register the static /impersonate/stop BEFORE the parameterized
// /impersonate/:id — otherwise ':id' captures "stop" and exit-to-admin 404s
// (Number('stop') === NaN) and never clears the impersonation cookie.
apiRouter.post('/impersonate/stop', requireSuperAdmin, wrap(async (_req, res) => {
  clearImpersonation(res);
  res.json({ ok: true });
}));

apiRouter.post('/impersonate/:id', requireSuperAdmin, wrap(async (req, res) => {
  const t = await getTenantById(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'tenant not found' });
  setImpersonation(res, t.id);
  res.json({ ok: true, tenant: { id: t.id, slug: t.slug, name: t.name } });
}));

// Super-admin: directly set a tenant OWNER's password (recovery for a locked-out
// self-serve owner). Targets the role=admin, non-staff user of the tenant.
apiRouter.post('/admin/tenants/:id/owner-password', requireSuperAdmin, wrap(async (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const { rows } = await query(
    `SELECT email FROM users WHERE tenant_id = $1 AND staff_permission IS NULL AND deleted_at IS NULL
     ORDER BY id LIMIT 1`,
    [Number(req.params.id)],
  );
  if (!rows[0]) return res.status(404).json({ error: 'No owner found for this tenant.' });
  await query(
    'UPDATE users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE email = $2',
    [await hashPassword(pw), rows[0].email],
  );
  res.json({ ok: true, email: rows[0].email });
}));

// ---------- super-admin analytics: Visitors + Traffic (global) ----------

// Only a fixed set of windows is allowed, so interpolating it into the interval
// literal below is safe (never user text).
function rangeDays(req) {
  const n = Number(req.query.range);
  return [7, 30, 90, 180].includes(n) ? n : 30;
}
// Marketing/public sections that count as real visitor traffic (excludes 'other':
// scanner probes and unknown paths).
const MARKETING = `section IN ('landing','kb','legal','embed')`;

// Feature A — Visitors: human ad-attribution across public/marketing pages only.
apiRouter.get('/analytics/visitors', requireSuperAdmin, wrap(async (req, res) => {
  const days = rangeDays(req);
  const since = `ts >= now() - interval '${days} days'`;
  const base = `FROM page_hits WHERE ${since} AND ${MARKETING}`;
  const human = `${base} AND is_bot = false`;

  const [cards, utm, camp, country, device] = await Promise.all([
    query(`SELECT
        count(*) FILTER (WHERE is_bot = false)::int AS human_views,
        count(DISTINCT visitor_id) FILTER (WHERE is_bot = false)::int AS unique_humans,
        count(*) FILTER (WHERE is_bot = true)::int  AS bot_views,
        count(*) FILTER (WHERE is_bot = false AND fbclid IS NOT NULL)::int AS from_fb
      ${base}`),
    query(`SELECT COALESCE(NULLIF(utm_source,''),'(none)') AS k, count(*)::int AS n
      ${human} GROUP BY 1 ORDER BY n DESC LIMIT 12`),
    query(`SELECT COALESCE(NULLIF(utm_campaign,''),'(none)') AS k, count(*)::int AS n
      ${human} GROUP BY 1 ORDER BY n DESC LIMIT 12`),
    query(`SELECT COALESCE(country,'(unknown)') AS k, count(*)::int AS n
      ${human} GROUP BY 1 ORDER BY n DESC LIMIT 15`),
    query(`SELECT COALESCE(device_type,'?') AS k, count(*)::int AS n
      ${human} GROUP BY 1 ORDER BY n DESC`),
  ]);
  res.json({
    days,
    cards: cards.rows[0],
    byUtmSource: utm.rows,
    byCampaign: camp.rows,
    byCountry: country.rows,
    byDevice: device.rows,
  });
}));

// Recent human visitors with full attribution (the detailed per-visit log).
apiRouter.get('/analytics/visitors/recent', requireSuperAdmin, wrap(async (req, res) => {
  const days = rangeDays(req);
  const { rows } = await query(
    `SELECT first_seen, last_seen, hits, landing_path, referrer,
            utm_source, utm_medium, utm_campaign, utm_term, utm_content,
            fbclid, gclid, fbc, fbp, ip, browser, os, device_type, country, city,
            screen, tz, human_confirmed
       FROM visitors
      WHERE last_seen >= now() - interval '${days} days'
      ORDER BY last_seen DESC LIMIT 200`,
  );
  res.json({ visitors: rows });
}));

// Feature B — Traffic: every server-side hit (humans + bots), grouped per link, + wake log.
apiRouter.get('/analytics/traffic', requireSuperAdmin, wrap(async (req, res) => {
  const days = rangeDays(req);
  const since = `ts >= now() - interval '${days} days'`;
  const [totals, links, wakes] = await Promise.all([
    query(`SELECT count(*)::int AS total,
             count(*) FILTER (WHERE is_bot = false)::int AS human,
             count(*) FILTER (WHERE is_bot = true)::int  AS bot
           FROM page_hits WHERE ${since}`),
    query(`SELECT path, min(section) AS section,
             count(*)::int AS total,
             count(*) FILTER (WHERE is_bot = false)::int AS human,
             count(*) FILTER (WHERE is_bot = true)::int  AS bot,
             max(ts) AS last_hit
           FROM page_hits WHERE ${since}
           GROUP BY path ORDER BY total DESC LIMIT 500`),
    query(`SELECT ts, waker_path, ip, ua_raw, is_bot, bot_kind, country
           FROM wake_events WHERE ${since} ORDER BY ts DESC LIMIT 100`),
  ]);
  res.json({ days, totals: totals.rows[0], links: links.rows, wakes: wakes.rows });
}));

// ---------- super-admin billing controls ----------

// Platform billing config + whether Razorpay is wired (never returns secrets).
apiRouter.get('/admin/billing/config', requireSuperAdmin, wrap(async (_req, res) => {
  const c = await billing.getBillingConfig();
  res.json({
    provider: c.provider,
    providers: billing.PROVIDERS,
    liveProviders: billing.LIVE_PROVIDERS,
    configured: Boolean(c.razorpayKeyId && c.razorpayKeySecret),
    hasWebhookSecret: Boolean(c.razorpayWebhookSecret),
    keyId: c.razorpayKeyId || '',
    pricePerUnitPaise: c.pricePerUnitPaise,
    unitBytes: c.unitBytes,
    gstPercent: c.gstPercent,
    gatewayPercent: c.gatewayPercent,
    minTopupPaise: c.minTopupPaise,
    alwaysOnPlanId: c.alwaysOnPlanId || '',
    alwaysOnPricePaise: c.alwaysOnPricePaise,
  });
}));

// Configure the Always-On subscription plan (created in the Razorpay dashboard).
apiRouter.post('/admin/billing/always-on', requireSuperAdmin, wrap(async (req, res) => {
  try {
    await billing.setAlwaysOnPlan(req.body.plan_id, req.body.price_paise);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
}));

// Choose the active gateway (razorpay live; easebuzz/phonepe pending adapters).
apiRouter.post('/admin/billing/provider', requireSuperAdmin, wrap(async (req, res) => {
  try {
    await billing.setPaymentProvider(req.body.provider);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
}));

// Meta Pixel + CAPI (platform-level ad tracking) config.
apiRouter.get('/admin/meta', requireSuperAdmin, wrap(async (_req, res) => {
  const m = await meta.getMetaConfig();
  res.json({
    pixelId: m.pixelId,
    hasToken: Boolean(m.capiToken),
    testEventCode: m.testEventCode,
    configured: await meta.isCapiConfigured(),
  });
}));

apiRouter.post('/admin/meta', requireSuperAdmin, wrap(async (req, res) => {
  await meta.setMetaConfig({
    pixelId: req.body.pixel_id,
    capiToken: req.body.capi_token,          // blank keeps the stored token
    testEventCode: req.body.test_event_code,
  });
  res.json({ ok: true });
}));

// Send a real test event and surface Meta's actual response (Events Manager → Test Events).
apiRouter.post('/admin/meta/test', requireSuperAdmin, wrap(async (req, res) => {
  res.json(await meta.testCapi(req.body.test_event_code));
}));

// Google Sign-In OAuth client (for self-serve signup). Secret stored encrypted.
apiRouter.get('/admin/google', requireSuperAdmin, wrap(async (_req, res) => {
  res.json({
    clientId: (await getConfigValue('google_client_id')) || '',
    hasSecret: Boolean(await getConfigValue('google_client_secret')),
  });
}));
apiRouter.post('/admin/google', requireSuperAdmin, wrap(async (req, res) => {
  if (req.body.client_id !== undefined) await setConfigValue('google_client_id', String(req.body.client_id).trim());
  if (req.body.client_secret) await setConfigValue('google_client_secret', encrypt(String(req.body.client_secret).trim()));
  res.json({ ok: true });
}));

// Platform-owned YouTube OAuth app — one app for ALL tenants, so clients connect
// a channel with a single click (no Google Cloud project of their own). Secret
// stored encrypted.
apiRouter.get('/admin/youtube', requireSuperAdmin, wrap(async (_req, res) => {
  res.json({
    clientId: (await getConfigValue('youtube_client_id')) || '',
    hasSecret: Boolean(await getConfigValue('youtube_client_secret')),
  });
}));
apiRouter.post('/admin/youtube', requireSuperAdmin, wrap(async (req, res) => {
  if (req.body.client_id !== undefined) await setConfigValue('youtube_client_id', String(req.body.client_id).trim());
  if (req.body.client_secret) await setConfigValue('youtube_client_secret', encrypt(String(req.body.client_secret).trim()));
  res.json({ ok: true });
}));

// Platform-owned Zoom OAuth app — one app for ALL tenants, so clients connect
// Zoom with a single consent (no per-client Server-to-Server app). Secret encrypted.
apiRouter.get('/admin/zoom', requireSuperAdmin, wrap(async (_req, res) => {
  res.json({
    clientId: (await getConfigValue('zoom_client_id')) || '',
    hasSecret: Boolean(await getConfigValue('zoom_client_secret')),
  });
}));
apiRouter.post('/admin/zoom', requireSuperAdmin, wrap(async (req, res) => {
  if (req.body.client_id !== undefined) await setConfigValue('zoom_client_id', String(req.body.client_id).trim());
  if (req.body.client_secret) await setConfigValue('zoom_client_secret', encrypt(String(req.body.client_secret).trim()));
  res.json({ ok: true });
}));

// Platform email (Gmail app password) — sends account emails like password resets.
apiRouter.get('/admin/email', requireSuperAdmin, wrap(async (_req, res) => {
  res.json({
    from: (await getConfigValue('platform_email_from')) || '',
    fromName: (await getConfigValue('platform_email_from_name')) || '',
    host: (await getConfigValue('platform_email_host')) || '',
    port: Number(await getConfigValue('platform_email_port')) || '',
    security: (await getConfigValue('platform_email_secure')) || '',
    username: (await getConfigValue('platform_email_user')) || '',
    hasPassword: Boolean(await getConfigValue('platform_email_app_password')),
    zeptoRegion: (await getConfigValue('platform_email_zepto_region')) || 'in',
    hasZeptoToken: Boolean(await getConfigValue('platform_email_zepto_token')),
  });
}));
apiRouter.post('/admin/email', requireSuperAdmin, wrap(async (req, res) => {
  const set = async (k, v) => { if (v !== undefined) await setConfigValue(k, String(v).trim()); };
  await set('platform_email_from', req.body.from);
  await set('platform_email_from_name', req.body.from_name);
  await set('platform_email_host', req.body.host);
  await set('platform_email_port', req.body.port);
  await set('platform_email_secure', req.body.security);
  await set('platform_email_user', req.body.username);
  await set('platform_email_zepto_region', req.body.zepto_region);
  if (req.body.app_password) await setConfigValue('platform_email_app_password', encrypt(String(req.body.app_password).trim()));
  if (req.body.zepto_token) await setConfigValue('platform_email_zepto_token', encrypt(String(req.body.zepto_token).trim()));
  res.json({ ok: true });
}));
// Send a test email to the From address so the operator can confirm SMTP works.
apiRouter.post('/admin/email/test', requireSuperAdmin, wrap(async (_req, res) => {
  try {
    const to = (await getConfigValue('platform_email_from')) || '';
    if (!to) return res.status(400).json({ error: 'Set the From address first.' });
    const r = await mailer.testPlatformMail(to);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message, used: e.used }); }
}));

// Conversions panel (super admin): CAPI config status + recent server events + counts.
apiRouter.get('/analytics/conversions', requireSuperAdmin, wrap(async (req, res) => {
  const days = [7, 30, 90, 180].includes(Number(req.query.range)) ? Number(req.query.range) : 30;
  const since = `ts >= now() - interval '${days} days'`;
  const [cfg, counts, recent] = await Promise.all([
    meta.getMetaConfig(),
    query(`SELECT event_name, count(*)::int AS n, count(*) FILTER (WHERE ok)::int AS ok_n
           FROM capi_events WHERE ${since} GROUP BY event_name ORDER BY n DESC`),
    query(`SELECT ts, event_name, source, http_status, ok, value_paise, currency, error
           FROM capi_events WHERE ${since} ORDER BY ts DESC LIMIT 100`),
  ]);
  res.json({
    days,
    pixelConfigured: Boolean(cfg.pixelId),
    capiConfigured: await meta.isCapiConfigured(),
    pixelId: cfg.pixelId,
    byEvent: counts.rows,
    recent: recent.rows,
  });
}));

// Landing-page hero video (embed URL, e.g. a VidaPulse embed). Read live by the
// public landing page — change it here anytime, no code edit / redeploy.
apiRouter.get('/admin/landing', requireSuperAdmin, wrap(async (_req, res) => {
  res.json({ videoUrl: (await getConfigValue('landing_video_url')) || '' });
}));

apiRouter.post('/admin/landing', requireSuperAdmin, wrap(async (req, res) => {
  await setConfigValue('landing_video_url', String(req.body.video_url || '').trim());
  res.json({ ok: true });
}));

// Set/rotate Razorpay keys (stored encrypted in app_config; no redeploy needed).
apiRouter.post('/admin/billing/keys', requireSuperAdmin, wrap(async (req, res) => {
  await billing.saveRazorpayKeys({
    keyId: req.body.key_id, keySecret: req.body.key_secret, webhookSecret: req.body.webhook_secret,
  });
  res.json({ ok: true });
}));

// Manually credit/debit a tenant wallet (paise, signed).
apiRouter.post('/admin/tenants/:id/adjust', requireSuperAdmin, wrap(async (req, res) => {
  const amount = Math.round(Number(req.body.amount_paise));
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'amount_paise must be a non-zero number' });
  const r = await billing.adjustBalance(Number(req.params.id), amount, req.body.note || null);
  res.json({ ok: true, balance: r.newBalance });
}));

// Toggle a tenant's unmetered (unlimited) flag.
apiRouter.post('/admin/tenants/:id/unlimited', requireSuperAdmin, wrap(async (req, res) => {
  await billing.setUnlimited(Number(req.params.id), Boolean(req.body.unlimited));
  res.json({ ok: true });
}));

// Set a tenant's plan (super-admin only): either a fixed number of units, or
// unmetered. { unmetered: true|false } toggles unlimited; { units: N } sets the
// wallet to N units (any whole number, default 1 for new tenants).
apiRouter.post('/admin/tenants/:id/plan', requireSuperAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const t = await getTenantById(id);
  if (!t) return res.status(404).json({ error: 'tenant not found' });
  if (typeof req.body.unmetered === 'boolean') {
    await billing.setUnlimited(id, req.body.unmetered);
    return res.json({ ok: true, unmetered: req.body.unmetered });
  }
  const units = Number(req.body.units);
  if (!Number.isInteger(units) || units < 0) {
    return res.status(400).json({ error: 'GB must be a whole number (0 or more).' });
  }
  const r = await billing.setPlanUnits(id, units);
  res.json({ ok: true, ...r });
}));

// Account settings (own login) — always available, no tenant needed.
apiRouter.post('/settings/account', wrap(async (req, res) => {
  const result = await updateAccount(req.user.email, req.body.current_password, {
    newEmail: req.body.new_email?.trim() || null,
    newPassword: req.body.new_password || null,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  setSessionCookie(res, result.email);
  res.json({ ok: true, email: result.email });
}));

// ============================================================
// Everything below requires a tenant context (tenant users always have one;
// a super admin must be impersonating a tenant).
// ============================================================
apiRouter.use(requireTenant);

const T = (req) => req.tenantId;

// Gate a feature behind Always-On (an active subscription, or a comped/unlimited
// workspace). Used for the scheduler and staff seats.
const requireAlwaysOn = wrap(async (req, res, next) => {
  if (await billing.hasAlwaysOn(T(req))) return next();
  res.status(402).json({
    error: 'This needs Always-On. Subscribe on the Billing page to unlock the daily scheduler.',
    needsAlwaysOn: true,
  });
});

// Staff seats: Always-On OR a ₹1,000+ top-up.
const requireStaffAccess = wrap(async (req, res, next) => {
  if (await billing.canUseStaff(T(req))) return next();
  res.status(402).json({
    error: 'Adding staff needs Always-On or a ₹1,000+ top-up. Enable it on the Billing page.',
    needsAlwaysOn: true,
  });
});

// ---------- overview / dashboard ----------

apiRouter.get('/overview', wrap(async (req, res) => {
  const tid = T(req);
  const { rows: [lastRun] } = await query('SELECT * FROM run_logs WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [tid]);
  const { rows: [totals] } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE youtube_video_id IS NOT NULL)::int AS uploaded,
            count(*) FILTER (WHERE status = 'error')::int AS errors,
            count(*) FILTER (WHERE status LIKE 'skipped%')::int AS skipped,
            round(avg(download_bps) FILTER (WHERE download_bps > 0))::bigint AS avg_download_bps,
            round(avg(upload_bps) FILTER (WHERE upload_bps > 0))::bigint AS avg_upload_bps
     FROM processed_recordings WHERE tenant_id = $1`,
    [tid],
  );
  const { rows: [chan] } = await query(
    `SELECT count(*) FILTER (WHERE refresh_token IS NOT NULL)::int AS connected,
            count(*)::int AS total FROM youtube_channels WHERE tenant_id = $1`,
    [tid],
  );
  const schedules = await getSchedules(tid);
  const enabled = schedules.filter((s) => s.enabled);
  let nextRun = null;
  for (const s of enabled) {
    try {
      const n = cronParser.parseExpression(s.cron_expression, { tz: s.timezone }).next().toISOString();
      if (!nextRun || n < nextRun) nextRun = n;
    } catch { /* skip invalid */ }
  }
  res.json({
    lastRun: lastRun || null,
    nextRun,
    activeSchedules: enabled.length,
    totalSchedules: schedules.length,
    connectedChannels: chan.connected,
    totalChannels: chan.total,
    avgDownloadBps: Number(totals.avg_download_bps) || 0,
    avgUploadBps: Number(totals.avg_upload_bps) || 0,
    totals,
    running: isRunning(),
  });
}));

// ---------- logs ----------

apiRouter.get('/logs', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const q = String(req.query.q || '').trim();
  const params = [T(req)];
  let where = 'p.tenant_id = $1 AND p.youtube_video_id IS NOT NULL';
  if (q) {
    params.push(`%${q}%`);
    where += ` AND (p.title ILIKE $${params.length} OR p.matched_tag ILIKE $${params.length})`;
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT p.*, c.label AS channel_label
     FROM processed_recordings p
     LEFT JOIN youtube_channels c ON c.id = p.channel_id
     WHERE ${where}
     ORDER BY coalesce(p.uploaded_at, p.discovered_at) DESC
     LIMIT $${params.length}`,
    params,
  );
  res.json(rows);
}));

// ---------- schedules ----------

function nextRunOf(s) {
  if (!s.enabled) return null;
  try {
    return cronParser.parseExpression(s.cron_expression, { tz: s.timezone }).next().toISOString();
  } catch { return null; }
}

apiRouter.get('/schedules', wrap(async (req, res) => {
  const rows = await getSchedules(T(req));
  res.json(rows.map((s) => ({ ...s, nextRun: nextRunOf(s) })));
}));

apiRouter.post('/schedules', requireOwner, requireAlwaysOn, wrap(async (req, res) => {
  const { name, cron_expression, timezone, enabled } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!cron.validate(cron_expression || '')) return res.status(400).json({ error: 'invalid cron expression' });
  await query(
    'INSERT INTO schedules (tenant_id, name, cron_expression, timezone, enabled) VALUES ($1, $2, $3, $4, $5)',
    [T(req), name.trim(), cron_expression.trim(), (timezone || 'Asia/Kolkata').trim(), enabled !== false],
  );
  await reloadSchedules();
  res.json({ ok: true });
}));

apiRouter.put('/schedules/:id', requireOwner, requireAlwaysOn, wrap(async (req, res) => {
  const { name, cron_expression, timezone, enabled } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!cron.validate(cron_expression || '')) return res.status(400).json({ error: 'invalid cron expression' });
  await query(
    'UPDATE schedules SET name = $1, cron_expression = $2, timezone = $3, enabled = $4 WHERE id = $5 AND tenant_id = $6',
    [name.trim(), cron_expression.trim(), (timezone || 'Asia/Kolkata').trim(), enabled !== false, Number(req.params.id), T(req)],
  );
  await reloadSchedules();
  res.json({ ok: true });
}));

apiRouter.post('/schedules/:id/toggle', requireOwner, requireAlwaysOn, wrap(async (req, res) => {
  await query('UPDATE schedules SET enabled = $1 WHERE id = $2 AND tenant_id = $3',
    [req.body.enabled !== false, Number(req.params.id), T(req)]);
  await reloadSchedules();
  res.json({ ok: true });
}));

apiRouter.delete('/schedules/:id', requireOwner, wrap(async (req, res) => {
  await query('DELETE FROM schedules WHERE id = $1 AND tenant_id = $2', [Number(req.params.id), T(req)]);
  await reloadSchedules();
  res.json({ ok: true });
}));

// ---------- edit an uploaded video's YouTube title/description ----------

async function channelForRecording(id, tid) {
  const { rows: [rec] } = await query(
    'SELECT * FROM processed_recordings WHERE id = $1 AND tenant_id = $2', [id, tid],
  );
  if (!rec) throw Object.assign(new Error('recording not found'), { status: 404 });
  if (!rec.youtube_video_id) throw Object.assign(new Error('this recording has no YouTube video yet'), { status: 400 });
  const channel = await getChannelById(rec.channel_id, tid);
  if (!channel?.refresh_token) throw Object.assign(new Error('the recording\'s YouTube channel is not connected'), { status: 400 });
  return { rec, channel };
}

apiRouter.get('/recordings/:id/youtube', wrap(async (req, res) => {
  const { rec, channel } = await channelForRecording(Number(req.params.id), T(req));
  const snippet = await getVideoSnippet(channel, rec.youtube_video_id);
  res.json({ title: snippet.title, description: snippet.description, privacy: snippet.privacyStatus, url: rec.youtube_url });
}));

apiRouter.post('/recordings/:id/youtube', requireOwner, wrap(async (req, res) => {
  const { rec, channel } = await channelForRecording(Number(req.params.id), T(req));
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title cannot be empty' });
  const privacy = req.body.privacy ? String(req.body.privacy) : undefined;
  if (privacy && !['public', 'unlisted', 'private'].includes(privacy)) {
    return res.status(400).json({ error: 'bad privacy (use public, unlisted or private)' });
  }
  await updateVideoSnippet(channel, rec.youtube_video_id, { title, description: req.body.description || '', privacy });
  await query('UPDATE processed_recordings SET title = $1 WHERE id = $2 AND tenant_id = $3', [title, rec.id, T(req)]);
  res.json({ ok: true });
}));

apiRouter.get('/runs', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const { rows } = await query('SELECT * FROM run_logs WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2', [T(req), limit]);
  res.json(rows);
}));

apiRouter.get('/recordings', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || '').trim();
  const where = ['p.tenant_id = $1'];
  const params = [T(req)];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(p.title ILIKE $${params.length} OR p.matched_tag ILIKE $${params.length})`);
  }
  if (status) {
    params.push(status);
    where.push(`p.status = $${params.length}`);
  }
  params.push(limit);
  const { rows } = await query(
    `SELECT p.*, c.label AS channel_label
     FROM processed_recordings p
     LEFT JOIN youtube_channels c ON c.id = p.channel_id
     WHERE ${where.join(' AND ')}
     ORDER BY coalesce(p.uploaded_at, p.discovered_at) DESC
     LIMIT $${params.length}`,
    params,
  );
  res.json(rows);
}));

apiRouter.post('/run-now', requireOwner, wrap(async (req, res) => {
  if (isRunning()) return res.status(409).json({ error: 'A run is already in progress.' });
  runPipeline(T(req), 'manual').catch((err) => logError('manual run crashed:', err));
  res.json({ started: true });
}));

// ---------- source videos (live listing) ----------

apiRouter.get('/sources', wrap(async (req, res) => {
  const tid = T(req);
  const windowDays = Math.min(Math.max(Number(req.query.days) || 30, 1), 30);
  const [zoomAccount, fathomAccount] = await Promise.all([
    zoom.getZoomAccount(tid), fathom.getFathomAccount(tid),
  ]);
  const { rows: dbRows } = await query(
    `SELECT source, source_id, status, youtube_url, youtube_video_id, source_deleted,
            lms_lesson_url, file_size_bytes
     FROM processed_recordings WHERE tenant_id = $1`,
    [tid],
  );
  const byKey = new Map(dbRows.map((r) => [`${r.source}:${r.source_id}`, r]));
  const result = { windowDays, zoom: null, fathom: null, errors: {} };

  if (zoomAccount) {
    try {
      const meetings = await zoom.listRecordings(zoomAccount, windowDays);
      result.zoom = meetings.map((m) => {
        const rec = byKey.get(`zoom:${m.uuid}`) || null;
        return {
          source_id: m.uuid,
          title: m.topic,
          recorded_at: m.start_time || null,
          duration_minutes: m.duration ?? null,
          total_bytes: (m.recording_files || []).reduce((s, f) => s + (f.file_size || 0), 0),
          has_target_view: Boolean(zoom.pickRecordingFile(m)),
          speaker_view: (() => {
            const types = (m.recording_files || []).filter((f) => f.file_type === 'MP4').map((f) => f.recording_type);
            if (types.includes('shared_screen_with_speaker_view')) return 'speaker+screen';
            if (types.includes('active_speaker')) return 'active_speaker';
            return null;
          })(),
          files: zoom.listVideoFiles(m).map((f) => ({
            id: f.id,
            recording_type: f.recording_type,
            file_size: f.file_size || 0,
            is_default: f.recording_type === 'shared_screen_with_speaker_view',
          })),
          status: rec?.status || 'not_processed',
          downloaded: Boolean(rec?.file_size_bytes) || Boolean(rec?.youtube_video_id),
          youtube_url: rec?.youtube_url || null,
          lms_lesson_url: rec?.lms_lesson_url || null,
          source_deleted: rec?.source_deleted || false,
          can_delete: Boolean(rec?.youtube_video_id) && !rec?.source_deleted,
        };
      });
    } catch (err) {
      result.errors.zoom = err.message;
    }
  }

  if (fathomAccount) {
    try {
      const meetings = await fathom.listMeetings(fathomAccount, windowDays);
      result.fathom = meetings.map((m) => {
        const rec = byKey.get(`fathom:${m.recordingId}`) || null;
        return {
          source_id: m.recordingId,
          title: m.title,
          recorded_at: m.recordedAt,
          duration_minutes: m.durationMinutes,
          status: rec?.status || 'not_processed',
          youtube_url: rec?.youtube_url || null,
          lms_lesson_url: rec?.lms_lesson_url || null,
        };
      });
    } catch (err) {
      result.errors.fathom = err.message;
    }
  }

  res.json(result);
}));

apiRouter.post('/push', wrap(async (req, res) => {
  const { source, source_id, file_id, title, video_title, description,
    channel_id, lms_course_id, lms_module_id } = req.body;
  if (!['zoom', 'fathom'].includes(source)) return res.status(400).json({ error: 'source must be zoom or fathom' });
  if (!source_id) return res.status(400).json({ error: 'source_id is required' });
  if (!channel_id && !lms_course_id) {
    return res.status(400).json({ error: 'Pick a YouTube channel and/or an LMS course to push to.' });
  }
  // Billing gate: block a NEW push when the wallet is empty (strict balance > 0),
  // unless the tenant is unlimited or still has its free first upload. The size
  // isn't known yet, so this only gates entry — an in-flight upload always finishes
  // (and may take the balance negative), deducted at runtime by actual size.
  const gate = await billing.canPush(T(req));
  if (!gate.allowed) {
    return res.status(402).json({ error: gate.reason, needTopup: true, balance: gate.balance });
  }
  const { job, duplicate } = enqueuePush({
    tenantId: T(req),
    source,
    source_id: String(source_id),
    file_id: file_id ? String(file_id) : null,
    title,
    video_title: video_title?.trim() || null,
    description: description?.trim() || null,
    channel_id: channel_id ? Number(channel_id) : null,
    lms_course_id: lms_course_id?.trim() || null,
    lms_module_id: lms_module_id?.trim() || null,
  });
  res.json({ ok: true, jobId: job.id, duplicate });
}));

apiRouter.get('/push-queue', wrap(async (req, res) => {
  res.json(getJobs(T(req)));
}));

// Pre-flight the billing gate for the uploader: the browser calls this BEFORE
// streaming a file so it can show the top-up prompt up front. Without it the
// /uploads 402 lands mid-stream, the connection resets, and the browser only
// sees a generic "network error" instead of the real "top up to continue".
apiRouter.get('/uploads/preflight', wrap(async (req, res) => {
  res.json(await billing.canPush(T(req)));
}));

// Upload a local file → YouTube (and optionally register it in the LMS by URL).
// The raw request body IS the file (content-type bypasses the JSON/urlencoded
// parsers), streamed straight to the cache dir — never buffered in memory. Then a
// background push job uploads it to YouTube; the browser polls /push-queue.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB safety cap
apiRouter.post('/uploads', wrap(async (req, res) => {
  const channelId = req.query.channel_id ? Number(req.query.channel_id) : null;
  if (!channelId) return res.status(400).json({ error: 'Pick a YouTube channel to upload into.' });
  const declared = Number(req.headers['content-length']) || 0;
  if (declared > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'File too large (max 10 GB).' });
  // Billing gate BEFORE accepting any bytes (an in-flight upload always finishes; this only gates entry).
  const gate = await billing.canPush(T(req));
  if (!gate.allowed) return res.status(402).json({ error: gate.reason, needTopup: true, balance: gate.balance });

  const id = crypto.randomUUID();
  const tempPath = ingestTempPath(id);
  const ws = fs.createWriteStream(tempPath);
  let bytes = 0;
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (c) => {
        bytes += c.length;
        if (bytes > MAX_UPLOAD_BYTES) { req.destroy(); ws.destroy(); reject(new Error('File exceeds the 10 GB limit.')); }
      });
      req.on('aborted', () => { ws.destroy(); reject(new Error('Upload aborted.')); });
      req.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      req.pipe(ws);
    });
  } catch (err) {
    fs.unlink(tempPath, () => {});
    return res.status(400).json({ error: err.message });
  }
  if (bytes === 0) { fs.unlink(tempPath, () => {}); return res.status(400).json({ error: 'No file received.' }); }

  const { job } = enqueuePush({
    tenantId: T(req),
    source: 'local',
    source_id: id,
    local_path: tempPath,
    original_filename: String(req.query.filename || 'upload.mp4').slice(0, 200),
    video_title: req.query.title ? String(req.query.title).slice(0, 200) : null,
    channel_id: channelId,
    lms_course_id: req.query.lms_course_id ? String(req.query.lms_course_id) : null,
    lms_module_id: req.query.lms_module_id ? String(req.query.lms_module_id) : null,
  });
  res.json({ ok: true, jobId: job.id, bytes });
}));

// Download a Zoom recording straight to the user's computer (FREE — not metered).
// Streams from Zoom through the app to the browser; nothing is buffered or stored.
apiRouter.get('/sources/zoom/download', wrap(async (req, res) => {
  const tid = T(req);
  const sourceId = String(req.query.source_id || '');
  const fileId = req.query.file_id ? String(req.query.file_id) : null;
  if (!sourceId) return res.status(400).json({ error: 'source_id is required' });
  const account = await zoom.getZoomAccount(tid);
  if (!account) return res.status(400).json({ error: 'Zoom is not connected.' });

  // Base recording scope (avoids the granular per-meeting 400).
  const meeting = await zoom.findMeetingInWindow(account, sourceId);
  if (!meeting) return res.status(404).json({ error: 'Recording not found on Zoom (it may have been deleted).' });
  const file = fileId ? zoom.findFile(meeting, fileId) : zoom.pickRecordingFile(meeting);
  if (!file || !file.download_url) return res.status(404).json({ error: 'No downloadable MP4 for this recording.' });

  const safeName = String(meeting.topic || 'recording').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'recording';
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.mp4"`);
  if (file.file_size) res.setHeader('Content-Length', String(file.file_size));

  const zres = await zoom.openRecordingStream(account, file.download_url);
  // Free download — audit only, never billed.
  query(`INSERT INTO download_events (tenant_id, source, user_email, bytes) VALUES ($1, 'zoom', $2, $3)`,
    [tid, req.user?.email || null, file.file_size || null]).catch(() => {});
  const stream = Readable.fromWeb(zres.body);
  stream.on('error', () => { if (!res.headersSent) res.status(502); res.destroy(); });
  req.on('close', () => stream.destroy()); // client cancelled — stop pulling from Zoom
  stream.pipe(res);
}));

apiRouter.post('/sources/zoom/delete', requireOwner, wrap(async (req, res) => {
  const tid = T(req);
  const sourceId = String(req.body.source_id || '');
  if (!sourceId) return res.status(400).json({ error: 'source_id is required' });
  const account = await zoom.getZoomAccount(tid);
  if (!account) return res.status(400).json({ error: 'Zoom is not connected.' });

  const { rows: [rec] } = await query(
    `SELECT * FROM processed_recordings WHERE tenant_id = $1 AND source = 'zoom' AND source_id = $2`,
    [tid, sourceId],
  );
  const settings = await getTenantSettings(tid);
  const mode = settings.zoom_delete_mode === 'trash' ? 'trash' : 'delete';
  if (!rec || !canDeleteZoomSource(rec, mode)) {
    return res.status(400).json({
      error: 'Blocked: this recording has no verified YouTube upload yet (or is already deleted).',
    });
  }
  await zoom.deleteMeetingRecordings(account, sourceId, mode);
  await query(
    `UPDATE processed_recordings SET status = 'deleted', source_deleted = true WHERE id = $1`, [rec.id],
  );
  log(`manual zoom delete (${mode}) for tenant ${tid}: ${rec.title}`);
  res.json({ ok: true, mode });
}));

// ---------- connections ----------

apiRouter.get('/connections', wrap(async (req, res) => {
  const tid = T(req);
  const { rows: [z] } = await query("SELECT id, account_id, client_id, status, oauth_email, (refresh_token IS NOT NULL) AS is_oauth, updated_at FROM zoom_account WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1", [tid]);
  const { rows: [f] } = await query('SELECT id, status, updated_at FROM fathom_account WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [tid]);
  const { rows: [l] } = await query('SELECT id, base_url, status, updated_at FROM lms_account WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [tid]);
  const channels = (await getChannels(tid)).map((c) => ({
    id: c.id, label: c.label, channel_id: c.channel_id, channel_handle: c.channel_handle,
    oauth_client_id: c.oauth_client_id, status: c.status, connected: Boolean(c.refresh_token),
  }));
  res.json({
    zoom: z || null,
    fathom: f ? { ...f, has_key: true } : null,
    lms: l || null,
    channels,
    youtubeReady: Boolean((await getConfigValue('youtube_client_id')) && (await getConfigValue('youtube_client_secret'))),
    zoomReady: Boolean((await getConfigValue('zoom_client_id')) && (await getConfigValue('zoom_client_secret'))),
    oauthCallbackUrl: `${config.publicUrl}/oauth/youtube/callback`,
  });
}));

apiRouter.post('/connections/zoom', requireOwner, wrap(async (req, res) => {
  const { account_id, client_id, client_secret } = req.body;
  if (!account_id || !client_id || !client_secret) {
    return res.status(400).json({ error: 'account_id, client_id and client_secret are required' });
  }
  await query('DELETE FROM zoom_account WHERE tenant_id = $1', [T(req)]);
  await query(
    `INSERT INTO zoom_account (tenant_id, account_id, client_id, client_secret, status) VALUES ($1, $2, $3, $4, 'unverified')`,
    [T(req), account_id.trim(), client_id.trim(), encrypt(client_secret.trim())],
  );
  res.json({ ok: true });
}));

apiRouter.post('/connections/zoom/test', requireOwner, wrap(async (req, res) => {
  const account = await zoom.getZoomAccount(T(req));
  if (!account) return res.status(400).json({ error: 'Save Zoom credentials first.' });
  try {
    const result = await zoom.testConnection(account);
    await query(`UPDATE zoom_account SET status = 'connected', updated_at = now() WHERE id = $1`, [account.id]);
    res.json(result);
  } catch (err) {
    await query(`UPDATE zoom_account SET status = 'error', updated_at = now() WHERE id = $1`, [account.id]);
    res.status(400).json({ error: err.message });
  }
}));

apiRouter.post('/connections/zoom/disconnect', requireOwner, wrap(async (req, res) => {
  await query('DELETE FROM zoom_account WHERE tenant_id = $1', [T(req)]);
  res.json({ ok: true });
}));

apiRouter.post('/connections/fathom', requireOwner, wrap(async (req, res) => {
  const { api_key } = req.body;
  if (!api_key) return res.status(400).json({ error: 'api_key is required' });
  await query('DELETE FROM fathom_account WHERE tenant_id = $1', [T(req)]);
  await query(`INSERT INTO fathom_account (tenant_id, api_key, status) VALUES ($1, $2, 'unverified')`, [T(req), encrypt(api_key.trim())]);
  res.json({ ok: true });
}));

apiRouter.post('/connections/fathom/test', requireOwner, wrap(async (req, res) => {
  const account = await fathom.getFathomAccount(T(req));
  if (!account) return res.status(400).json({ error: 'Save a Fathom API key first.' });
  try {
    const result = await fathom.testConnection(account);
    await query(`UPDATE fathom_account SET status = 'connected', updated_at = now() WHERE id = $1`, [account.id]);
    res.json(result);
  } catch (err) {
    await query(`UPDATE fathom_account SET status = 'error', updated_at = now() WHERE id = $1`, [account.id]);
    res.status(400).json({ error: err.message });
  }
}));

apiRouter.post('/connections/lms', requireOwner, wrap(async (req, res) => {
  const { base_url, api_key } = req.body;
  if (!base_url || !api_key) return res.status(400).json({ error: 'base_url and api_key are required' });
  await query('DELETE FROM lms_account WHERE tenant_id = $1', [T(req)]);
  await query(
    `INSERT INTO lms_account (tenant_id, base_url, api_key, status) VALUES ($1, $2, $3, 'unverified')`,
    [T(req), base_url.trim().replace(/\/+$/, ''), encrypt(api_key.trim())],
  );
  res.json({ ok: true });
}));

apiRouter.post('/connections/lms/test', requireOwner, wrap(async (req, res) => {
  const account = await lms.getLmsAccount(T(req));
  if (!account) return res.status(400).json({ error: 'Save LMS settings first.' });
  try {
    const result = await lms.testConnection(account);
    await query(`UPDATE lms_account SET status = 'connected', updated_at = now() WHERE id = $1`, [account.id]);
    res.json(result);
  } catch (err) {
    await query(`UPDATE lms_account SET status = 'error', updated_at = now() WHERE id = $1`, [account.id]);
    res.status(400).json({ error: err.message });
  }
}));

// ---------- YouTube channels ----------

apiRouter.post('/channels', requireOwner, wrap(async (req, res) => {
  const { label } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'A label is required.' });
  // Channels connect through the single platform-owned YouTube OAuth app — refuse
  // to create one the client could never connect.
  if (!(await getConfigValue('youtube_client_id')) || !(await getConfigValue('youtube_client_secret'))) {
    return res.status(400).json({ error: 'YouTube uploads are not set up on this platform yet — contact the administrator.' });
  }
  const { rows: [row] } = await query(
    `INSERT INTO youtube_channels (tenant_id, label) VALUES ($1, $2) RETURNING id`,
    [T(req), label.trim()],
  );
  res.json({ ok: true, id: row.id, connectUrl: `/oauth/youtube/start/${row.id}` });
}));

apiRouter.put('/channels/:id', requireOwner, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { label, oauth_client_id, oauth_client_secret } = req.body;
  const sets = [];
  const params = [];
  if (label) { params.push(label.trim()); sets.push(`label = $${params.length}`); }
  if (oauth_client_id) { params.push(oauth_client_id.trim()); sets.push(`oauth_client_id = $${params.length}`); }
  if (oauth_client_secret) { params.push(encrypt(oauth_client_secret.trim())); sets.push(`oauth_client_secret = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  params.push(id, T(req));
  await query(`UPDATE youtube_channels SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length}`, params);
  res.json({ ok: true });
}));

apiRouter.delete('/channels/:id', requireOwner, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const tid = T(req);
  const { rowCount } = await query('SELECT 1 FROM routing_rules WHERE channel_id = $1 AND tenant_id = $2 LIMIT 1', [id, tid]);
  if (rowCount) return res.status(409).json({ error: 'Channel is used by routing rules — delete or repoint those first.' });
  await query('UPDATE processed_recordings SET channel_id = NULL WHERE channel_id = $1 AND tenant_id = $2', [id, tid]);
  await query('DELETE FROM youtube_channels WHERE id = $1 AND tenant_id = $2', [id, tid]);
  res.json({ ok: true });
}));

// ---------- routing rules ----------

apiRouter.get('/rules', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, c.label AS channel_label, c.channel_handle
     FROM routing_rules r LEFT JOIN youtube_channels c ON c.id = r.channel_id
     WHERE r.tenant_id = $1
     ORDER BY r.priority, r.id`,
    [T(req)],
  );
  res.json(rows);
}));

const RULE_FIELDS = ['source', 'match_type', 'pattern', 'channel_id', 'playlist_name',
  'privacy', 'keep_prefix', 'lms_course_id', 'lms_module_id', 'priority', 'enabled'];

function ruleValues(body) {
  const errors = [];
  if (!body.pattern?.trim()) errors.push('pattern is required');
  if (!body.channel_id) errors.push('channel is required');
  if (body.source && !['any', 'zoom', 'fathom'].includes(body.source)) errors.push('bad source');
  if (body.match_type && !['contains', 'prefix', 'regex'].includes(body.match_type)) errors.push('bad match_type');
  if (body.privacy && !['unlisted', 'private', 'public'].includes(body.privacy)) errors.push('bad privacy');
  return {
    errors,
    values: {
      source: body.source || 'any',
      match_type: body.match_type || 'contains',
      pattern: body.pattern?.trim(),
      channel_id: Number(body.channel_id) || null,
      playlist_name: body.playlist_name?.trim() || null,
      privacy: body.privacy || 'unlisted',
      keep_prefix: body.keep_prefix !== false && body.keep_prefix !== 'false',
      lms_course_id: body.lms_course_id?.trim() || null,
      lms_module_id: body.lms_module_id?.trim() || null,
      priority: Number(body.priority) || 100,
      enabled: body.enabled !== false && body.enabled !== 'false',
    },
  };
}

apiRouter.post('/rules', requireOwner, wrap(async (req, res) => {
  const { errors, values } = ruleValues(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const cols = ['tenant_id', ...RULE_FIELDS].join(', ');
  const placeholders = ['tenant_id', ...RULE_FIELDS].map((_, i) => `$${i + 1}`).join(', ');
  const { rows: [row] } = await query(
    `INSERT INTO routing_rules (${cols}) VALUES (${placeholders}) RETURNING id`,
    [T(req), ...RULE_FIELDS.map((f) => values[f])],
  );
  res.json({ ok: true, id: row.id });
}));

apiRouter.put('/rules/:id', requireOwner, wrap(async (req, res) => {
  const { errors, values } = ruleValues(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const sets = RULE_FIELDS.map((f, i) => `${f} = $${i + 1}`).join(', ');
  await query(
    `UPDATE routing_rules SET ${sets} WHERE id = $${RULE_FIELDS.length + 1} AND tenant_id = $${RULE_FIELDS.length + 2}`,
    [...RULE_FIELDS.map((f) => values[f]), Number(req.params.id), T(req)],
  );
  res.json({ ok: true });
}));

apiRouter.delete('/rules/:id', requireOwner, wrap(async (req, res) => {
  await query('DELETE FROM routing_rules WHERE id = $1 AND tenant_id = $2', [Number(req.params.id), T(req)]);
  res.json({ ok: true });
}));

// ---------- settings (per-tenant) ----------

const SETTING_KEYS = ['rolling_window_days', 'zoom_delete_mode', 'email_to', 'email_from', 'gstin', 'gst_business_name'];

apiRouter.get('/settings', wrap(async (req, res) => {
  const s = await getTenantSettings(T(req));
  res.json({
    ...Object.fromEntries(SETTING_KEYS.map((k) => [k, s[k] ?? ''])),
    gmail_app_password_set: Boolean(s.gmail_app_password),
  });
}));

apiRouter.post('/settings', requireOwner, wrap(async (req, res) => {
  const body = req.body;
  const tid = T(req);
  if (body.zoom_delete_mode && !['off', 'trash', 'delete'].includes(body.zoom_delete_mode)) {
    return res.status(400).json({ error: 'zoom_delete_mode must be off, trash or delete.' });
  }
  if (body.rolling_window_days && !(Number(body.rolling_window_days) >= 1)) {
    return res.status(400).json({ error: 'rolling_window_days must be >= 1.' });
  }
  // GSTIN is optional; if given, normalise (no spaces, uppercase) and sanity-check the 15-char format.
  if (body.gstin !== undefined) {
    const g = String(body.gstin).replace(/\s+/g, '').toUpperCase();
    if (g && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) {
      return res.status(400).json({ error: 'That does not look like a valid 15-character GSTIN. Leave it blank if you do not have one.' });
    }
    body.gstin = g;
  }
  for (const key of SETTING_KEYS) {
    if (body[key] !== undefined) await setTenantSetting(tid, key, String(body[key]).trim());
  }
  if (body.gmail_app_password) {
    await setTenantSetting(tid, 'gmail_app_password', encrypt(String(body.gmail_app_password).trim()));
  }
  res.json({ ok: true });
}));

// ---------- staff (tenant owner provisions staff) ----------

apiRouter.get('/staff', requireOwner, wrap(async (req, res) => {
  res.json(await listTenantUsers(T(req)));
}));

apiRouter.post('/staff', requireOwner, requireStaffAccess, wrap(async (req, res) => {
  const result = await createStaff(T(req), {
    email: req.body.email, name: req.body.name, permission: req.body.permission,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, id: result.id });
}));

apiRouter.put('/staff/:id', requireOwner, wrap(async (req, res) => {
  const result = await updateStaff(T(req), Number(req.params.id), {
    name: req.body.name, permission: req.body.permission,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
}));

apiRouter.post('/staff/:id/reset', requireOwner, wrap(async (req, res) => {
  const result = await resetStaffPassword(T(req), Number(req.params.id));
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
}));

apiRouter.delete('/staff/:id', requireOwner, wrap(async (req, res) => {
  const result = await deleteStaff(T(req), Number(req.params.id));
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
}));

// ---------- billing / wallet (tenant) ----------

// Wallet snapshot + pricing, for the Billing page.
apiRouter.get('/billing', wrap(async (req, res) => {
  const w = await billing.getWallet(T(req));
  const c = await billing.getBillingConfig();
  const s = await getTenantSettings(T(req));
  const razorpayReady = Boolean(c.razorpayKeyId && c.razorpayKeySecret);
  const paymentsEnabled = billing.LIVE_PROVIDERS.includes(c.provider)
    && (c.provider !== 'razorpay' || razorpayReady);
  res.json({
    balance_paise: Number(w?.balance_paise || 0),
    unlimited: Boolean(w?.unlimited),
    free_upload_used: Boolean(w?.free_upload_used),
    units: billing.unitsBalance(w, c),      // effective unit balance (null = unmetered)
    usedUnits: await billing.usedUnits(T(req)),
    pricePerUnitPaise: c.pricePerUnitPaise,
    unitBytes: c.unitBytes,
    gstPercent: c.gstPercent,
    gatewayPercent: c.gatewayPercent,
    minTopupPaise: c.minTopupPaise,
    // Descending pack pricing — computed server-side so the modal (and landing)
    // render identical numbers from one source.
    unitsStep: billing.UNITS_STEP,
    packTiers: billing.PACK_TIERS,
    packs: billing.PACK_PRESETS.map((u) => billing.packQuote(u, c)),
    // Always-On subscription (features tier).
    alwaysOn: billing.isAlwaysOn(w),
    alwaysOnUntil: w?.always_on_until || null,
    subscriptionStatus: w?.subscription_status || null,
    alwaysOnPricePaise: c.alwaysOnPricePaise,
    alwaysOnAvailable: paymentsEnabled, // the ₹999 plan auto-provisions on first subscribe
    provider: c.provider,
    paymentsEnabled,
    razorpayConfigured: razorpayReady,
    // Saved GST details (prefill the modal) + the customer email for the Checkout receipt.
    gstin: s.gstin || '',
    gst_business_name: s.gst_business_name || '',
    email: req.user?.email || '',
  });
}));

apiRouter.get('/billing/history', wrap(async (req, res) => {
  res.json(await billing.history(T(req)));
}));

// Preview a pack quote (credit + charge base + GST + gateway) without creating an order.
apiRouter.get('/billing/quote', wrap(async (req, res) => {
  const c = await billing.getBillingConfig();
  const v = billing.validateUnits(Number(req.query.units));
  if (!v.ok) return res.status(400).json({ error: v.error });
  res.json(billing.packQuote(v.units, c));
}));

// Create a Razorpay order for a wallet top-up (owner only).
apiRouter.post('/billing/topup', requireOwner, wrap(async (req, res) => {
  try {
    const s = await getTenantSettings(T(req));
    // GSTIN from the modal wins; else fall back to the saved setting. Optional either way.
    const gstin = String(req.body.gstin ?? s.gstin ?? '').replace(/\s+/g, '').toUpperCase();
    const out = await billing.createTopup(T(req), Number(req.body.units), {
      gstin,
      businessName: s.gst_business_name || '',
      email: req.user?.email || '',
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Confirm an in-page Checkout success (verifies signature, credits wallet).
apiRouter.post('/billing/confirm', requireOwner, wrap(async (req, res) => {
  try {
    const r = await billing.confirmCheckout(req.body.order_id, req.body.payment_id, req.body.signature);
    if (r.ok && !r.already) {
      const { rows } = await query('SELECT total_paise FROM payments WHERE provider_order_id = $1', [req.body.order_id]);
      meta.firePurchase(req, { email: req.user?.email, valuePaise: rows[0]?.total_paise }).catch(() => {});
    }
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// --- Always-On subscription (owner only) ---
apiRouter.post('/billing/subscribe', requireOwner, wrap(async (req, res) => {
  try {
    const out = await billing.startSubscription(T(req), { email: req.user?.email });
    res.json({ ok: true, ...out });
  } catch (err) { res.status(400).json({ error: err.message }); }
}));

apiRouter.post('/billing/subscription/confirm', requireOwner, wrap(async (req, res) => {
  try {
    const r = await billing.confirmSubscription(
      T(req), req.body.subscription_id, req.body.payment_id, req.body.signature);
    if (r.ok) {
      const c = await billing.getBillingConfig();
      meta.firePurchase(req, { email: req.user?.email, valuePaise: c.alwaysOnPricePaise }).catch(() => {});
    }
    res.json({ ok: true, ...r });
  } catch (err) { res.status(400).json({ error: err.message }); }
}));

apiRouter.post('/billing/subscription/cancel', requireOwner, wrap(async (req, res) => {
  try {
    res.json({ ok: true, ...await billing.cancelAlwaysOn(T(req)) });
  } catch (err) { res.status(400).json({ error: err.message }); }
}));
