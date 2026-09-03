import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  requirePageAuth, requireSessionOnly, authenticate, setOwnPassword,
  setSessionCookie, clearSessionCookie, resetPassword, resetEnabled,
  resolveTenant, requireTenant, requireSuperAdmin, getOptionalUser,
  recordLogin, SESSION_COOKIE_NAME, createTenantOwner, hashPassword,
  createPasswordReset, resetTokenValid, consumePasswordReset,
} from './auth.js';
import crypto from 'node:crypto';
import { sendPlatformMail } from '../lib/mailer.js';
import { trackMiddleware, recordBeacon } from './track.js';
import * as meta from '../lib/meta.js';
import { apiRouter } from './routes/api.js';
import { oauthRouter } from './routes/oauth.js';
import { dbadminRouter } from './routes/dbadmin.js';
import * as billing from '../billing.js';
import { getConfigValue } from '../db.js';
import { LEGAL, LEGAL_ORDER, LAST_UPDATED } from './content/legal.js';
import { KB_TOPICS } from './content/kb.js';

const LEGAL_LABELS = { privacy: 'Privacy', terms: 'Terms', refund: 'Refund', shipping: 'Shipping', contact: 'Contact us' };
const LEGAL_LINKS = LEGAL_ORDER.map((slug) => ({ href: `/${slug}`, label: LEGAL_LABELS[slug] }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer() {
  const app = express();
  // Behind Railway/Cloudflare — trust the proxy so req.ip and req.secure reflect
  // the real client and X-Forwarded-* headers.
  app.set('trust proxy', true);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use('/public', express.static(path.join(__dirname, 'public')));
  // Capture the raw body so the Razorpay webhook can verify its HMAC signature.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // Visitor & traffic capture (anonymous public pages only; logged-in users skipped).
  app.use(trackMiddleware(SESSION_COOKIE_NAME));

  // Meta Pixel <head> snippet for anonymous public pages (PageView + retargeting).
  // res.locals.pixelHead is always defined ('' when off), so templates can use it safely.
  app.use(async (req, res, next) => {
    res.locals.pixelHead = '';
    if (req.method === 'GET' && !req.cookies?.[SESSION_COOKIE_NAME]
      && !req.path.startsWith('/api') && !req.path.startsWith('/public') && !req.path.startsWith('/oauth')
      && !req.path.startsWith('/dbadmin')) {
      try { res.locals.pixelHead = meta.pixelHeadHtml(await meta.getCachedPixelId()); } catch { /* best-effort */ }
    }
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Self-service DB backup/restore (gated by PASSWORD_RESET_KEY).
  app.use('/dbadmin', dbadminRouter);

  app.get('/login', (req, res) => res.render('login', { error: null, resetEnabled: resetEnabled(), reset: req.query.reset }));
  app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const result = await authenticate(email, password);
    if (result.ok) {
      setSessionCookie(res, result.email);
      recordLogin(result.email, req.ip); // fire-and-forget; records last/previous login
      return res.redirect(result.mustSetPassword ? '/set-password' : '/');
    }
    res.status(401).render('login', { error: 'Invalid email or password.', resetEnabled: resetEnabled() });
  });

  // First-login / forced password set. Requires a valid session; tolerant of the
  // must-change flag (that's exactly who lands here).
  app.get('/set-password', requireSessionOnly, (req, res) =>
    res.render('set-password', { error: null, email: req.user.email }));
  app.post('/set-password', requireSessionOnly, async (req, res) => {
    const result = await setOwnPassword(req.user.email, req.body.new_password);
    if (!result.ok) {
      return res.status(400).render('set-password', { error: result.error, email: req.user.email });
    }
    res.redirect('/runs');
  });

  // Public self-serve signup — creates a new workspace (tenant + owner + wallet),
  // logs in, and fires the Lead / CompleteRegistration conversions (pixel + CAPI).
  app.get('/register', async (req, res, next) => {
    try {
      const user = await getOptionalUser(req);
      if (user) return res.redirect(user.isSuperAdmin ? '/admin' : '/runs');
      const googleEnabled = Boolean(await getConfigValue('google_client_id'));
      res.render('register', { error: req.query.err ? String(req.query.err).slice(0, 200) : null, values: {}, googleEnabled, eventId: crypto.randomUUID() });
    } catch (err) { next(err); }
  });
  app.post('/register', async (req, res, next) => {
    try {
      const { email, name, workspace, password, event_id } = req.body;
      const googleEnabled = Boolean(await getConfigValue('google_client_id'));
      const rerender = (error) => res.status(400).render('register',
        { error, values: { email, name, workspace }, googleEnabled, eventId: event_id || crypto.randomUUID() });
      if (!password || String(password).length < 8) return rerender('Choose a password of at least 8 characters.');
      const result = await createTenantOwner({ email, name, workspaceName: workspace, passwordHash: await hashPassword(password) });
      if (!result.ok) return rerender(result.error);
      setSessionCookie(res, result.email);
      recordLogin(result.email, req.ip);
      meta.fireSignupConversions(req, { email: result.email, name, eventId: event_id,
        sourceUrl: `${req.protocol}://${req.get('host')}/register` }).catch(() => {});
      res.redirect('/runs');
    } catch (err) { next(err); }
  });

  // Self-serve forgot password — emails a single-use reset link (needs platform email configured).
  app.get('/forgot', (_req, res) => res.render('forgot', { sent: false, error: null }));
  app.post('/forgot', async (req, res, next) => {
    try {
      const r = await createPasswordReset(req.body.email);
      if (r.sent) {
        const link = `${req.protocol}://${req.get('host')}/reset-password?token=${r.token}`;
        sendPlatformMail(r.email, 'Reset your AVideoRouter password',
          `Hi ${r.name || ''},\n\nReset your AVideoRouter password with this link (valid 1 hour):\n${link}\n\nIf you didn't request this, you can ignore this email.`,
          `<p>Hi ${r.name || ''},</p><p>Reset your AVideoRouter password with this link (valid for 1 hour):</p>`
          + `<p><a href="${link}">${link}</a></p><p>If you didn't request this, you can ignore this email.</p>`)
          .catch((e) => console.error('reset email failed:', e.message));
      }
      // Generic response either way — never reveal whether the email exists.
      res.render('forgot', { sent: true, error: null });
    } catch (err) { next(err); }
  });
  app.get('/reset-password', async (req, res, next) => {
    try {
      const valid = await resetTokenValid(req.query.token);
      res.render('reset-password', { token: String(req.query.token || ''), valid, error: null });
    } catch (err) { next(err); }
  });
  app.post('/reset-password', async (req, res, next) => {
    try {
      const r = await consumePasswordReset(req.body.token, req.body.password);
      if (!r.ok) return res.status(400).render('reset-password', { token: String(req.body.token || ''), valid: true, error: r.error });
      res.redirect('/login?reset=1');
    } catch (err) { next(err); }
  });

  app.get('/reset', (_req, res) => res.render('reset', { error: null, ok: null, enabled: resetEnabled() }));
  app.post('/reset', async (req, res) => {
    const { email, key, new_password } = req.body;
    const result = await resetPassword(email, key, new_password);
    if (!result.ok) {
      return res.status(400).render('reset', { error: result.error, ok: null, enabled: resetEnabled() });
    }
    res.render('reset', { error: null, ok: `Password reset for ${result.email}. You can now log in.`, enabled: resetEnabled() });
  });
  app.post('/logout', (_req, res) => {
    clearSessionCookie(res);
    res.redirect('/login');
  });

  // Public marketing landing page at the root. Logged-in users are sent into the
  // app; visitors see the sales page. The hero video URL is pulled live from
  // app_config (landing_video_url) so it can be swapped without touching the page.
  app.get('/', async (req, res, next) => {
    try {
      // A DB blip must never take down the public marketing page. Treat a failed
      // session lookup as anonymous, and fall back to default pricing config so
      // the page always renders (visitors get the landing, never a 500).
      let user = null;
      try { user = await getOptionalUser(req); } catch { /* DB hiccup — show landing */ }
      if (user) return res.redirect(user.isSuperAdmin ? '/admin' : '/runs');
      let videoUrl = '';
      let cfg;
      try {
        videoUrl = (await getConfigValue('landing_video_url')) || '';
        // Pricing is rendered from the live billing config so the landing and the
        // in-app top-up modal always show the same numbers (one source of truth).
        cfg = await billing.getBillingConfig();
      } catch (e) {
        console.error(new Date().toISOString(), 'WARN landing: config read failed, using defaults:', e.message);
        cfg = billing.defaultBillingConfig();
      }
      const packs = billing.PACK_PRESETS.map((u) => billing.packQuote(u, cfg));
      res.render('landing', { videoUrl, packs, alwaysOnPricePaise: cfg.alwaysOnPricePaise });
    } catch (err) { next(err); }
  });

  // Public policy pages (privacy / terms / refund / shipping / contact), linked in the
  // footer and required by the payment gateway. No auth — visible to visitors and users alike.
  for (const slug of LEGAL_ORDER) {
    app.get(`/${slug}`, (_req, res) => {
      const doc = LEGAL[slug];
      res.render('legal', { title: doc.title, bodyHtml: doc.html, lastUpdated: LAST_UPDATED, links: LEGAL_LINKS });
    });
  }

  // Public visitor beacon (no auth — anonymous public pages POST here). Confirms
  // the visitor as human and attaches client-only details. Always 204s quickly.
  app.post('/api/track', async (req, res) => {
    try { await recordBeacon(req); } catch (err) { console.error('beacon:', err.message); }
    res.status(204).end();
  });

  // Public FAQ (anonymous) — curated Q&A for visitors, linked from the landing footer.
  app.get('/faq', (_req, res) => res.render('faq'));

  // Public Knowledge Base (anonymous, crawlable) — pain-point/solution pages for
  // prospects and AI search. Distinct from the in-app Help center. Index + one
  // page per topic; /knowledge-base/:slug falls through to 404 for unknown slugs.
  app.get('/knowledge-base', (_req, res) => res.render('kb-index', { topics: KB_TOPICS }));
  app.get('/knowledge-base/:slug', (req, res, next) => {
    const i = KB_TOPICS.findIndex((t) => t.slug === req.params.slug);
    if (i < 0) return next();
    res.render('kb-topic', {
      topic: KB_TOPICS[i],
      prev: i > 0 ? KB_TOPICS[i - 1] : null,
      next: i < KB_TOPICS.length - 1 ? KB_TOPICS[i + 1] : null,
      index: i,
      total: KB_TOPICS.length,
    });
  });

  // Crawlability: allow bots on public pages, keep them off the auth-walled app,
  // and advertise the sitemap. Base URL is taken from the request so it matches
  // whichever host is being crawled.
  const PUBLIC_PATHS = ['/', '/faq', '/knowledge-base', '/privacy', '/terms', '/refund', '/shipping', '/contact'];
  const KB_PATHS = KB_TOPICS.map((t) => `/knowledge-base/${t.slug}`);
  const PRIVATE_PATHS = ['/api/', '/oauth/', '/dbadmin', '/admin', '/login', '/reset', '/set-password',
    '/runs', '/sources', '/logs', '/connections', '/routing', '/schedules', '/team', '/billing',
    '/settings', '/help', '/visitors', '/traffic'];
  const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

  app.get('/robots.txt', (req, res) => {
    const lines = ['User-agent: *', 'Allow: /$',
      ...PRIVATE_PATHS.map((p) => `Disallow: ${p}`),
      '', `Sitemap: ${baseUrl(req)}/sitemap.xml`];
    res.type('text/plain').send(lines.join('\n') + '\n');
  });

  app.get('/sitemap.xml', (req, res) => {
    const base = baseUrl(req);
    const today = new Date().toISOString().slice(0, 10);
    const urls = [...PUBLIC_PATHS, ...KB_PATHS].map((p) =>
      `  <url><loc>${base}${p}</loc><lastmod>${today}</lastmod></url>`).join('\n');
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  // Google Search Console site-ownership verification (served at the site root).
  app.get('/google348efcdf34bc741b.html', (_req, res) =>
    res.type('text/html').send('google-site-verification: google348efcdf34bc741b.html\n'));

  // llms.txt — a concise, LLM-friendly map of the site's key pages (emerging
  // convention that AI answer engines look for). Built from the live host.
  app.get('/llms.txt', (req, res) => {
    const base = baseUrl(req);
    const lines = [
      '# AVideoRouter',
      '',
      '> AVideoRouter automatically moves Zoom and Fathom recordings to YouTube and your LMS —',
      '> downloading, uploading, organizing into courses, and optionally deleting the Zoom original —',
      '> on a schedule, hands-free. Subscription-free, pay-as-you-go (₹50 per GB of transfer).',
      '',
      '## Start here',
      `- [Home](${base}/): what it does, pricing, and how it works`,
      `- [FAQ](${base}/faq): common questions before signing up`,
      `- [Knowledge Base](${base}/knowledge-base): the pain points it solves and how`,
      '',
      '## Knowledge Base topics',
      ...KB_TOPICS.map((t) => `- [${t.title}](${base}/knowledge-base/${t.slug}): ${t.teaser}`),
      '',
      '## Policies',
      `- [Privacy](${base}/privacy)`,
      `- [Terms](${base}/terms)`,
      `- [Refund](${base}/refund)`,
      '',
      'Contact: connect@divineleads.guru',
      '',
    ];
    res.type('text/plain').send(lines.join('\n'));
  });

  // Super-admin console: all tenants + impersonation.
  app.get('/admin', requirePageAuth, resolveTenant, requireSuperAdmin,
    (req, res) => res.render('admin', { page: 'admin', title: 'Admin', user: req.user }));

  // Super-admin analytics (global, no tenant context): Visitors + Traffic.
  for (const [route, title] of Object.entries({ visitors: 'Visitors', traffic: 'Traffic' })) {
    app.get(`/${route}`, requirePageAuth, resolveTenant, requireSuperAdmin,
      (req, res) => res.render(route, { page: route, title, user: req.user }));
  }

  const pages = { connections: 'Connections', routing: 'Routing', runs: 'Runs', sources: 'Sources', logs: 'Logs', schedules: 'Schedules', team: 'Team', billing: 'Billing', settings: 'Settings', help: 'Help' };
  for (const [route, title] of Object.entries(pages)) {
    app.get(`/${route}`, requirePageAuth, resolveTenant, requireTenant,
      (req, res) => res.render(route, { page: route, title, user: req.user }));
  }

  // Razorpay webhook — unauthenticated (Razorpay posts here), verified by HMAC
  // signature over the raw body. Mounted before the auth-gated /api router.
  app.post('/api/billing/webhook', async (req, res) => {
    try {
      const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
      const out = await billing.handleWebhook(raw, req.headers['x-razorpay-signature']);
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.use('/api', apiRouter);
  app.use('/oauth', oauthRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(new Date().toISOString(), 'ERROR web:', err);
    res.status(err.status || 500).json({ error: err.message || 'internal error' });
  });

  return app;
}
